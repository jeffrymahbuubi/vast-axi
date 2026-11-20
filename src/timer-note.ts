// The destroy timer as a note for `job`, `run` and `finish`: when it fires, and
// a loud warning when that is close. Never throws: no timer, or a scheduled-job
// listing that fails, is just an empty note.
import {
  destroyTarget,
  isoMinute,
  jobFire,
  nowSec,
  tryListScheduledJobs,
} from "./destroy-timer.js";
import { formatDuration } from "./format.js";

export interface TimerNote {
  fields: Record<string, string>;
  help: string[];
  /** Seconds until the timer fires (never negative). */
  leftSec?: number;
  /** Unix seconds of the next firing. */
  destroyAtSec?: number;
}

/** A timer this close always warns, whatever `withinSec` says. */
const MIN_WARN_SEC = 1800;

export async function timerNote(
  id: number,
  opts: { withinSec?: number } = {},
): Promise<TimerNote> {
  try {
    const jobs = await tryListScheduledJobs();
    if (!jobs) return { fields: {}, help: [] };
    const now = nowSec();
    const fires = jobs
      .filter((j) => destroyTarget(j) === id)
      .map((j) => jobFire(j, now))
      .filter((f): f is NonNullable<typeof f> => f !== undefined)
      .sort((a, b) => a.at - b.at);
    const first = fires[0];
    if (!first) return { fields: {}, help: [] };
    const leftSec = Math.max(0, first.at - now);
    const left = formatDuration(leftSec);
    const at = isoMinute(first.at);
    const fields: Record<string, string> = {
      destroy_at: at,
      timer_left: left,
    };
    const help: string[] = [];
    if (leftSec <= Math.max(opts.withinSec ?? 0, MIN_WARN_SEC)) {
      fields["timer_warning"] =
        `destroy timer fires in ${left} (${at}): the instance and everything on it are deleted then`;
      help.push(
        `Extend it: \`vast-axi timer ${id} --max-hours <n>\` (2 to 23 h from now)`,
        `Or fetch now: \`vast-axi finish ${id} --fetch-partial --fetch <remote>:<local>\``,
      );
    }
    return { fields, help, leftSec, destroyAtSec: first.at };
  } catch {
    return { fields: {}, help: [] };
  }
}
