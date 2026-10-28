import { round } from "./format.js";

/** Hours per month vast.ai uses to turn `storage_cost` ($/GB/month) into an hourly rate. */
const HOURS_PER_MONTH = 730;

/** The instance fields burn math reads; everything else on the upstream row is ignored. */
export interface BurnInstance {
  actual_status?: string | null;
  dph_total?: number | null;
  storage_cost?: number | null;
  disk_space?: number | null;
}

/** Disk-only hourly cost a stopped instance keeps billing (OQ14a). */
export function storagePerHr(inst: BurnInstance): number {
  const cost = inst.storage_cost ?? 0;
  const disk = inst.disk_space ?? 0;
  return round((cost * disk) / HOURS_PER_MONTH, 4);
}

/**
 * Hourly cost of one instance. Stopped/exited instances bill storage only;
 * every other state (running, booting, offline, unknown) is counted at
 * `dph_total` so the guard errs towards over-estimating spend.
 */
export function instanceBurnPerHr(inst: BurnInstance): number {
  const status = inst.actual_status ?? null;
  if (status === "exited" || status === "stopped") return storagePerHr(inst);
  return inst.dph_total ?? 0;
}

/** Total hourly burn across the account; shared by the dashboard (U4) and the rent guard (U5). */
export function totalBurnPerHr(instances: BurnInstance[]): number {
  return round(
    instances.reduce((sum, inst) => sum + instanceBurnPerHr(inst), 0),
    4,
  );
}

/** Projected spend over the next 24 hours at the current burn. */
export function projection24h(burnPerHr: number): number {
  return round(burnPerHr * 24, 2);
}
