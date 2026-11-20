// `vast-axi finish <id>`: wait for a `run` job to end, fetch its results with
// verification, and destroy the instance only when it is safe (OQ21-OQ23).
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
} from "../endpoint.js";
import { AxiError } from "../errors.js";
import { formatDuration, truncate } from "../format.js";
import { buildHelp } from "../help.js";
import { classifyInstance } from "../instance-state.js";
import {
  DEFAULT_CWD,
  buildProbeScript,
  jobStatus,
  parseDuration,
  parseFetchSpec,
  type JobRecord,
} from "../job.js";
import { fetchAll, type FetchDeps } from "../finish-fetch.js";
import { timerNote, type TimerNote } from "../timer-note.js";
import { requireTool } from "../transfer.js";
import { destroyInstance } from "./destroy.js";
import { ONSTART_JOB } from "../onstart.js";
import { describeJob, pickJob, runProbe, selectorFrom } from "./job.js";
import type { VastCommand, VastOutput } from "./types.js";

const USAGE =
  "vast-axi finish <id> [--name <n> | --log <path>] [--wait] [--poll <dur>] [--timeout <dur>] [--fetch <remote>:<local> ...] [--fetch-partial] [--destroy]";
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
    "--fetch-partial    when the job is still running where finish gives up (no --wait, --timeout reached, or the destroy timer close), copy the --fetch paths anyway (files may be incomplete; exit 1; never destroys)",
    "--destroy          destroy the instance, only if the job finished with exit 0 and every fetch verified",
  ],
  notes: [
    "Exit 0 only when the job finished with code 0, every requested fetch verified and a requested destroy was done; otherwise 1.",
    "Fetches also run for a failed or lost job; the instance is then kept.",
    "A destroy timer (`rent --max-hours`) deletes the instance even while the job runs: finish prints timer_left and a warning when it is near; with --wait --fetch-partial it stops waiting 15 minutes before the timer and fetches.",
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

export interface FinishDeps extends FetchDeps {
  clock?: FinishClock;
  /** Test seam for the destroy-timer lookup. */
  timerNote?: (id: number, opts?: { withinSec?: number }) => Promise<TimerNote>;
}

const realClock: FinishClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** One `--wait` progress line for stderr: job state, elapsed and the probe's UTC time. */
function heartbeat(id: number, rec: JobRecord): string {
  const s = jobStatus(rec);
  const view = describeJob(id, rec, 0);
  const util = view["gpu_util_live"];
  const warning = view["gpu_warning"];
  const at = /T(\d\d:\d\d)/.exec(rec.now ?? "")?.[1];
  const line = `finish ${id}: ${s.state}${s.elapsed ? `, elapsed ${s.elapsed}` : ""}${typeof util === "number" ? `, gpu ${util}%` : ""}${at ? ` (${at}Z)` : ""}\n`;
  return typeof warning === "string"
    ? `${line}finish ${id}: ${warning}\n`
    : line;
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
      "--fetch-partial",
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
  const fetchPartial = takeBoolFlag(args, "--fetch-partial");
  const destroy = takeBoolFlag(args, "--destroy");
  const id = parseInstanceId(takePositional(args, "id", `usage: ${USAGE}`));
  assertNoExtra(args, USAGE);
  if (!wait && (pollRaw !== undefined || timeoutRaw !== undefined)) {
    throw new AxiError(
      "--poll and --timeout only apply with --wait",
      "VALIDATION_ERROR",
    );
  }
  if (fetchPartial && fetches.length === 0) {
    throw new AxiError(
      "--fetch-partial needs at least one --fetch <remote>:<local>",
      "VALIDATION_ERROR",
      ["Say what to copy: --fetch <remote>:<local>"],
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
    fetchPartial,
    destroy,
    id,
  };
}

/** `--wait --fetch-partial` stops waiting this long before the destroy timer. */
const RESCUE_MARGIN_MS = 15 * 60_000;

/** Factory so tests can inject the spawner, clock and filesystem; real runs use `command`. */
export function createFinishCommand(deps: FinishDeps = {}): VastCommand {
  const clock = deps.clock ?? realClock;
  const lookupTimer = deps.timerNote ?? timerNote;
  return async (args): Promise<VastOutput> => {
    const { sel, wait, poll, timeout, fetches, fetchPartial, destroy, id } =
      parseArgs(args);
    // N5: a missing ssh or scp client is reported before any upstream call.
    const resolveTool = deps.resolveTool ?? requireTool;
    resolveTool("ssh");
    if (fetches.length > 0) resolveTool("scp");
    const endpoint = await requireEndpoint(id);
    const withinSec =
      timeout !== undefined ? { withinSec: timeout / 1000 } : {};
    const startNote = await lookupTimer(id, withinSec);
    const startedAt = clock.now();
    let timerAtMs =
      startNote.leftSec !== undefined
        ? startedAt + startNote.leftSec * 1000
        : undefined;
    if (
      wait &&
      startNote.leftSec !== undefined &&
      (timeout === undefined || timeout / 1000 > startNote.leftSec)
    ) {
      process.stderr.write(
        `finish ${id}: destroy timer fires in ${startNote.fields["timer_left"]} (${startNote.fields["destroy_at"]}), before this wait can end; extend it with vast-axi timer ${id} --max-hours <n>\n`,
      );
    }
    let rescueAtMs =
      wait && fetchPartial && timerAtMs !== undefined
        ? timerAtMs - RESCUE_MARGIN_MS
        : undefined;
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
      const timedOut = timeout !== undefined && elapsed >= timeout;
      let rescue =
        !timedOut && rescueAtMs !== undefined && clock.now() >= rescueAtMs;
      if (rescue) {
        // The timer may have been extended or removed from another shell: re-read it.
        const fresh = await lookupTimer(id, withinSec);
        const nowMs = clock.now();
        if (
          fresh.leftSec === undefined ||
          fresh.leftSec * 1000 > RESCUE_MARGIN_MS
        ) {
          timerAtMs =
            fresh.leftSec !== undefined
              ? nowMs + fresh.leftSec * 1000
              : undefined;
          rescueAtMs =
            timerAtMs !== undefined ? timerAtMs - RESCUE_MARGIN_MS : undefined;
          process.stderr.write(
            fresh.leftSec === undefined
              ? `finish ${id}: destroy timer removed; still waiting
`
              : `finish ${id}: destroy timer moved to ${fresh.fields["destroy_at"]}; still waiting
`,
          );
          rescue = false;
        } else {
          timerAtMs = nowMs + fresh.leftSec * 1000;
        }
      }
      if (!wait || timedOut || rescue) {
        if (!rec) {
          throw new AxiError(
            `timed out after ${formatDuration(elapsed / 1000)}; ssh to #${id} keeps failing`,
            "WAIT_TIMEOUT",
            [`Run \`vast-axi status ${id}\` to check the instance`],
          );
        }
        const n = flags(rec.name);
        const rows = fetchPartial
          ? await fetchAll(deps, id, endpoint, rec.cwd ?? DEFAULT_CWD, fetches)
          : [];
        const note = await lookupTimer(id, withinSec);
        const dueIn = formatDuration(
          Math.max(0, ((timerAtMs ?? 0) - clock.now()) / 1000),
        );
        const stopped = rescue
          ? `destroy timer due in ${dueIn}`
          : timedOut
            ? `timed out after ${formatDuration(elapsed / 1000)}`
            : "";
        const finishLine = fetchPartial
          ? rescue
            ? `${stopped}; partial fetch done; job still running`
            : `${stopped ? `${stopped}; ` : ""}job still running; partial fetch, files may be incomplete`
          : timedOut
            ? `${stopped}; job still running, nothing fetched`
            : "job still running; nothing fetched";
        process.exitCode = 1;
        return {
          ...describeJob(id, rec, TAIL_LINES),
          ...(rows.length ? { fetch: rows } : {}),
          ...(fetchPartial && destroy
            ? { destroy: `kept #${id}: job still running` }
            : {}),
          ...note.fields,
          finish: finishLine,
          help: [
            ...note.help,
            `Wait for it with \`vast-axi finish ${id}${n} --wait${fetches.length ? " --fetch ..." : ""}\``,
            `Or check later with \`vast-axi job ${id}${n}\``,
            ...(fetches.length > 0 && !fetchPartial
              ? [
                  "Or copy what exists now: add --fetch-partial (files may be incomplete; the instance is kept)",
                ]
              : []),
            ...(rows.some((r) => r.ok !== "yes")
              ? ["Fix the fetch rows marked ok: no (see note)"]
              : []),
          ],
        };
      }
      const room = [
        poll,
        ...(timeout !== undefined ? [timeout - elapsed] : []),
        ...(rescueAtMs !== undefined ? [rescueAtMs - clock.now()] : []),
      ];
      await clock.sleep(Math.max(1, Math.min(...room)));
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
    // A kept instance still has its destroy timer: say when it fires.
    const kept: { fields: Record<string, string>; help: string[] } = destroyed
      ? { fields: {}, help: [] }
      : await lookupTimer(id, withinSec);

    const complete =
      status.state === "finished" && fetchOk && (!destroy || destroyed);
    if (!complete) process.exitCode = 1;
    const n = flags(job.name);
    return {
      ...describeJob(id, job, TAIL_LINES),
      ...(rows.length ? { fetch: rows } : {}),
      ...(destroyLine ? { destroy: destroyLine } : {}),
      ...timers.fields,
      ...kept.fields,
      finish: complete ? "complete" : "incomplete",
      help: [
        ...timers.help,
        ...kept.help,
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
