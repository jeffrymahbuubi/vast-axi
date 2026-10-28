/**
 * KTD5: the one table that turns vast.ai's `actual_status` / `intended_status`
 * into a state class. The dashboard, `status` and every edge row (E11, E12,
 * E17) read it from here; nothing else decides what "running" means.
 *
 *   booting   loading, creating, null (and any status not listed below, so an
 *             unfamiliar value can never be mistaken for running)
 *   running   running
 *   stopped   exited (intended stopped = user stop, intended running =
 *             host_stopped, which covers an outbid interruptible instance)
 *   terminal  offline, unknown
 */
import { ageHours } from "./format.js";

export type StateClass = "booting" | "running" | "stopped" | "terminal";

/** Why a class is not the plain case; absent for an ordinary booting/running/user-stopped instance. */
export type StateReason = "slow" | "host_stopped" | "offline" | "unknown";

/** The upstream fields classification reads. */
export interface StateInstance {
  actual_status?: string | null;
  intended_status?: string | null;
  /** Epoch seconds, as upstream reports it. */
  start_date?: number | null;
}

export interface InstanceState {
  class: StateClass;
  reason?: StateReason;
}

/** Past this long in `booting` an instance is flagged `reason: slow` (a slow image pull is not a failure). */
export const SLOW_BOOT_SECONDS = 600;

export function classifyInstance(
  inst: StateInstance,
  nowMs: number = Date.now(),
): InstanceState {
  const status = inst.actual_status ?? null;
  if (status === "running") return { class: "running" };
  if (status === "exited") {
    return inst.intended_status === "running"
      ? { class: "stopped", reason: "host_stopped" }
      : { class: "stopped" };
  }
  if (status === "offline") return { class: "terminal", reason: "offline" };
  if (status === "unknown") return { class: "terminal", reason: "unknown" };
  const started = inst.start_date;
  const slow =
    typeof started === "number" && nowMs / 1000 - started > SLOW_BOOT_SECONDS;
  return slow ? { class: "booting", reason: "slow" } : { class: "booting" };
}

/** `show instances --raw` is a list, though some vastai versions wrap it as `{instances: [...]}`. */
export function asInstanceList<T = Record<string, unknown>>(
  body: unknown,
): T[] {
  if (Array.isArray(body)) return body as T[];
  if (body && typeof body === "object") {
    const inner = (body as Record<string, unknown>)["instances"];
    if (Array.isArray(inner)) return inner as T[];
  }
  return [];
}

/** Age in hours of an instance, or null when upstream gave no `start_date`. */
export function instanceAgeHours(
  inst: StateInstance,
  nowMs: number = Date.now(),
): number | null {
  return typeof inst.start_date === "number"
    ? ageHours(inst.start_date, nowMs)
    : null;
}

/**
 * The right next step for a class (R9, AE3). `stopped` never suggests destroy;
 * `terminal` suggests destroy and search and never waiting; `booting` never
 * suggests destroy.
 */
export function nextSteps(id: number | string, state: InstanceState): string[] {
  switch (state.class) {
    case "booting":
      return state.reason === "slow"
        ? [
            "Still booting after 10+ min (a big image pull can be slow); check `status_msg`",
            `Run \`vast-axi logs ${id}\` for progress, or \`vast-axi status ${id}\` to re-check`,
          ]
        : [`Run \`vast-axi status ${id} --wait\` to block until it is running`];
    case "running":
      return [
        `Run \`vast-axi ssh ${id}\` to connect`,
        `Run \`vast-axi stop ${id}\` when done`,
      ];
    case "stopped":
      return state.reason === "host_stopped"
        ? [
            "The host stopped this instance (an interruptible instance may have been outbid)",
            `Restart with \`vast-axi raw start instance ${id}\``,
          ]
        : [`Restart with \`vast-axi raw start instance ${id}\``];
    case "terminal":
      return [
        `Run \`vast-axi destroy ${id}\` to remove it`,
        "Run `vast-axi search --limit 10` to rent a replacement",
      ];
  }
}

/** `RTX 4090`, or `2x RTX 4090` for multi-GPU instances; null when upstream gave no name. */
export function gpuLabel(inst: {
  gpu_name?: string | null;
  num_gpus?: number | null;
}): string | null {
  if (!inst.gpu_name) return null;
  const n = inst.num_gpus ?? 1;
  return n > 1 ? `${n}x ${inst.gpu_name}` : inst.gpu_name;
}
