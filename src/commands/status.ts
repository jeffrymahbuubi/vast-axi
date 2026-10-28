// R9: `status [id] [--wait]`. State classes come from src/instance-state.ts (KTD5).
import { assertKnownFlags, takeBoolFlag } from "../args.js";
import { loadConfig } from "../config.js";
import {
  legacyTimerNotice,
  nowSec,
  timerSummaryFor,
  tryListScheduledJobs,
  type TimerSummary,
} from "../destroy-timer.js";
import { resolveEndpoint, type InstanceInfo } from "../endpoint.js";
import { AxiError } from "../errors.js";
import { formatDuration, pricePerHr, truncate } from "../format.js";
import { buildHelp } from "../help.js";
import { idleState, type IdleState } from "../idle.js";
import {
  asInstanceList,
  classifyInstance,
  gpuLabel,
  instanceAgeHours,
  nextSteps,
  type InstanceState,
  type StateInstance,
} from "../instance-state.js";
import { NVIDIA_SMI_ARGS, parseNvidiaSmi } from "../live-gpu.js";
import { ONSTART_JOB, hasOnstartMarker } from "../onstart.js";
import { waitForOnstart } from "../status-onstart.js";
import { emptyState } from "../toon.js";
import {
  requireTool,
  runSsh,
  spawnTool,
  type ToolSpawner,
} from "../transfer.js";
import { vastJson } from "../vastai.js";
import type { VastCommand, VastOutput } from "./types.js";

export interface StatusInstance
  extends
    StateInstance,
    Pick<InstanceInfo, "public_ipaddr" | "image_runtype" | "ports"> {
  id: number;
  label?: string | null;
  gpu_name?: string | null;
  num_gpus?: number | null;
  image_uuid?: string | null;
  dph_total?: number | null;
  gpu_util?: number | null;
  ssh_host?: string | null;
  ssh_port?: number | null;
  status_msg?: string | null;
  /** true for an interruptible (bid) instance, false for on-demand. */
  is_bid?: boolean | null;
  /** The onstart script stored on the instance; vast-axi's carries a marker. */
  onstart?: string | null;
}

/** R9: poll every 15 s, give up after 10 minutes. */
export const WAIT_INTERVAL_MS = 15_000;
export const WAIT_DEADLINE_MS = 600_000;

/** Injectable time source so `--wait` tests run in milliseconds. */
export interface WaitClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  intervalMs: number;
  deadlineMs: number;
}

/** VAST_AXI_POLL_MS / VAST_AXI_WAIT_MS shrink the poll for end-to-end tests; otherwise R9's numbers. */
function envMs(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return n > 0 ? n : fallback;
}

export function realClock(): WaitClock {
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    intervalMs: envMs("VAST_AXI_POLL_MS", WAIT_INTERVAL_MS),
    deadlineMs: envMs("VAST_AXI_WAIT_MS", WAIT_DEADLINE_MS),
  };
}

export const help = buildHelp({
  usage: "vast-axi status [id] [--wait | --live]",
  summary:
    "List your instances, or show one. Each gets a class: booting, running, stopped or terminal.",
  flags: [
    "--wait  poll every 15s until running (exit 0); exits 1 at once on stopped/terminal, or after 10 min; if the instance has a vast-axi onstart job (`rent --onstart/--pip`), then waits up to 10 more min for it",
    "--live  read real GPU use with nvidia-smi over ssh (running instance only; not with --wait)",
  ],
  notes: [
    "running: ssh/stop; stopped: restart (never destroy); terminal: destroy and search",
    "onstart: present = the instance carries a `rent --onstart/--pip` job; with --wait it becomes running, finished (exit 0, n min), failed (exit N: exit 1, last 20 log lines, instance kept) or unknown (deadline)",
    "IMAGE_NO_SSH: with --wait on an onstart instance, if ssh keeps failing and the container log shows the launcher cannot find ssh, it exits 1 at once (the image ships no ssh); destroy it and rent an image that has ssh",
    "ssh_direct is the host:port that `ssh` and `copy` connect to (shown when the instance has a direct endpoint); ssh_proxy is vast.ai's proxy pair, the fallback",
    "booting past 10 min stays booting with reason: slow and the status_msg",
    "gpu_util and idle come from vast.ai and lag real usage by minutes; idle is no, unknown or likely, never a plain yes",
    "--live prints gpu_util_live (busiest GPU), power_w and mem_used_mib (totals) and idle_live (yes only if every GPU is under 5%)",
  ],
  examples: [
    "vast-axi status",
    "vast-axi status 12345",
    "vast-axi status 12345 --wait",
    "vast-axi status 12345 --live",
  ],
});

