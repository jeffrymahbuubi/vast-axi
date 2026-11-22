// `timer`: show or move an instance's server-side destroy timer (the vast.ai
// scheduled job `rent --max-hours` created). It never stops or destroys an
// instance; a failed change leaves the instance running with the timer it had.
import { assertKnownFlags, takeBoolFlag, takePositional } from "../args.js";
import { totalBurnPerHr, type BurnInstance } from "../burn.js";
import {
  createDestroyTimer,
  destroyTarget,
  isoMinute,
  jobFire,
  legacyTimerNotice,
  listScheduledJobs,
  nowSec,
  planDestroy,
  timerSummaryFor,
  tryListScheduledJobs,
  verifyDestroyTimer,
  type DestroyPlan,
  type ScheduledJob,
} from "../destroy-timer.js";
import {
  assertNoExtra,
  fetchInstance,
  parseInstanceId,
  type InstanceInfo,
} from "../endpoint.js";
import { readBalance } from "../estimate.js";
import { AxiError } from "../errors.js";
import { formatDuration, money } from "../format.js";
import { buildHelp } from "../help.js";
import { takeMaxHoursFlag } from "../rent-timer.js";
import { TimerUpdateError, updateDestroyTimer } from "../timer-update.js";
import { requireApiKey, RestError, scrubSecrets } from "../vast-rest.js";
import { vastJson } from "../vastai.js";
import type { VastCommand } from "./types.js";

const USAGE = "vast-axi timer <id> [--max-hours <n>] [--confirm]";

export const help = buildHelp({
  usage: USAGE,
  summary:
    "Show an instance's server-side destroy timer, or move it (extend or shorten) with --max-hours.",
  flags: [
    "--max-hours <n>  set the destroy time to n hours from now (2 to 23, rounded down to the full UTC hour); creates the timer when there is none",
    "--confirm        proceed when burn x hours is above the account balance",
  ],
  notes: [
    "Without --max-hours it only reads: destroy_at, timer_left and the timer job (destroy_timer: none when there is no timer).",
    "--max-hours needs the vast.ai API key (VAST_API_KEY or the key file) and verifies the change by reading the job back.",
    "If the change fails (TIMER_FAILED, exit 1) the old timer stays and the instance is never stopped or destroyed.",
    "A legacy HOURLY timer is refused (exit 2): delete it with `vast-axi raw delete scheduled-job <job>`, then set a new one.",
  ],
  examples: ["vast-axi timer 42", "vast-axi timer 42 --max-hours 6"],
});

const pad = (hour: number): string => String(hour).padStart(2, "0");

function timerFail(message: string, extra: string[] = []): AxiError {
  return new AxiError(message, "TIMER_FAILED", extra);
}

function whyText(error: unknown, apiKey: string): string {
  const text = error instanceof Error ? error.message : String(error);
  return scrubSecrets(text, apiKey);
}

async function requireInstance(id: number): Promise<InstanceInfo> {
  const inst = await fetchInstance(id);
  if (!inst) {
    throw new AxiError(`Instance ${id} not found`, "NOT_FOUND", [
      "Run `vast-axi status` to list your instance ids",
    ]);
  }
  return inst;
}

/** The destroy timers of `id` (any frequency), earliest firing first. */
function timersOf(jobs: ScheduledJob[], id: number, now: number) {
  return jobs
    .filter((j) => destroyTarget(j) === id)
    .map((job) => ({ job, fire: jobFire(job, now) }))
    .sort((a, b) => (a.fire?.at ?? Infinity) - (b.fire?.at ?? Infinity));
}

