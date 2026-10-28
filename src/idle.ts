/**
 * OQ13a, amended by E32: vast.ai's `gpu_util` lags real GPU usage by minutes
 * (about 10 observed) and carries no timestamp, so the upstream metric alone
 * can never prove an instance idle. `idleState` is a tri-state label, display
 * only: "no", "unknown" (too young for the metric to be trusted, or missing
 * data) or "likely" (old enough and still reading low). Confirm a "likely"
 * with `status <id> --live`, which asks the GPU itself.
 */
import { classifyInstance, type StateInstance } from "./instance-state.js";

/** GPU utilisation (percent) below which a GPU counts as idle. */
export const IDLE_GPU_UTIL = 5;

/** Minutes the upstream `gpu_util` is assumed to lag; override with `metricLagMinutes`. */
export const METRIC_LAG_GRACE_MIN = 15;

export type IdleState = "no" | "unknown" | "likely";

export interface IdleInstance extends StateInstance {
  gpu_util?: number | null;
}

export function idleState(
  inst: IdleInstance,
  idleMinutes: number,
  nowMs: number = Date.now(),
  graceMinutes: number = METRIC_LAG_GRACE_MIN,
): IdleState {
  if (classifyInstance(inst, nowMs).class !== "running") return "no";
  const util = inst.gpu_util;
  if (typeof util === "number" && util >= IDLE_GPU_UTIL) return "no";
  if (typeof util !== "number" || util < 0) return "unknown";
  if (typeof inst.start_date !== "number") return "unknown";
  const ageMinutes = (nowMs / 1000 - inst.start_date) / 60;
  if (ageMinutes < graceMinutes) return "unknown";
  return ageMinutes >= Math.max(idleMinutes, graceMinutes) ? "likely" : "no";
}
