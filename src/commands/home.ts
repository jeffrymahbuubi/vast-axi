// R4: the no-argument dashboard. Three upstream calls in parallel: the two of
// KTD6 plus `show scheduled-jobs` (destroy_at); only the first two can fail it.
import { assertKnownFlags } from "../args.js";
import { projection24h, storagePerHr, totalBurnPerHr } from "../burn.js";
import { loadConfig } from "../config.js";
import {
  destroyTarget,
  legacyTimerNotice,
  nowSec,
  timerSummaryFor,
  tryListScheduledJobs,
  type TimerSummary,
} from "../destroy-timer.js";
import { pricePerHr, round } from "../format.js";
import { buildHelp } from "../help.js";
import { idleState } from "../idle.js";
import {
  asInstanceList,
  classifyInstance,
  gpuLabel,
  instanceAgeHours,
} from "../instance-state.js";
import { emptyState } from "../toon.js";
import { vastJson } from "../vastai.js";
import type { VastCommand } from "./types.js";

interface UserBody {
  credit?: number | null;
  balance?: number | null;
}

interface Inst {
  id: number;
  label?: string | null;
  gpu_name?: string | null;
  num_gpus?: number | null;
  actual_status?: string | null;
  intended_status?: string | null;
  dph_total?: number | null;
  storage_cost?: number | null;
  disk_space?: number | null;
  start_date?: number | null;
  gpu_util?: number | null;
}

/** The `destroy_at` cell: the ISO minute, flagged when it comes from a legacy HOURLY timer. */
function destroyCell(summary: TimerSummary | undefined): string | null {
  if (!summary) return null;
  return summary.legacy.length > 0
    ? `${summary.destroyAt} LEGACY`
    : summary.destroyAt;
}

export const help = buildHelp({
  usage: "vast-axi",
  summary:
    "Dashboard: balance, instances with $/hr, burn rate, 24h projection, idle flags.",
  notes: [
    "idle is no, unknown or likely, never a plain yes: vast.ai's gpu_util lags real usage by minutes",
    "likely = running, older than idleMinutes (default 30), gpu_util under 5%; unknown = too young for the metric (metricLagMinutes, default 15) or no data",
    "confirm a likely with `vast-axi status <id> --live` (nvidia-smi over ssh) before stopping",
    "stopped instances are listed with storage_per_hr, which is folded into burn_per_hr",
    "runway_h = balance / burn_per_hr in hours (0 when the balance is not positive); left out when burn is 0 or the balance is unknown",
    "destroy_at (UTC) appears on each running instance only when a `rent --max-hours` timer is set for at least one of them",
    "destroy_at ending in LEGACY marks an old hourly timer (v0.1.4 to v0.1.6) that fires at the next :00, not at the planned time: delete it with `vast-axi raw delete scheduled-job <id>`",
    "a warning line appears when burn exceeds VAST_AXI_MAX_BURN (default 2x the per-instance cap)",
  ],
  examples: ["vast-axi", "vast-axi --json"],
});

export const command: VastCommand = async (args) => {
  assertKnownFlags(args, []);
  const config = loadConfig();
  // The scheduled-jobs listing only adds destroy_at; a failure changes nothing.
  const [user, body, jobs] = await Promise.all([
    vastJson<UserBody>(["show", "user"]),
    vastJson<unknown>(["show", "instances"]),
    tryListScheduledJobs(),
  ]);
  const now = Date.now();
  const all = asInstanceList<Inst>(body);
  const nowS = nowSec();
  const timerAt = new Map<number, TimerSummary>();
  const leftover: Array<{ job: number; instance: number }> = [];
  for (const job of jobs ?? []) {
    const target = destroyTarget(job);
    if (target === undefined) continue;
    if (all.some((i) => i.id === target)) {
      const summary = timerSummaryFor(jobs ?? [], target, nowS);
      if (summary) timerAt.set(target, summary);
    } else if (typeof job.id === "number") {
      leftover.push({ job: job.id, instance: target });
    }
  }
  const showTimers = all.some(
    (i) => timerAt.has(i.id) && classifyInstance(i, now).class !== "stopped",
  );

  const live: Array<Record<string, unknown>> = [];
  const stopped: Array<Record<string, unknown>> = [];
  const likelyIds: number[] = [];
  let metricCaveat = false;
  for (const inst of all) {
    const state = classifyInstance(inst, now);
    if (state.class === "stopped") {
      stopped.push({
        id: inst.id,
        label: inst.label ?? null,
        gpu: gpuLabel(inst),
        storage_per_hr: storagePerHr(inst),
      });
      continue;
    }
    const idle = idleState(
      inst,
      config.idleMinutes,
      now,
      config.metricLagMinutes,
    );
    if (idle === "likely") likelyIds.push(inst.id);
    if (idle !== "no") metricCaveat = true;
    live.push({
      id: inst.id,
      label: inst.label ?? null,
      gpu: gpuLabel(inst),
      status: state.reason === "slow" ? "booting (slow)" : state.class,
      dph_total: pricePerHr(inst.dph_total),
      age_h: instanceAgeHours(inst, now),
      gpu_util:
        typeof inst.gpu_util === "number" ? Math.round(inst.gpu_util) : null,
      idle,
      ...(showTimers ? { destroy_at: destroyCell(timerAt.get(inst.id)) } : {}),
    });
  }

  const burn = totalBurnPerHr(all);
  const balance = user.credit ?? user.balance;
  const hints: string[] = [];
  // A legacy HOURLY timer is dangerous (fires at the next :00): warn first.
  for (const [id, summary] of timerAt) {
    if (summary.legacy.length > 0) {
      hints.push(...legacyTimerNotice(id, summary.legacy).help);
    }
  }
  for (const id of likelyIds) {
    hints.push(
      `#${id} looks idle per vast.ai's delayed gpu_util; confirm with \`vast-axi status ${id} --live\` before stopping`,
    );
  }
  for (const { job, instance } of leftover) {
    hints.push(
      `Leftover destroy timer job ${job} for gone instance ${instance}: \`vast-axi destroy ${instance}\` removes it`,
    );
  }
  hints.push(
    live.length === 0
      ? "Run `vast-axi search --limit 10` to find a GPU"
      : "Run `vast-axi status <id>` for SSH details",
  );

  return {
    balance: typeof balance === "number" ? round(balance, 2) : null,
    ...(live.length > 0
      ? { instances: live }
      : emptyState("instances", "0 running instances")),
    ...(stopped.length > 0 ? { stopped } : {}),
    burn_per_hr: round(burn, 4),
    ...(typeof balance === "number" && burn > 0
      ? { runway_h: round(Math.max(balance, 0) / burn, 1) }
      : {}),
    projection_24h: projection24h(burn),
    ...(burn > config.maxBurn
      ? {
          warning: `burn $${round(burn, 2)}/hr exceeds maxBurn $${round(config.maxBurn, 2)}/hr`,
        }
      : {}),
    ...(metricCaveat
      ? {
          note: "gpu_util comes from vast.ai and lags real usage by minutes; no timestamp is provided",
        }
      : {}),
    help: hints,
  };
};
