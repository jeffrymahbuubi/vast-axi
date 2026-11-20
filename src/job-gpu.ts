// The one `nvidia-smi` sample the job probe takes (field report #8): parse it
// and turn it into the `gpu_*` output fields and the idle warning. Display only;
// nothing here changes an exit code. Imports only types from job.ts.
import { IDLE_GPU_UTIL } from "./idle.js";
import type { JobRecord } from "./job.js";
import type { JobStatus } from "./job-status.js";

/** Show the live GPU fields once the job has run this long (seconds). */
export const GPU_FIELDS_AFTER_S = 60;
/** Warn about an idle GPU only after this much run time (seconds). */
export const GPU_IDLE_GRACE_S = 300;

export type GpuSample = NonNullable<JobRecord["gpu"]>;

/**
 * Parse the value of an `@vaxi gpu` line: `<util>, <mem>;<util>, <mem>;`.
 * `[N/A]` memory becomes null; any other malformed entry (including a
 * non-numeric utilisation) drops the whole sample.
 */
export function parseGpuSample(val: string): GpuSample | undefined {
  const util: number[] = [];
  const memMib: Array<number | null> = [];
  for (const part of val.split(";")) {
    if (part.trim() === "") continue;
    const m = /^\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?|\[?N\/A\]?)\s*$/.exec(
      part,
    );
    if (!m) return undefined;
    util.push(Number(m[1]));
    memMib.push(/^\d/.test(m[2]!) ? Number(m[2]) : null);
  }
  return util.length > 0 ? { util, memMib } : undefined;
}

export interface GpuFields {
  gpu_util_live: number;
  gpu_mem_mib: number | null;
  gpu_warning?: string;
}

/** The I4 `gpu_*` fields for one record, or undefined when nothing is shown. */
export function gpuFields(
  rec: JobRecord,
  status: JobStatus,
  opts: { warn?: boolean } = {},
): { fields: GpuFields; warned: boolean } | undefined {
  const g = rec.gpu;
  if (!g || status.state !== "running") return undefined;
  const secs = status.elapsedSec;
  if (secs === undefined || secs < GPU_FIELDS_AFTER_S) return undefined;
  const util = Math.max(...g.util);
  const known = g.memMib.filter((m): m is number => m !== null);
  const mem = known.length > 0 ? known.reduce((a, b) => a + b, 0) : null;
  const fields: GpuFields = { gpu_util_live: util, gpu_mem_mib: mem };
  const idle = g.util.every((u) => u < IDLE_GPU_UTIL);
  const warned = opts.warn !== false && secs >= GPU_IDLE_GRACE_S && idle;
  if (warned) {
    const now = mem !== null ? `${util}%, ${mem} MiB` : `${util}%`;
    fields.gpu_warning = `GPU idle: every GPU is under ${IDLE_GPU_UTIL}% (now ${now}) and job "${rec.name}" has run for ${status.elapsed ?? "?"}. If it should use the GPU, check that the framework sees it (CUDA build, driver) before more hours bill`;
  }
  return { fields, warned };
}

/** The help line shown beside a `gpu_warning`. */
export function gpuWarningHelp(id: number): string {
  return `\`vast-axi ssh ${id} --exec -- nvidia-smi\` shows what holds the GPU`;
}