async function show(id: number): Promise<Record<string, unknown>> {
  await requireInstance(id);
  const now = nowSec();
  const jobs = await tryListScheduledJobs();
  if (!jobs) {
    return {
      instance: `#${id}`,
      destroy_timer: "unknown (could not list scheduled jobs)",
      help: ["Retry `vast-axi timer " + id + "`"],
    };
  }
  const timers = timersOf(jobs, id, now);
  const summary = timerSummaryFor(jobs, id, now);
  const first = timers[0];
  if (!first || !summary) {
    return {
      instance: `#${id}`,
      destroy_timer: "none",
      help: [
        `Set one: \`vast-axi timer ${id} --max-hours <n>\` (2 to 23 h from now)`,
      ],
    };
  }
  const left = first.fire ? formatDuration(first.fire.at - now) : undefined;
  const base = {
    instance: `#${id}`,
    destroy_at: summary.destroyAt,
    ...(left !== undefined ? { timer_left: left } : {}),
  };
  if (summary.legacy.length > 0) {
    const notice = legacyTimerNotice(id, summary.legacy);
    return { ...base, destroy_timer: notice.field, help: notice.help };
  }
  const hour = first.job.hour_of_the_day;
  return {
    ...base,
    destroy_timer: `vast.ai scheduled job ${String(first.job.id)} (daily at ${typeof hour === "number" ? pad(hour) : "??"}:00 UTC)`,
    help: [
      `Extend or shorten it: \`vast-axi timer ${id} --max-hours <n>\` (2 to 23 h from now)`,
    ],
  };
}

interface Guard {
  /** A `guard:` note when the balance could not be checked. */
  note?: string;
}

/** Soft guard: current burn x runs_for_h above the balance is exit 2 unless --confirm. */
async function checkBalance(
  plan: DestroyPlan,
  confirm: boolean,
): Promise<Guard> {
  let burn: number;
  try {
    const body = await vastJson<unknown>(["show", "instances"]);
    const rows = Array.isArray(body)
      ? body
      : body && typeof body === "object"
        ? (body as Record<string, unknown>)["instances"]
        : undefined;
    if (!Array.isArray(rows))
      throw new Error("unexpected show instances output");
    burn = totalBurnPerHr(rows as BurnInstance[]);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return { note: `balance not checked (${why.slice(0, 120)})` };
  }
  const balance = await readBalance();
  if (balance.balance === null) {
    return {
      note: `balance not checked (${balance.failure ?? "balance unreadable"})`,
    };
  }
  const need = burn * plan.runsForH;
  if (need > balance.balance && !confirm) {
    throw new AxiError(
      `${plan.runsForH} h at the current burn of $${money(burn, 4)}/hr is $${money(need, 2)}, above the $${money(balance.balance, 2)} balance`,
      "VALIDATION_ERROR",
      [
        "Add --confirm to set the timer anyway, or pick a shorter --max-hours",
        "Top up the account, or end the run sooner with `vast-axi finish <id> --wait --fetch <remote>:<local> --destroy`",
      ],
    );
  }
  return {};
}