/** `on-demand` / `interruptible` from upstream `is_bid`; undefined when upstream did not say. */
function rentType(inst: StatusInstance): string | undefined {
  if (inst.is_bid === true) return "interruptible";
  if (inst.is_bid === false) return "on-demand";
  return undefined;
}

function describe(inst: StatusInstance, state: InstanceState): string {
  const parts: string[] = [`instance ${inst.id}`];
  parts.push(`is ${state.class}`);
  if (state.reason) parts.push(`(${state.reason})`);
  return parts.join(" ");
}

/**
 * ssh_host/ssh_port are vast.ai's proxy pair; `ssh` and `copy` connect to the
 * direct endpoint when one exists. Label both so the printed address is the
 * one that works: `ssh_direct` only when ssh/copy really use it.
 */
function sshFields(inst: StatusInstance): Record<string, unknown> {
  const ep = resolveEndpoint(inst);
  const directPort = Number(inst.ports?.["22/tcp"]?.[0]?.HostPort);
  const direct =
    ep !== undefined &&
    ep.host === inst.public_ipaddr &&
    ep.port === directPort;
  return {
    ssh_host: inst.ssh_host ?? null,
    ssh_port: inst.ssh_port ?? null,
    ...(inst.ssh_host && inst.ssh_port
      ? { ssh_proxy: `${inst.ssh_host}:${inst.ssh_port}` }
      : {}),
    ...(direct ? { ssh_direct: `${ep.host}:${ep.port}` } : {}),
  };
}

function detail(
  inst: StatusInstance,
  state: InstanceState,
  nowMs: number,
  idle: IdleState,
  timer?: TimerSummary,
): Record<string, unknown> {
  const legacy =
    timer && timer.legacy.length > 0
      ? legacyTimerNotice(inst.id, timer.legacy)
      : undefined;
  return {
    id: inst.id,
    label: inst.label ?? null,
    gpu: gpuLabel(inst),
    actual_status: inst.actual_status ?? null,
    class: state.class,
    reason: state.reason ?? null,
    ...(rentType(inst) !== undefined ? { type: rentType(inst) } : {}),
    dph_total: pricePerHr(inst.dph_total),
    age_h: instanceAgeHours(inst, nowMs),
    ...(timer ? { destroy_at: timer.destroyAt } : {}),
    ...(legacy ? { destroy_timer: legacy.field } : {}),
    gpu_util:
      typeof inst.gpu_util === "number" ? Math.round(inst.gpu_util) : null,
    gpu_util_source: "vast.ai (delayed)",
    idle,
    image: inst.image_uuid ?? null,
    ...sshFields(inst),
    status_msg: inst.status_msg ? truncate(inst.status_msg, 200) : null,
    help: [
      ...(legacy ? legacy.help : []),
      ...(idle === "likely"
        ? [
            `#${inst.id} looks idle per vast.ai's delayed gpu_util; confirm with \`vast-axi status ${inst.id} --live\` before stopping`,
          ]
        : []),
      ...nextSteps(inst.id, state),
    ],
  };
}

export interface StatusDeps {
  spawn?: ToolSpawner;
  resolveTool?: (name: "ssh") => string;
}

