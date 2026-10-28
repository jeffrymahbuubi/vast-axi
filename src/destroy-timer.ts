// Server-side destroy timers for `rent --max-hours`: a vast.ai scheduled job
// that DELETEs the instance. Facts verified live on 2026-10-21 (trust these):
//  - frequency HOURLY ignores start_time: a job with start_time 09:50 fired at
//    08:00:10 UTC, the first :00 after creation (docs/handoff/bug-max-hours-fires-early.md).
//  - frequency DAILY with hour_of_the_day=H (UTC, 0-23) and day_of_the_week null
//    fires only at H:00 UTC; it did not fire at any earlier :00.
//  - only ONE job per (instance_id, api_endpoint, request_method) can exist; a
//    second POST answers HTTP 422 `job_exists`, so there is no second retry job.
//  - a fired job stays listed (last_executed_around set, status IN-PROGRESS)
//    until deleted, and a DAILY job repeats 24 h later: that is the only retry.
// So the timer is a DAILY job at the planned destroy hour, created within 24 h
// before it: the next H:00 after creation is exactly the planned destroy time.
// Listing and deleting go through the `vastai` CLI (it knows HOURLY, DAILY and
// WEEKLY only); only creating needs the REST API (src/vast-rest.ts).
import { AxiError, parseError } from "./errors.js";
import { round } from "./format.js";
import { restPost, RestError, scrubSecrets } from "./vast-rest.js";
import { vastExec, vastJson } from "./vastai.js";

const HOUR_S = 3600;
const DAY_S = 24 * HOUR_S;

/** Unix seconds now; `VAST_AXI_NOW` (unix seconds) overrides it for tests. The only clock read here. */
export function nowSec(): number {
  const fromEnv = Number(process.env["VAST_AXI_NOW"]);
  return process.env["VAST_AXI_NOW"] && Number.isFinite(fromEnv)
    ? fromEnv
    : Date.now() / 1000;
}

export interface DestroyPlan {
  /** Unix seconds (a whole :00 UTC hour) at which the instance is destroyed. */
  destroyAt: number;
  /** Hours from `now` until `destroyAt`, 1 decimal. */
  runsForH: number;
  /** The scheduled job's `hour_of_the_day`: the UTC hour of `destroyAt`. */
  hour: number;
  /** Scheduled-job window, integer unix seconds: [now, destroyAt + 1 day + 1 h] (one 24 h retry). */
  startTime: number;
  endTime: number;
}

/**
 * `destroyAt = floor_to_hour_utc(now + maxHours*3600)`: rounding down means
 * the rental can never run longer than `maxHours`. For 0 < maxHours < 24 the
 * next `hour`:00 UTC after `now` is exactly `destroyAt`.
 */
export function planDestroy(now: number, maxHours: number): DestroyPlan {
  const destroyAt = Math.floor((now + maxHours * HOUR_S) / HOUR_S) * HOUR_S;
  return {
    destroyAt,
    runsForH: round((destroyAt - now) / HOUR_S, 1),
    hour: new Date(destroyAt * 1000).getUTCHours(),
    startTime: Math.floor(now),
    endTime: destroyAt + DAY_S + HOUR_S,
  };
}

/** `2026-10-21T04:00Z`: ISO UTC, minute precision. */
export function isoMinute(unixSeconds: number): string {
  return `${new Date(unixSeconds * 1000).toISOString().slice(0, 16)}Z`;
}

export interface ScheduledJob {
  id?: number;
  api_endpoint?: string;
  request_method?: string;
  instance_id?: number | null;
  start_time?: number;
  end_time?: number;
  frequency?: string | null;
  hour_of_the_day?: number | null;
  last_executed_around?: number | null;
  status?: string | null;
}

const endpointFor = (id: number): string => `/api/v0/instances/${id}/`;

/**
 * The instance a scheduled job would destroy, or undefined if the job is not a
 * destroy timer (a DELETE on exactly that instance's endpoint). The frequency
 * does not matter, so DAILY timers and legacy HOURLY ones are both found.
 */
