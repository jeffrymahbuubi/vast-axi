// Move an existing destroy timer (`vast-axi timer <id> --max-hours N`): the same
// scheduled job gets a new start/end window and hour via PUT (V10). The PUT body
// is the full create body, as vastai's own CLI sends it after a 422 job_exists.
import {
  isoMinute,
  jobFire,
  listScheduledJobs,
  timerProblems,
  type DestroyPlan,
  type ScheduledJob,
} from "./destroy-timer.js";
import { restRequest, RestError, scrubSecrets } from "./vast-rest.js";

/** A failed update: `stage` says whether the PUT was refused or the read-back disagreed. */
export class TimerUpdateError extends RestError {
  readonly stage: "rejected" | "readback";
  /** When the job fires according to the read-back (ISO minute), if known. */
  readonly actualAt: string | undefined;
  constructor(
    stage: "rejected" | "readback",
    message: string,
    status: number | null = null,
    actualAt?: string,
  ) {
    super(message, status);
    this.name = "TimerUpdateError";
    this.stage = stage;
    this.actualAt = actualAt;
  }
}

/**
 * PUT the new plan onto scheduled job `jobId`, then read the job back and
 * compare it with `plan`. A mismatch throws and does NOT delete the job (the
 * instance keeps whatever timer the job now holds).
 */
export async function updateDestroyTimer(
  jobId: number,
  instanceId: number,
  plan: DestroyPlan,
  apiKey: string,
): Promise<void> {
  try {
    const { json, status } = await restRequest(
      "PUT",
      `/api/v0/commands/schedule_job/${jobId}/`,
      {
        start_time: plan.startTime,
        end_time: plan.endTime,
        api_endpoint: `/api/v0/instances/${instanceId}/`,
        request_method: "DELETE",
        request_body: {},
        day_of_the_week: null,
        hour_of_the_day: plan.hour,
        frequency: "DAILY",
        instance_id: instanceId,
      },
      apiKey,
    );
    const o =
      json && typeof json === "object" && !Array.isArray(json)
        ? (json as Record<string, unknown>)
        : {};
    if (o["success"] === false) {
      const msg = typeof o["msg"] === "string" ? `: ${o["msg"]}` : "";
      throw new RestError(
        scrubSecrets(
          `vast.ai API did not accept the update (success is false)${msg}`.slice(
            0,
            300,
          ),
          apiKey,
        ),
        status,
      );
    }
  } catch (error) {
    if (error instanceof RestError) {
      throw new TimerUpdateError("rejected", error.message, error.status);
    }
    throw error;
  }

  let jobs: ScheduledJob[];
  try {
    jobs = await listScheduledJobs();
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    throw new TimerUpdateError(
      "readback",
      `could not read scheduled job ${jobId} back to verify the update (${scrubSecrets(why, apiKey).slice(0, 120)})`,
    );
  }
  const job = jobs.find((j) => j.id === jobId);
  if (!job) {
    throw new TimerUpdateError(
      "readback",
      `scheduled job ${jobId} is not in \`show scheduled-jobs\` after the update`,
    );
  }
  const problems = timerProblems(job, instanceId, plan);
  if (problems.length > 0) {
    const fire = jobFire(job);
    throw new TimerUpdateError(
      "readback",
      `scheduled job ${jobId} does not match what was requested (${problems.join("; ")})`,
      null,
      fire ? isoMinute(fire.at) : undefined,
    );
  }
}
