// `status <id> --live`: read real GPU usage from nvidia-smi over ssh, because
// the upstream `gpu_util` lags by minutes (E32). Pure parsing lives here so it
// is testable without ssh.
import { AxiError } from "./errors.js";
import { truncate } from "./format.js";
import { IDLE_GPU_UTIL } from "./idle.js";

/** The remote argv, one token each, run with no shell on either side of the ssh hop. */
export const NVIDIA_SMI_ARGS = [
  "nvidia-smi",
  "--query-gpu=utilization.gpu,power.draw,memory.used",
  "--format=csv,noheader,nounits",
];

export interface LiveGpu {
  gpus: number;
  /** Busiest GPU, percent. */
  gpu_util_live: number;
  /** Total draw across GPUs in watts; null when no GPU reported one. */
  power_w: number | null;
  /** Total memory in use across GPUs in MiB; null when none reported it. */
  mem_used_mib: number | null;
  /** "yes" only when every GPU is under 5%. */
  idle_live: "yes" | "no";
}

/** A number, or null for `[N/A]`, `N/A` and anything else nvidia-smi prints in its place. */
function num(field: string | undefined): number | null {
  const n = Number((field ?? "").trim());
  return (field ?? "").trim() !== "" && Number.isFinite(n) ? n : null;
}

const sum = (xs: Array<number | null>): number | null => {
  const known = xs.filter((x): x is number => x !== null);
  return known.length === 0 ? null : known.reduce((a, b) => a + b, 0);
};

const round1 = (n: number | null): number | null =>
  n === null ? null : Math.round(n * 10) / 10;

/**
 * Parse `utilization.gpu, power.draw, memory.used` CSV (one line per GPU).
 * Utilisation is required: a line without it is an error, never a guess.
 */
export function parseNvidiaSmi(id: number, stdout: string): LiveGpu {
  const rows = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split(","));
  const utils = rows.map((r) => num(r[0]));
  if (rows.length === 0 || utils.some((u) => u === null)) {
    throw new AxiError(
      `nvidia-smi on #${id} returned no usable utilisation: ${truncate(stdout.trim(), 200) || "empty output"}`,
      "SSH_FAILED",
      [
        `Run \`vast-axi ssh ${id} --exec -- nvidia-smi\` to see the raw output`,
        "Do not stop or destroy the instance on the delayed gpu_util alone",
      ],
    );
  }
  const values = utils as number[];
  return {
    gpus: rows.length,
    gpu_util_live: Math.max(...values),
    power_w: round1(sum(rows.map((r) => num(r[1])))),
    mem_used_mib: sum(rows.map((r) => num(r[2]))),
    idle_live: values.every((u) => u < IDLE_GPU_UTIL) ? "yes" : "no",
  };
}