export function destroyTarget(job: ScheduledJob): number | undefined {
  const id = job.instance_id;
  if (typeof id !== "number" || !Number.isInteger(id)) return undefined;
  return job.request_method === "DELETE" && job.api_endpoint === endpointFor(id)
    ? id
    : undefined;
}

export interface JobFire {
  /** Unix seconds of the job's next firing. */
  at: number;
  /** A v0.1.4-v0.1.6 HOURLY timer: vast.ai fires it at the next :00, not at its planned time. */
  legacy: boolean;
}

const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

/** The first `hour`:00 UTC at or after `from` (unix seconds). */
function nextHourOfDay(from: number, hour: number): number {
  const t = Math.floor(from / DAY_S) * DAY_S + hour * HOUR_S;
  return t < from ? t + DAY_S : t;
}

/**
 * When a destroy timer fires next.
 *  - DAILY at hour H: the first H:00 UTC at or after start_time (or, once it
 *    has fired, after last_executed_around: the 24 h retry).
 *  - HOURLY (legacy): vast.ai ignores start_time, so it fires at the next :00
 *    counted from `now`; flagged `legacy` because that is usually far too early.
 *  - anything else: the first :00 at or after start_time.
 */
export function jobFire(
  job: ScheduledJob,
  now: number = nowSec(),
): JobFire | undefined {
  const start = job.start_time;
  const freq =
    typeof job.frequency === "string" ? job.frequency.toUpperCase() : "";
  if (freq === "HOURLY") {
    return { at: Math.ceil(now / HOUR_S) * HOUR_S, legacy: true };
  }
  if (!finite(start)) return undefined;
  if (freq === "DAILY") {
    const hour = job.hour_of_the_day;
    if (typeof hour !== "number" || !Number.isInteger(hour)) return undefined;
    if (hour < 0 || hour > 23) return undefined;
    const last = job.last_executed_around;
    const from = finite(last) ? Math.max(start, last + 1) : start;
    return { at: nextHourOfDay(from, hour), legacy: false };
  }
  return { at: Math.ceil(start / HOUR_S) * HOUR_S, legacy: false };
}

/** The unix time a destroy timer fires next (see `jobFire`). */
export function jobDestroyAt(
  job: ScheduledJob,
  now: number = nowSec(),
): number | undefined {
  return jobFire(job, now)?.at;
}

export interface TimerSummary {
  /** Earliest firing of any timer on the instance, ISO minute. */
  destroyAt: string;
  /** Legacy HOURLY timers (dangerous: they fire at the next :00), earliest first. */
  legacy: Array<{ jobId: number | undefined; at: string }>;
}

/** The destroy timers of `instanceId` in a job list, or undefined when none has a known time. */
export function timerSummaryFor(
  jobs: ScheduledJob[],
  instanceId: number,
  now: number = nowSec(),
): TimerSummary | undefined {
  const fires: Array<{ id: number | undefined; fire: JobFire }> = [];
  for (const j of jobs) {
    if (destroyTarget(j) !== instanceId) continue;
    const fire = jobFire(j, now);
    if (fire)
      fires.push({ id: typeof j.id === "number" ? j.id : undefined, fire });
  }
  if (fires.length === 0) return undefined;
  fires.sort((a, b) => a.fire.at - b.fire.at);
  return {
    destroyAt: isoMinute(fires[0]!.fire.at),
    legacy: fires
      .filter((f) => f.fire.legacy)
      .map((f) => ({ jobId: f.id, at: isoMinute(f.fire.at) })),
  };
}

/** The `destroy_timer` status field for legacy HOURLY timers, and one help line per such job. */
export function legacyTimerNotice(
  instanceId: number,
  legacy: TimerSummary["legacy"],
): { field: string; help: string[] } {
  return {
    field: `legacy HOURLY, fires at the next :00 (${legacy[0]!.at})`,
    help: legacy.map((l) => {
      const job = l.jobId ?? "<id>";
      return `Legacy destroy timer job ${job} will destroy #${instanceId} at ${l.at}, the next :00, not at its planned time. Delete it now: \`vast-axi raw delete scheduled-job ${job}\`; it cannot be re-armed, so end the run with \`vast-axi finish ${instanceId} --wait --fetch <remote>:<local> --destroy\``;
    }),
  };
}

