// `rent --max-hours`: arm the server-side destroy timer for a new instance, or
// destroy that instance again so nothing is left running without a verified timer.
import { takeFlag } from "./args.js";
import { destroyInstance } from "./commands/destroy.js";
import {
  createDestroyTimer,
  isoMinute,
  verifyDestroyTimer,
  type DestroyPlan,
} from "./destroy-timer.js";
import { AxiError } from "./errors.js";
import { scrubSecrets } from "./vast-rest.js";

/** Longest `--max-hours`: vast.ai's DAILY job fires once per 24 h, and the plan must stay inside one day. */
export const MAX_HOURS_CAP = 23;
const MIN_HOURS = 2;

/**
 * Take `--max-hours <n>` out of `args`: a number from 2 to 23 (decimals fine),
 * or undefined when absent. Anything else is a VALIDATION_ERROR (E70, E101).
 */
export function takeMaxHoursFlag(args: string[]): number | undefined {
  const raw = takeFlag(args, "--max-hours");
  if (raw === undefined) return undefined;
  const n = raw.trim() === "" ? NaN : Number(raw);
  if (!Number.isFinite(n) || n < MIN_HOURS || n > MAX_HOURS_CAP) {
    throw new AxiError(
      `--max-hours must be a number from ${MIN_HOURS} to ${MAX_HOURS_CAP}, got "${raw}"${n > MAX_HOURS_CAP ? ` (the destroy timer is a vast.ai daily job, so it cannot be set more than ${MAX_HOURS_CAP} h ahead)` : ""}`,
      "VALIDATION_ERROR",
      [
        `Example: --max-hours 12 (destroy the instance after at most 12 hours)`,
        "For a longer run, end it with `vast-axi finish <id> --wait --fetch <remote>:<local> --destroy`",
      ],
    );
  }
  return n;
}

function why(error: unknown, apiKey: string): string {
  const text = error instanceof Error ? error.message : String(error);
  return scrubSecrets(text, apiKey);
}

export interface ArmedTimer {
  jobId: number;
  fields: {
    max_hours: number;
    destroy_at: string;
    runs_for_h: number;
    destroy_timer: string;
  };
}

/**
 * Create the scheduled destroy for the freshly rented `instanceId` and read it
 * back (OQ42). If either fails in any way, destroy the instance at once (E54,
 * E69) and throw SCHEDULE_FAILED; if the destroy fails too, say loudly that it
 * is still billing (E54b).
 */
export async function armDestroyTimer(
  instanceId: number,
  plan: DestroyPlan,
  maxHours: number,
  apiKey: string,
): Promise<ArmedTimer> {
  let jobId: number;
  try {
    jobId = await createDestroyTimer(instanceId, plan, apiKey);
    await verifyDestroyTimer(jobId, instanceId, plan);
  } catch (error) {
    const reason = why(error, apiKey);
    try {
      await destroyInstance(instanceId);
    } catch (destroyError) {
      throw new AxiError(
        `Instance ${instanceId} is STILL RUNNING and billing: its destroy timer could not be set (${reason}) and destroying it again failed (${why(destroyError, apiKey)})`,
        "SCHEDULE_FAILED",
        [
          `Run \`vast-axi destroy ${instanceId}\` NOW`,
          "Run `vast-axi status` to check the account",
        ],
      );
    }
    throw new AxiError(
      `Instance ${instanceId} was destroyed because its destroy timer could not be set: ${reason}`,
      "SCHEDULE_FAILED",
      [
        "Nothing is running; the rental was rolled back",
        "Rent again without --max-hours, or retry once the vast.ai API answers",
      ],
    );
  }
  return {
    jobId,
    fields: {
      max_hours: maxHours,
      destroy_at: isoMinute(plan.destroyAt),
      runs_for_h: plan.runsForH,
      destroy_timer: `vast.ai scheduled job ${jobId} (daily at ${String(plan.hour).padStart(2, "0")}:00 UTC, verified; server-side; runs even if this machine is off)`,
    },
  };
}
