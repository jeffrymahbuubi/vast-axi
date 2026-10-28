// `vast-axi finish <id>`: wait for a `run` job to end, fetch its results with
// verification, and destroy the instance only when it is safe (OQ21-OQ23).
import { mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import {
  assertKnownFlags,
  takeBoolFlag,
  takeFlag,
  takePositional,
} from "../args.js";
import { cleanupDestroyTimers, type TimerCleanup } from "../destroy-timer.js";
import {
  assertNoExtra,
  fetchInstance,
  parseInstanceId,
  requireEndpoint,
  type Endpoint,
} from "../endpoint.js";
import { AxiError, redactSecrets } from "../errors.js";
import { formatDuration, truncate } from "../format.js";
import { buildHelp } from "../help.js";
import { classifyInstance } from "../instance-state.js";
import {
  DEFAULT_CWD,
  buildProbeScript,
  buildRemoteCommand,
  jobStatus,
  parseDuration,
  parseFetchSpec,
  resolveRemotePath,
  type JobRecord,
} from "../job.js";
import {
  buildListScript,
  expectedLocalFiles,
  parseListOutput,
  verifyFetch,
  type LocalStat,
} from "../job-fetch.js";
import {
  buildScpArgs,
  requireTool,
  runSsh,
  spawnTool,
  type ToolSpawner,
} from "../transfer.js";
import { destroyInstance } from "./destroy.js";
import { ONSTART_JOB } from "../onstart.js";
import { describeJob, pickJob, runProbe, selectorFrom } from "./job.js";
import type { VastCommand, VastOutput } from "./types.js";

const USAGE =
  "vast-axi finish <id> [--name <n> | --log <path>] [--wait] [--poll <dur>] [--timeout <dur>] [--fetch <remote>:<local> ...] [--destroy]";
const DEFAULT_POLL = "15m";
const MIN_POLL_MS = 30_000;
const TAIL_LINES = 10;
/** Consecutive ssh failures before the instance itself is checked (E45). */
const SSH_STRIKES = 3;
/** Instance checks that find it running while ssh still fails, before giving up. */
const MAX_CHECKS = 3;

export const help = buildHelp({
  usage: USAGE,
  summary:
    "Wrap up a program started with `run`: wait for it, fetch results, verify them, and optionally destroy the instance.",
  flags: [
    "--name <n> | --log <path>  which job (default name main)",
    "--wait             poll until the job ends instead of exiting 1 while it runs",
    `--poll <dur>       poll interval for --wait: 30s, 15m, 2h (default ${DEFAULT_POLL}, minimum 30s)`,
    "--timeout <dur>    give up waiting after this long (exit 1); no default",
    "--fetch <remote>:<local>  copy a remote file or directory down (repeatable); relative remote paths resolve against the job's cwd; split at the first colon so C:\\dir works",
    "--destroy          destroy the instance, only if the job finished with exit 0 and every fetch verified",
  ],
  notes: [
    "Exit 0 only when the job finished with code 0, every requested fetch verified and a requested destroy was done; otherwise 1.",
    "Fetches also run for a failed or lost job; the instance is then kept.",
    "Verified = every remote file exists locally with the same byte size and the target is more than 0 bytes.",
    "With --wait, one progress line per poll goes to stderr (state, elapsed, time of the probe); stdout stays the single result.",
    "--wait for hours can outlast an agent's tool timeout: run it in the background, or loop `finish` without --wait.",
  ],
  examples: [
    "vast-axi finish 42 --wait --fetch out/model.pt:./model.pt --destroy",
    "vast-axi finish 42 --name prep --fetch /workspace/out:C:\\results\\out",
  ],
});

/** Injectable time source so `--wait` tests run in milliseconds. */
export interface FinishClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface FinishDeps {
  spawn?: ToolSpawner;
  resolveTool?: (name: "ssh" | "scp") => string;
  clock?: FinishClock;
  stat?: (path: string) => LocalStat | undefined;
  mkdirp?: (path: string) => void;
}

const realClock: FinishClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

function realStat(path: string): LocalStat | undefined {
  try {
    const s = statSync(path);
    return { size: s.size, isDirectory: s.isDirectory() };
  } catch {
    return undefined;
  }
}

/** One `--wait` progress line for stderr: job state, elapsed and the probe's UTC time. */
function heartbeat(id: number, rec: JobRecord): string {
  const s = jobStatus(rec);
  const at = /T(\d\d:\d\d)/.exec(rec.now ?? "")?.[1];
  return `finish ${id}: ${s.state}${s.elapsed ? `, elapsed ${s.elapsed}` : ""}${at ? ` (${at}Z)` : ""}\n`;
}

/** E46: three ssh failures in a row; a missing, stopped or terminal instance will never answer. */
async function assertInstanceAlive(id: number): Promise<void> {
  const inst = await fetchInstance(id);
  const state = inst ? classifyInstance(inst) : undefined;
  if (state && (state.class === "running" || state.class === "booting")) return;
  throw new AxiError(
    inst
      ? `instance #${id} is ${inst.actual_status ?? "unknown"}; the job cannot finish there`
      : `instance #${id} no longer exists`,
    "INSTANCE_GONE",
    [
      "Anything not already copied off the instance is gone",
      "Run `vast-axi status` to see your instances",
    ],
  );
}

interface FetchRow {
  remote: string;
  local: string;
  files: number;
  bytes: number;
  ok: "yes" | "no";
  note: string;
}

async function fetchAll(
  deps: FinishDeps,
  id: number,
  endpoint: Endpoint,
  cwd: string,
  specs: Array<{ remote: string; local: string }>,
): Promise<FetchRow[]> {
  const spawn = deps.spawn ?? spawnTool;
  const resolveTool = deps.resolveTool ?? requireTool;
  const stat = deps.stat ?? realStat;
  const mkdirp =
    deps.mkdirp ?? ((p: string) => void mkdirSync(p, { recursive: true }));
  const remotes = specs.map((s) => resolveRemotePath(s.remote, cwd, "--fetch"));
  const { run } = await runSsh(spawn, resolveTool("ssh"), id, endpoint, [
    buildRemoteCommand(buildListScript(remotes)),
  ]);
  const listings = parseListOutput(run.stdout, specs.length);
  const scp = resolveTool("scp");

  const rows: FetchRow[] = [];
  for (const [i, spec] of specs.entries()) {
    const remote = remotes[i]!;
    const listing = listings[i]!;
    const row = (v: Partial<FetchRow>): FetchRow => ({
      remote,
      local: spec.local,
      files: 0,
      bytes: 0,
      ok: "no",
      note: "",
      ...v,
    });
    if (listing.absent) {
      rows.push(row({ note: "not found on the instance" }));
      continue;
    }
    if (listing.files.length === 0) {
      rows.push(row({ note: "no files at the remote path" }));
      continue;
    }
    const before = stat(spec.local);
    mkdirp(dirname(spec.local));
    const copy = await spawn(
      scp,
      buildScpArgs("down", endpoint, spec.local, remote),
      { capture: true },
    );
    if (copy.exitCode !== 0) {
      const why = redactSecrets(truncate(copy.stderr.trim(), 300));
      rows.push(
        row({
          files: listing.files.length,
          note: `scp failed: ${why || `exit ${copy.exitCode}`}`,
        }),
      );
      continue;
    }
    const verdict = verifyFetch(
      expectedLocalFiles(
        remote,
        listing.files,
        spec.local,
        before?.isDirectory === true,
      ),
      stat,
    );
    rows.push(
      row({
        files: verdict.files,
        bytes: verdict.bytes,
        ok: verdict.ok ? "yes" : "no",
        note: verdict.note,
      }),
    );
  }
  return rows;
}

/** The flags, parsed and validated before any network call. */
function parseArgs(args: string[]) {
  assertKnownFlags(
    args,
    [
      "--name",
      "--log",
      "--wait",
      "--poll",
      "--timeout",
      "--fetch",
      "--destroy",
    ],
    "finish",
  );
  const sel = selectorFrom(args);
  const wait = takeBoolFlag(args, "--wait");
  const pollRaw = takeFlag(args, "--poll");
  const timeoutRaw = takeFlag(args, "--timeout");
  const fetches: Array<{ remote: string; local: string }> = [];
  for (let v = takeFlag(args, "--fetch"); v !== undefined;) {
    fetches.push(parseFetchSpec(v));
    v = takeFlag(args, "--fetch");
  }
  const destroy = takeBoolFlag(args, "--destroy");
  const id = parseInstanceId(takePositional(args, "id", `usage: ${USAGE}`));
  assertNoExtra(args, USAGE);
  if (!wait && (pollRaw !== undefined || timeoutRaw !== undefined)) {
    throw new AxiError(
      "--poll and --timeout only apply with --wait",
      "VALIDATION_ERROR",
    );
  }
  return {
    sel,
    wait,
    poll: parseDuration(pollRaw ?? DEFAULT_POLL, "--poll", MIN_POLL_MS),
    timeout:
      timeoutRaw !== undefined
        ? parseDuration(timeoutRaw, "--timeout")
        : undefined,
    fetches,
    destroy,
    id,
  };
}

/** Factory so tests can inject the spawner, clock and filesystem; real runs use `command`. */
export function createFinishCommand(deps: FinishDeps = {}): VastCommand {
  const clock = deps.clock ?? realClock;
  return async (args): Promise<VastOutput> => {
    const { sel, wait, poll, timeout, fetches, destroy, id } = parseArgs(args);
    const endpoint = await requireEndpoint(id);
    const startedAt = clock.now();
    const probe = buildProbeScript(sel, TAIL_LINES);
    const flags = (name: string) => (name === "main" ? "" : ` --name ${name}`);

    let rec: JobRecord | undefined;
    let strikes = 0;
    let checks = 0;
    for (;;) {
      try {
        rec = pickJob(await runProbe(deps, id, endpoint, probe), id, sel);
        strikes = 0;
        if (jobStatus(rec).state !== "running") break;
        if (wait) process.stderr.write(heartbeat(id, rec));
      } catch (error) {
        const transient =
          wait && error instanceof AxiError && error.code === "SSH_FAILED";
        if (!transient) throw error;
        process.stderr.write(`finish ${id}: ssh failed, will retry\n`);
        if (++strikes >= SSH_STRIKES) {
          await assertInstanceAlive(id);
          if (++checks >= MAX_CHECKS) throw error;
          strikes = 0;
        }
      }
      const elapsed = clock.now() - startedAt;
      const n = flags(rec?.name ?? "main");
      if (!wait || (timeout !== undefined && elapsed >= timeout)) {
        if (!rec) {
          throw new AxiError(
            `timed out after ${formatDuration(elapsed / 1000)}; ssh to #${id} keeps failing`,
            "WAIT_TIMEOUT",
            [`Run \`vast-axi status ${id}\` to check the instance`],
          );
        }
        process.exitCode = 1;
        return {
          ...describeJob(id, rec, TAIL_LINES),
          finish: wait
            ? `timed out after ${formatDuration(elapsed / 1000)}; job still running, nothing fetched`
            : "job still running; nothing fetched",
          help: [
            `Wait for it with \`vast-axi finish ${id}${n} --wait${fetches.length ? " --fetch ..." : ""}\``,
            `Or check later with \`vast-axi job ${id}${n}\``,
          ],
        };
      }
      const left = timeout !== undefined ? timeout - elapsed : poll;
      await clock.sleep(Math.min(poll, left));
    }

    const status = jobStatus(rec!);
    const job = rec!;
    const rows = fetches.length
      ? await fetchAll(deps, id, endpoint, job.cwd ?? DEFAULT_CWD, fetches)
      : [];
    const fetchOk = rows.every((r) => r.ok === "yes");

    let destroyLine: string | undefined;
    let destroyed = false;
    let timers: TimerCleanup = { fields: {}, help: [] };
    if (destroy) {
      const reason =
        status.state !== "finished"
          ? status.state === "failed"
            ? `job failed (exit ${status.exitCode})`
            : "job lost (no exit recorded)"
          : !fetchOk
            ? `${rows.filter((r) => r.ok !== "yes").length} fetch(es) not verified`
            : undefined;
      if (reason) {
        destroyLine = `kept #${id}: ${reason}`;
      } else {
        try {
          await destroyInstance(id);
          destroyed = true;
          destroyLine = `#${id} destroyed`;
          // Best effort, never throws: a leftover `rent --max-hours` timer goes too.
          timers = await cleanupDestroyTimers([id]);
        } catch (error) {
          const why = error instanceof Error ? error.message : String(error);
          destroyLine = `kept #${id}: destroy failed: ${truncate(why, 200)}`;
        }
      }
    }

    const complete =
      status.state === "finished" && fetchOk && (!destroy || destroyed);
    if (!complete) process.exitCode = 1;
    const n = flags(job.name);
    return {
      ...describeJob(id, job, TAIL_LINES),
      ...(rows.length ? { fetch: rows } : {}),
      ...(destroyLine ? { destroy: destroyLine } : {}),
      ...timers.fields,
      finish: complete ? "complete" : "incomplete",
      help: [
        ...timers.help,
        ...(status.state !== "finished"
          ? [
              `Job ${status.state}: read more with \`vast-axi job ${id}${n} --tail 100\`; the instance was kept`,
            ]
          : []),
        ...(rows.some((r) => r.ok !== "yes")
          ? [
              "Fix the fetch rows marked ok: no (see note), then rerun `vast-axi finish` with the same --fetch",
            ]
          : []),
        ...(!destroyed && job.name === ONSTART_JOB
          ? [
              `#${id} is still running and billing; start your main job with \`vast-axi run ${id} -- <cmd>\``,
            ]
          : []),
        ...(!destroyed && job.name !== ONSTART_JOB
          ? [
              `#${id} is still running and billing; \`vast-axi destroy ${id}\` when done, or rerun with --destroy`,
            ]
          : []),
      ],
    };
  };
}

export const command: VastCommand = createFinishCommand();