/**
 * Create the scheduled destroy for `instanceId` (REST) and return the scheduled
 * job id. A DAILY job at the plan's UTC hour; see the header for why. Throws RestError.
 */
export async function createDestroyTimer(
  instanceId: number,
  plan: DestroyPlan,
  apiKey: string,
): Promise<number> {
  let json: unknown;
  try {
    ({ json } = await restPost(
      "/api/v0/commands/schedule_job/",
      {
        start_time: plan.startTime,
        end_time: plan.endTime,
        api_endpoint: endpointFor(instanceId),
        request_method: "DELETE",
        request_body: {},
        day_of_the_week: null,
        hour_of_the_day: plan.hour,
        frequency: "DAILY",
        instance_id: instanceId,
      },
      apiKey,
    ));
  } catch (error) {
    // vast.ai allows one job per instance and method: say so instead of a bare 422.
    if (
      error instanceof RestError &&
      (error.status === 422 || /job_exists/i.test(error.message))
    ) {
      throw new RestError(
        scrubSecrets(
          `a destroy timer already exists for instance ${instanceId} (job_exists; ${error.message})`,
          apiKey,
        ),
        error.status,
      );
    }
    throw error;
  }
  const o =
    json && typeof json === "object" && !Array.isArray(json)
      ? (json as Record<string, unknown>)
      : {};
  const jobId = o["scheduled_job_id"];
  if (o["success"] !== true) {
    const msg = typeof o["msg"] === "string" ? `: ${o["msg"]}` : "";
    throw new RestError(
      scrubSecrets(
        `vast.ai API did not accept the scheduled job (success is not true)${msg}`.slice(
          0,
          300,
        ),
        apiKey,
      ),
    );
  }
  if (typeof jobId !== "number" || !Number.isInteger(jobId)) {
    throw new RestError(
      "vast.ai API accepted the scheduled job but returned no integer scheduled_job_id",
    );
  }
  return jobId;
}

/** All scheduled jobs on the account (`show scheduled-jobs`). Throws on a failed or oddly shaped answer. */
export async function listScheduledJobs(): Promise<ScheduledJob[]> {
  const body = await vastJson<unknown>(["show", "scheduled-jobs"]);
  if (!Array.isArray(body)) throw parseError(JSON.stringify(body) ?? "");
  return body.filter(
    (j): j is ScheduledJob => typeof j === "object" && j !== null,
  );
}

/**
 * `vastai delete scheduled-job <id>` prints a Python repr even under --raw:
 * `{'success': True, 'msg': '...'}`. Only `'success': True` counts; a JSON
 * `"success": true` is accepted too.
 */
