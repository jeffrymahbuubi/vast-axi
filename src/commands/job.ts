// `vast-axi job <id>`: state, exit code, elapsed time and log tail of a
// program started with `run`, read in one ssh call (Phase 1 plan).
import {
  assertKnownFlags,
  takeBoolFlag,
  takeFlag,
  takeNumberFlag,
  takePositional,
} from "../args.js";
import {
  assertNoExtra,
  parseInstanceId,
  requireEndpoint,
  type Endpoint,
} from "../endpoint.js";
import { AxiError, redactSecrets } from "../errors.js";
import { byteSize, truncate } from "../format.js";
import { buildHelp } from "../help.js";
import {
  DEFAULT_NAME,
  buildProbeScript,
  buildRemoteCommand,
  cleanTail,
  jobStatus,
  parseJobName,
  parseProbeOutput,
  type JobRecord,
  type ProbeResult,
  type Selector,
} from "../job.js";
import { ONSTART_JOB } from "../onstart.js";
import { emptyState } from "../toon.js";
import {
  requireTool,
  runSsh,
  spawnTool,
  type ToolSpawner,
} from "../transfer.js";
import { posix } from "node:path";
import type { VastCommand } from "./types.js";

const USAGE =
  "vast-axi job <id> [--name <n> | --log <path>] [--tail <n>] [--list]";
const DEFAULT_TAIL = 20;
const MAX_TAIL = 500;

export const help = buildHelp({
  usage: USAGE,
  summary:
    "State of a program started with `run`: running, finished, failed or lost, its exit code, elapsed time and log tail. One ssh call.",
  flags: [
    `--name <n>   job name (default ${DEFAULT_NAME})`,
    "--log <path>  select the job by its log path instead of its name",
    `--tail <n>   log lines to show (default ${DEFAULT_TAIL}, max ${MAX_TAIL}); each cut to 400 characters`,
    "--list       every job on the instance as a table",
  ],
  notes: [
    "finished = exit code 0, failed = non-zero, lost = the wrapper died (container restart or kill) with no exit recorded.",
    "Finished is decided only by this run's exit marker in the log, never by the ssh session.",
  ],
  examples: [
    "vast-axi job 42",
    "vast-axi job 42 --name train --tail 50",
    "vast-axi job 42 --list",
  ],
});

export interface JobDeps {
  spawn?: ToolSpawner;
  resolveTool?: (name: "ssh") => string;
}

/** `--name` / `--log` to a probe selector; they exclude each other. */
export function selectorFrom(args: string[]): Selector {
  const name = takeFlag(args, "--name");
  const log = takeFlag(args, "--log");
  if (name !== undefined && log !== undefined) {
    throw new AxiError(
      "--name and --log cannot be combined",
      "VALIDATION_ERROR",
      ["Select the job by one of them"],
    );
  }
  if (log !== undefined) {
    if (/[\0\r\n]/.test(log)) {
      throw new AxiError("--log must be a single line", "VALIDATION_ERROR");
    }
    return { kind: "log", log: posix.normalize(log) };
  }
  return { kind: "name", name: parseJobName(name ?? DEFAULT_NAME) };
}

/** Run one remote script and parse it; a missing tool or silent remote becomes an error. */
export async function runProbe(
  deps: JobDeps,
  id: number,
  endpoint: Endpoint,
  script: string,
): Promise<ProbeResult> {
  const { run } = await runSsh(
    deps.spawn ?? spawnTool,
    (deps.resolveTool ?? requireTool)("ssh"),
    id,
    endpoint,
    [buildRemoteCommand(script)],
  );
  const result = parseProbeOutput(run.stdout);
  if (result.kind === "missing") {
    throw new AxiError(
      `\`${result.tool}\` is not installed on #${id}`,
      "REMOTE_TOOL_MISSING",
      ["Install it on the instance (bash, coreutils, util-linux for setsid)"],
    );
  }
  if (result.kind === "empty") {
    throw new AxiError(
      `the remote script on #${id} printed nothing usable (exit ${run.exitCode}): ${redactSecrets(truncate(run.stderr.trim(), 300)) || "no output"}`,
      "REMOTE_FAILED",
      [
        `Run \`vast-axi ssh ${id} --exec -- bash --version\` to check the shell`,
      ],
    );
  }
  return result;
}

export function notFound(id: number, sel: Selector): AxiError {
  const which =
    sel.kind === "log"
      ? `log ${sel.log}`
      : `name ${sel.kind === "name" ? sel.name : ""}`;
  return new AxiError(`no job with ${which} on #${id}`, "JOB_NOT_FOUND", [
    `Run \`vast-axi job ${id} --list\` to see the jobs on this instance`,
  ]);
}

/** Pick the one record for a selector (the newest if several jobs share a log). */
export function pickJob(
  result: ProbeResult,
  id: number,
  sel: Selector,
): JobRecord {
  if (result.kind !== "jobs") throw notFound(id, sel);
  return [...result.jobs].sort((a, b) =>
    (b.start ?? "").localeCompare(a.start ?? ""),
  )[0]!;
}

