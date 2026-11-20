// Job state and tail cleanup, split out of src/job.ts (it re-exports them, so
// importers are unchanged). Pure functions over a parsed probe record.
import { redactSecrets } from "./errors.js";
import { formatDuration, truncate } from "./format.js";
import type { JobRecord } from "./job.js";

export const TAIL_LINE_CAP = 400;

export type JobState = "running" | "finished" | "failed" | "lost";

export interface JobStatus {
  state: JobState;
  exitCode?: number;
  ended?: string;
  elapsed?: string;
  /** Exact seconds behind `elapsed` (which is floored to whole minutes). */
  elapsedSec?: number;
}

function seconds(from?: string, to?: string): number | undefined {
  const a = Date.parse(from ?? "");
  const b = Date.parse(to ?? "");
  return Number.isNaN(a) || Number.isNaN(b) ? undefined : (b - a) / 1000;
}

/**
 * Finished means this run's marker is in the log (or, if the log has no
 * marker, the wrapper's `exit` file exists). Otherwise alive means running and
 * not alive means lost (E41); the ssh echo is never consulted.
 */
export function jobStatus(rec: JobRecord): JobStatus {
  const done = rec.marker ?? rec.exitFile;
  if (done) {
    const secs = seconds(rec.start, done.end);
    return {
      state: done.code === 0 ? "finished" : "failed",
      exitCode: done.code,
      ended: done.end,
      ...(secs !== undefined
        ? { elapsed: formatDuration(secs), elapsedSec: secs }
        : {}),
    };
  }
  const secs = seconds(rec.start, rec.now);
  const elapsed =
    secs !== undefined
      ? { elapsed: formatDuration(secs), elapsedSec: secs }
      : {};
  return { state: rec.alive ? "running" : "lost", ...elapsed };
}

/**
 * Clean the raw tail for display: drop this run's marker line, collapse tqdm
 * `\r` progress to the last segment (E43), redact secrets (E51), cut each
 * line to 400 characters and keep the last `n` lines.
 */
export function cleanTail(rec: JobRecord, n: number): string[] {
  if (n <= 0 || !rec.tailText) return [];
  const lines = rec.tailText
    .split("\n")
    .filter((l) => l.replace(/\r$/, "") !== rec.markerLine)
    .map((l) => {
      const segments = l.split("\r").filter((s) => s !== "");
      return segments[segments.length - 1] ?? "";
    });
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "")
    lines.pop();
  return lines.slice(-n).map((l) => truncate(redactSecrets(l), TAIL_LINE_CAP));
}