/** `--live`: ask the GPUs themselves. Never falls back to the delayed upstream value. */
async function liveStatus(
  inst: StatusInstance,
  state: InstanceState,
  deps: StatusDeps,
): Promise<Record<string, unknown>> {
  const id = inst.id;
  if (state.class !== "running") {
    throw new AxiError(
      `--live needs a running instance; #${id} is ${state.class}`,
      "VALIDATION_ERROR",
      nextSteps(id, state),
    );
  }
  const endpoint = resolveEndpoint(inst);
  if (!endpoint) {
    throw new AxiError(
      `Instance #${id} has no ssh endpoint yet`,
      "NOT_RUNNING",
      [`Run \`vast-axi status ${id}\` again in a minute`],
    );
  }
  const { run } = await runSsh(
    deps.spawn ?? spawnTool,
    (deps.resolveTool ?? requireTool)("ssh"),
    id,
    endpoint,
    NVIDIA_SMI_ARGS,
  );
  if (run.exitCode !== 0) {
    throw new AxiError(
      `nvidia-smi failed on #${id} (exit ${run.exitCode}): ${truncate(run.stderr.trim(), 300) || "no output"}`,
      "SSH_FAILED",
      [
        "The image may have no NVIDIA driver tools; the delayed gpu_util is not a substitute",
        `Run \`vast-axi ssh ${id} --exec -- nvidia-smi\` to see the raw error`,
      ],
    );
  }
  const live = parseNvidiaSmi(id, run.stdout);
  return {
    id,
    class: state.class,
    gpu_util_source: "nvidia-smi over ssh (live)",
    gpus: live.gpus,
    gpu_util_live: live.gpu_util_live,
    power_w: live.power_w,
    mem_used_mib: live.mem_used_mib,
    idle_live: live.idle_live,
    help:
      live.idle_live === "yes"
        ? [
            `Every GPU is under 5% right now; if no job should be running, run \`vast-axi stop ${id}\``,
            "A job between steps can read 0 briefly; run --live again to be sure",
          ]
        : ["GPUs are busy; leave the instance running"],
  };
}

async function fetchInstances(): Promise<StatusInstance[]> {
  return asInstanceList<StatusInstance>(await vastJson(["show", "instances"]));
}

async function fetchOne(id: number): Promise<StatusInstance> {
  const found = (await fetchInstances()).find((i) => i.id === id);
  if (!found) {
    throw new AxiError(`Instance ${id} not found`, "NOT_FOUND", [
      "Run `vast-axi status` to list your instances",
    ]);
  }
  return found;
}

/**
 * Poll until `id` is running. A stopped or terminal instance fails at once
 * (E11); a still-booting one fails at the deadline (E12). Returns the running
 * instance. The clock is injected so tests do not sleep.
 */
export async function waitForRunning(
  id: number,
  clock: WaitClock,
  fetch: (id: number) => Promise<StatusInstance> = fetchOne,
): Promise<StatusInstance> {
  const startedAt = clock.now();
  for (;;) {
    const inst = await fetch(id);
    const state = classifyInstance(inst, clock.now());
    if (state.class === "running") return inst;
    const elapsed = clock.now() - startedAt;
    if (state.class === "stopped" || state.class === "terminal") {
      throw new AxiError(
        `${describe(inst, state)}; it will not become running`,
        state.class === "stopped" ? "INSTANCE_STOPPED" : "INSTANCE_TERMINAL",
        nextSteps(id, state),
      );
    }
    if (elapsed >= clock.deadlineMs) {
      const msg = inst.status_msg
        ? ` status_msg: ${truncate(inst.status_msg, 200)}`
        : "";
      throw new AxiError(
        `instance ${id} still booting after ${formatDuration(elapsed / 1000)}.${msg}`,
        "WAIT_TIMEOUT",
        [
          `Run \`vast-axi status ${id}\` to check again`,
          `Run \`vast-axi logs ${id}\` for progress`,
        ],
      );
    }
    await clock.sleep(Math.min(clock.intervalMs, clock.deadlineMs - elapsed));
  }
}

function parseId(raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new AxiError(
      `Instance id must be a number, got "${raw}"`,
      "VALIDATION_ERROR",
      ["Usage: vast-axi status [id] [--wait | --live]"],
    );
  }
  return Number(raw);
}