/** The fields `run`, `job` and `finish` all print for one job. */
export function describeJob(
  id: number,
  rec: JobRecord,
  tailLines: number,
): Record<string, unknown> {
  const status = jobStatus(rec);
  const tail = cleanTail(rec, tailLines);
  const log = rec.hasLog
    ? `${rec.log ?? "?"} (${byteSize(rec.size ?? 0)})`
    : `${rec.log ?? "?"} (missing)`;
  return {
    job: `${rec.name} (#${id})`,
    state: status.state,
    ...(status.exitCode !== undefined ? { exit_code: status.exitCode } : {}),
    ...(rec.start ? { started: rec.start } : {}),
    ...(status.ended ? { ended: status.ended } : {}),
    ...(status.elapsed ? { elapsed: status.elapsed } : {}),
    log,
    ...(rec.cwd ? { cwd: rec.cwd } : {}),
    ...(rec.cmd ? { cmd: redactSecrets(truncate(rec.cmd, 400)) } : {}),
    ...(tail.length > 0 ? { tail } : {}),
  };
}

/**
 * The setup job `rent --onstart/--pip` leaves behind. Its hints never offer
 * `finish --destroy`: that would tear the instance down right after setup.
 */
function onstartHelp(id: number, rec: JobRecord): string[] {
  const read = `vast-axi job ${id} --name ${ONSTART_JOB} --tail 100`;
  switch (jobStatus(rec).state) {
    case "running":
      return [
        `Check again with \`vast-axi job ${id} --name ${ONSTART_JOB}\``,
        `Or wait for setup with \`vast-axi status ${id} --wait\``,
      ];
    case "finished":
      return [
        `Setup is done; start your main job with \`vast-axi run ${id} -- <cmd>\``,
      ];
    case "failed":
      return [
        `Setup failed; read its log with \`${read}\`, fix the script, and rerun it with \`vast-axi run ${id} --name ${ONSTART_JOB} --overwrite -- <cmd>\`; the instance is kept`,
      ];
    case "lost":
      return [
        "Setup stopped without recording an exit (container restart or killed); the instance is kept",
        `Read its log with \`${read}\`, then rerun the setup with \`vast-axi run ${id} --name ${ONSTART_JOB} --overwrite -- <cmd>\``,
      ];
  }
}

/** Next-step hints by state, shared with `run`. */
export function stateHelp(id: number, rec: JobRecord): string[] {
  if (rec.name === ONSTART_JOB) return onstartHelp(id, rec);
  const n = rec.name === DEFAULT_NAME ? "" : ` --name ${rec.name}`;
  const finish = `vast-axi finish ${id}${n} --wait --fetch <remote>:<local> --destroy`;
  switch (jobStatus(rec).state) {
    case "running":
      return [
        `Check again with \`vast-axi job ${id}${n}\``,
        `Block until it ends, fetch results and destroy with \`${finish}\``,
      ];
    case "finished":
      return [`Fetch results and tear down with \`${finish}\``];
    case "failed":
      return [
        `Fetch what it left with \`vast-axi finish ${id}${n} --fetch <remote>:<local>\`; the instance is kept`,
        `Fix and rerun with \`vast-axi run ${id}${n} --overwrite -- <cmd>\``,
      ];
    case "lost":
      return [
        "The program stopped without recording an exit (container restart or killed); the instance is kept",
        `Rerun with \`vast-axi run ${id}${n} --overwrite -- <cmd>\``,
      ];
  }
}

/** Factory so tests can inject the spawner; real runs use the default below. */
export function createJobCommand(deps: JobDeps = {}): VastCommand {
  return async (args) => {
    assertKnownFlags(args, ["--name", "--log", "--tail", "--list"], "job");
    const list = takeBoolFlag(args, "--list");
    const tail =
      takeNumberFlag(args, "--tail", { min: 1, integer: true }) ?? DEFAULT_TAIL;
    if (tail > MAX_TAIL) {
      throw new AxiError(
        `--tail must be at most ${MAX_TAIL}, got ${tail}`,
        "VALIDATION_ERROR",
      );
    }
    const selected = args.some(
      (a) =>
        a === "--name" ||
        a === "--log" ||
        a.startsWith("--name=") ||
        a.startsWith("--log="),
    );
    if (list && selected) {
      throw new AxiError(
        "--list cannot be combined with --name or --log",
        "VALIDATION_ERROR",
      );
    }
    const sel: Selector = list ? { kind: "all" } : selectorFrom(args);
    const id = parseInstanceId(takePositional(args, "id", `usage: ${USAGE}`));
    assertNoExtra(args, USAGE);

    const endpoint = await requireEndpoint(id);
    const result = await runProbe(
      deps,
      id,
      endpoint,
      buildProbeScript(sel, list ? 0 : tail),
    );

    if (list) {
      if (result.kind !== "jobs") {
        return emptyState("jobs", `0 jobs on #${id}`, [
          `Start one with \`vast-axi run ${id} -- <cmd>\``,
        ]);
      }
      return {
        jobs: result.jobs.map((rec) => {
          const s = jobStatus(rec);
          return {
            name: rec.name,
            state: s.state,
            exit: s.exitCode ?? null,
            elapsed: s.elapsed ?? null,
            log: rec.log ?? null,
          };
        }),
        help: [`Details: \`vast-axi job ${id} --name <name>\``],
      };
    }

    const rec = pickJob(result, id, sel);
    return { ...describeJob(id, rec, tail), help: stateHelp(id, rec) };
  };
}

export const command: VastCommand = createJobCommand();