export async function deleteScheduledJob(jobId: number): Promise<void> {
  const out = await vastExec(["delete", "scheduled-job", String(jobId)]);
  if (!/["']success["']\s*:\s*true/i.test(out)) {
    throw new AxiError(
      `vast.ai did not confirm deleting scheduled job ${jobId}: ${out.trim().slice(0, 120) || "no output"}`,
      "UPSTREAM_ERROR",
    );
  }
}

/**
 * Read the job back (OQ42): it must be listed, DAILY at the planned hour, a
 * DELETE on this instance's endpoint. Throws a RestError saying what is off; the
 * caller rolls back. A job that is listed but wrong is deleted here (best effort).
 */
export async function verifyDestroyTimer(
  jobId: number,
  instanceId: number,
  plan: DestroyPlan,
): Promise<void> {
  let jobs: ScheduledJob[];
  try {
    jobs = await listScheduledJobs();
  } catch (error) {
    await deleteScheduledJob(jobId).catch(() => undefined);
    const why = error instanceof Error ? error.message : String(error);
    throw new RestError(
      `could not read scheduled job ${jobId} back to verify it (${why.slice(0, 120)})`,
    );
  }
  const job = jobs.find((j) => j.id === jobId);
  if (!job) {
    throw new RestError(
      `scheduled job ${jobId} was accepted but is not in \`show scheduled-jobs\``,
    );
  }
  const problems: string[] = [];
  if (job.frequency !== "DAILY") {
    problems.push(`frequency ${String(job.frequency)} instead of DAILY`);
  }
  if (job.hour_of_the_day !== plan.hour) {
    problems.push(
      `hour_of_the_day ${String(job.hour_of_the_day)} instead of ${plan.hour}`,
    );
  }
  if (job.request_method !== "DELETE") {
    problems.push(`method ${String(job.request_method)} instead of DELETE`);
  }
  if (destroyTarget(job) !== instanceId) {
    problems.push(`it does not target instance ${instanceId}`);
  }
  if (problems.length > 0) {
    await deleteScheduledJob(jobId).catch(() => undefined);
    throw new RestError(
      `scheduled job ${jobId} does not match what was requested (${problems.join("; ")})`,
    );
  }
}

/** `destroy_at` (ISO minute) for `instanceId` from a job list; the earliest when there are several. */
export function destroyAtFor(
  jobs: ScheduledJob[],
  instanceId: number,
  now: number = nowSec(),
): string | undefined {
  return timerSummaryFor(jobs, instanceId, now)?.destroyAt;
}

/** One `show scheduled-jobs` call for status/dashboard; a failed listing is undefined, never an error. */
export async function tryListScheduledJobs(): Promise<
  ScheduledJob[] | undefined
> {
  try {
    return await listScheduledJobs();
  } catch {
    return undefined;
  }
}

export interface TimerCleanup {
  /** Fields to merge into the command output (empty when there was nothing to report). */
  fields: Record<string, string>;
  /** Help lines to append. */
  help: string[];
}

function failureText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 160 ? `${text.slice(0, 160)}...` : text;
}

/**
 * After an instance is destroyed, delete every destroy timer that still
 * points at it (E57: none is fine, E58: also for an already-gone instance),
 * whatever its frequency. Best effort: it never throws, so the destroy itself
 * stays a success; a failure becomes `destroy_timer_warning` plus a
 * manual-removal hint.
 */
export async function cleanupDestroyTimers(
  instanceIds: number[],
): Promise<TimerCleanup> {
  const empty: TimerCleanup = { fields: {}, help: [] };
  let jobs: ScheduledJob[];
  try {
    jobs = await listScheduledJobs();
  } catch (error) {
    return {
      fields: {
        destroy_timer_warning: `could not list scheduled jobs, so any destroy timer was not removed (${failureText(error)})`,
      },
      help: [
        "Check for leftover timers with `vast-axi raw show scheduled-jobs`, then `vast-axi raw delete scheduled-job <id>`",
      ],
    };
  }
  const wanted = new Set(instanceIds);
  const mine = jobs.filter((j) => {
    const target = destroyTarget(j);
    return (
      target !== undefined &&
      wanted.has(target) &&
      typeof j.id === "number" &&
      Number.isInteger(j.id)
    );
  });
  if (mine.length === 0) return empty;

  const removed: number[] = [];
  const failed: Array<{ id: number; why: string }> = [];
  for (const job of mine) {
    const id = job.id as number;
    try {
      await deleteScheduledJob(id);
      removed.push(id);
    } catch (error) {
      failed.push({ id, why: failureText(error) });
    }
  }
  const fields: Record<string, string> = {};
  const help: string[] = [];
  if (removed.length > 0) {
    fields["destroy_timer"] =
      `removed job${removed.length > 1 ? "s" : ""} ${removed.join(", ")}`;
  }
  if (failed.length > 0) {
    fields["destroy_timer_warning"] =
      `could not remove scheduled job${failed.length > 1 ? "s" : ""} ${failed.map((f) => f.id).join(", ")} (${failed[0]!.why}); it may still fire on a gone instance`;
    for (const f of failed) {
      help.push(
        `Remove the leftover timer with \`vast-axi raw delete scheduled-job ${f.id}\``,
      );
    }
  }
  return { fields, help };
}