async function setTimer(
  id: number,
  maxHours: number,
  confirm: boolean,
): Promise<Record<string, unknown>> {
  const apiKey = requireApiKey("`timer --max-hours`");
  const inst = await requireInstance(id);
  const now = nowSec();
  const plan = planDestroy(now, maxHours);
  const guard = await checkBalance(plan, confirm);

  let jobs: ScheduledJob[];
  try {
    jobs = await listScheduledJobs();
  } catch (error) {
    throw timerFail(
      `could not list scheduled jobs (${whyText(error, apiKey).slice(0, 120)}): timer unchanged`,
      [`Retry \`vast-axi timer ${id} --max-hours ${maxHours}\``],
    );
  }
  const existing = timersOf(jobs, id, now);
  const legacy = existing.find((t) => t.fire?.legacy);
  if (legacy) {
    const job = legacy.job.id ?? "<id>";
    throw new AxiError(
      `Instance ${id} has a legacy HOURLY destroy timer (job ${String(job)}) that fires at the next :00; it cannot be moved`,
      "VALIDATION_ERROR",
      [
        `Delete it: \`vast-axi raw delete scheduled-job ${String(job)}\`, then \`vast-axi timer ${id} --max-hours ${maxHours}\``,
      ],
    );
  }

  const old = existing.find((t) => typeof t.job.id === "number");
  const was = old?.fire ? isoMinute(old.fire.at) : undefined;
  let jobId: number;
  if (old) {
    jobId = old.job.id as number;
    try {
      await updateDestroyTimer(jobId, id, plan, apiKey);
    } catch (error) {
      if (error instanceof TimerUpdateError && error.stage === "readback") {
        throw timerFail(
          `the timer now reads ${error.actualAt ?? "an unexpected time"}, not ${isoMinute(plan.destroyAt)}: ${error.message}`,
          [
            `Run \`vast-axi timer ${id}\` to re-check it`,
            `The job was not deleted; the instance is untouched`,
          ],
        );
      }
      // I10: a numeric status means vast.ai answered; anything else may have been applied.
      const certain =
        error instanceof TimerUpdateError && typeof error.status === "number";
      if (certain) {
        throw timerFail(
          `could not move the destroy timer (${whyText(error, apiKey)}): timer unchanged${was ? `, still ${was}` : ""}`,
          [
            `Run \`vast-axi timer ${id}\` to check it; the instance is untouched`,
          ],
        );
      }
      throw timerFail(
        `could not confirm the timer change (${whyText(error, apiKey)}): the timer may or may not have moved; it was ${was ?? "unknown"}`,
        [
          `Run \`vast-axi timer ${id}\` to see what it is now; the instance is untouched`,
        ],
      );
    }
  } else {
    try {
      jobId = await createDestroyTimer(id, plan, apiKey);
      await verifyDestroyTimer(jobId, id, plan);
    } catch (error) {
      const status = error instanceof RestError ? error.status : null;
      const why = whyText(error, apiKey);
      if (status === 422) {
        // createDestroyTimer's own 422 text already says this; don't repeat it.
        const exists = "a destroy timer already exists";
        throw timerFail(why.startsWith(exists) ? why : `${exists} (${why})`, [
          `Run \`vast-axi timer ${id}\` to see it`,
        ]);
      }
      if (typeof status === "number") {
        throw timerFail(
          `could not set a destroy timer (${why}): no timer was set`,
          [
            `Retry \`vast-axi timer ${id} --max-hours ${maxHours}\`; the instance is untouched`,
          ],
        );
      }
      throw timerFail(
        `could not set a destroy timer (${why}): the instance may have no timer`,
        [
          `Run \`vast-axi timer ${id}\` to check, then retry; the instance is untouched`,
        ],
      );
    }
  }

  const destroyAt = isoMinute(plan.destroyAt);
  const endDate = (inst as { end_date?: unknown }).end_date;
  const contractWarning =
    typeof endDate === "number" &&
    Number.isFinite(endDate) &&
    endDate > 0 &&
    endDate < plan.destroyAt
      ? `the rental contract ends at ${isoMinute(endDate)}, before destroy_at ${destroyAt}; the host may end the rental first`
      : undefined;
  return {
    instance: `#${id}`,
    max_hours: maxHours,
    destroy_at: destroyAt,
    runs_for_h: plan.runsForH,
    ...(was !== undefined && was !== destroyAt ? { was } : {}),
    destroy_timer: `vast.ai scheduled job ${jobId} (daily at ${pad(plan.hour)}:00 UTC, verified; server-side; runs even if this machine is off)`,
    ...(contractWarning ? { contract_warning: contractWarning } : {}),
    ...(guard.note ? { guard: guard.note } : {}),
    help: [
      `\`vast-axi timer ${id}\` shows the timer`,
      `End the run with \`vast-axi finish ${id} --wait --fetch <remote>:<local> --destroy\``,
    ],
  };
}

export const command: VastCommand = async (args) => {
  assertKnownFlags(args, ["--max-hours", "--confirm"], "timer");
  const maxHours = takeMaxHoursFlag(args);
  const confirm = takeBoolFlag(args, "--confirm");
  const id = parseInstanceId(takePositional(args, "id", `usage: ${USAGE}`));
  assertNoExtra(args, USAGE);
  return maxHours === undefined ? show(id) : setTimer(id, maxHours, confirm);
};