async function runStatus(
  args: string[],
  deps: StatusDeps,
): Promise<VastOutput> {
  assertKnownFlags(args, ["--wait", "--live"], "status");
  const rest = [...args];
  const wait = takeBoolFlag(rest, "--wait");
  const live = takeBoolFlag(rest, "--live");
  if (wait && live) {
    throw new AxiError(
      "--wait and --live cannot be combined",
      "VALIDATION_ERROR",
      ["Run `vast-axi status <id> --wait`, then `vast-axi status <id> --live`"],
    );
  }
  const positionals = rest.filter((a) => !a.startsWith("-"));
  if (positionals.length > 1) {
    throw new AxiError(
      `Expected at most one <id>, got ${positionals.length}`,
      "VALIDATION_ERROR",
      ["Usage: vast-axi status [id] [--wait | --live]"],
    );
  }
  const id = positionals[0] !== undefined ? parseId(positionals[0]) : undefined;

  if (id === undefined) {
    if (wait || live) {
      const flag = wait ? "--wait" : "--live";
      throw new AxiError(`${flag} needs an <id>`, "VALIDATION_ERROR", [
        `Usage: vast-axi status <id> ${flag}`,
      ]);
    }
    const all = await fetchInstances();
    if (all.length === 0) {
      return emptyState("instances", "0 instances", [
        "Run `vast-axi search --limit 10` to find a GPU",
      ]);
    }
    const now = Date.now();
    const states = all.map((inst) => classifyInstance(inst, now));
    const seen = new Set<string>();
    const hints: string[] = [];
    all.forEach((inst, i) => {
      const state = states[i]!;
      if (seen.has(state.class)) return;
      seen.add(state.class);
      const step = nextSteps(inst.id, state).find((s) =>
        s.includes("`vast-axi"),
      );
      if (step) hints.push(`${state.class}: ${step}`);
    });
    return {
      instances: all.map((inst, i) => ({
        id: inst.id,
        label: inst.label ?? null,
        gpu: gpuLabel(inst),
        actual_status: inst.actual_status ?? null,
        class: states[i]!.class,
        reason: states[i]!.reason ?? null,
        dph_total: pricePerHr(inst.dph_total),
        age_h: instanceAgeHours(inst, now),
      })),
      help: hints,
    };
  }

  const inst = wait
    ? await waitForRunning(id, realClock())
    : await fetchOne(id);
  const hasOnstart = hasOnstartMarker(inst.onstart);
  const onstart =
    wait && hasOnstart
      ? await waitForOnstart(id, inst, realClock(), deps, fetchOne)
      : undefined;
  const now = Date.now();
  const state = classifyInstance(inst, now);
  if (live) return liveStatus(inst, state, deps);
  const { idleMinutes, metricLagMinutes } = loadConfig();
  const idle = idleState(inst, idleMinutes, now, metricLagMinutes);
  // One extra call; a failed listing just leaves destroy_at out.
  const jobs = await tryListScheduledJobs();
  const timer = jobs ? timerSummaryFor(jobs, id, nowSec()) : undefined;
  const out = detail(inst, state, now, idle, timer);
  if (!hasOnstart) return out;
  if (onstart?.failed) process.exitCode = 1;
  return {
    ...out,
    onstart: onstart ? onstart.line : "present",
    ...(onstart && onstart.tail.length > 0
      ? { onstart_log: onstart.tail }
      : {}),
    help: [
      ...(out["help"] as string[]),
      ...(onstart?.failed
        ? [
            `The instance is kept. Read more with \`vast-axi job ${id} --name ${ONSTART_JOB} --tail 100\`, fix the setup and rerun it with \`vast-axi run ${id} -- <cmd>\``,
          ]
        : [
            `\`vast-axi status ${id} --wait\` waits for the onstart job; \`vast-axi job ${id} --name ${ONSTART_JOB}\` shows its log`,
          ]),
    ],
  };
}

/** Factory so tests can inject the ssh spawner; real runs use `command`. */
export function createStatusCommand(deps: StatusDeps = {}): VastCommand {
  return (args) => runStatus(args, deps);
}

export const command: VastCommand = createStatusCommand();
