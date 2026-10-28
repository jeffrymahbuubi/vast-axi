// `vast-axi run <id> -- <cmd...>`: start a long program on the instance that
// survives ssh, with an exit marker `job` and `finish` can trust (Phase 1 plan).
import {
  assertKnownFlags,
  takeBoolFlag,
  takeFlag,
  takePositional,
} from "../args.js";
import {
  assertNoExtra,
  parseInstanceId,
  requireEndpoint,
} from "../endpoint.js";
import { AxiError } from "../errors.js";
import { buildHelp } from "../help.js";
import {
  DEFAULT_CWD,
  DEFAULT_NAME,
  buildLaunchScript,
  newToken,
  parseCwd,
  parseJobName,
  resolveRemotePath,
} from "../job.js";
import { describeJob, runProbe, stateHelp, type JobDeps } from "./job.js";
import type { VastCommand } from "./types.js";

const USAGE =
  "vast-axi run <id> [--name <n>] [--cwd <dir>] [--log <path>] [--overwrite] -- <cmd...>";
const TAIL_LINES = 10;

export const help = buildHelp({
  usage: USAGE,
  summary:
    "Start a program on the instance that keeps running after ssh disconnects (nohup + setsid), logging to a file with an exit marker.",
  flags: [
    `--name <n>   job name (default ${DEFAULT_NAME}); letters, digits, _ . -`,
    `--cwd <dir>  absolute working directory (default ${DEFAULT_CWD}); must exist; / and /root are refused`,
    "--log <path>  log file (default <cwd>/run.log); relative paths resolve against --cwd",
    "--overwrite  reuse a log file that already exists (it is truncated)",
  ],
  notes: [
    "Everything after `--` is joined with spaces and run by `bash -c`, the same as `ssh --exec`.",
    "Follow it with `vast-axi job <id>` (state, exit code, log tail) and `vast-axi finish <id> --wait --fetch ... --destroy`.",
    "Use this instead of nohup/screen by hand; `logs` shows only the container log, not this program's output.",
  ],
  examples: [
    "vast-axi run 42 --cwd /workspace/proj -- python train.py --epochs 3",
    "vast-axi run 42 --name prep --log /workspace/prep.log -- 'bash prep.sh | tee out.txt'",
  ],
});

/** Factory so tests can inject the spawner; real runs use the default below. */
export function createRunCommand(deps: JobDeps = {}): VastCommand {
  return async (args) => {
    assertKnownFlags(args, ["--name", "--cwd", "--log", "--overwrite"], "run");
    // Everything after `--` is the program, never a flag of ours.
    const sep = args.indexOf("--");
    const words = sep >= 0 ? args.splice(sep).slice(1) : [];
    const name = parseJobName(takeFlag(args, "--name") ?? DEFAULT_NAME);
    const cwd = parseCwd(takeFlag(args, "--cwd") ?? DEFAULT_CWD);
    const logRaw = takeFlag(args, "--log");
    const overwrite = takeBoolFlag(args, "--overwrite");
    const id = parseInstanceId(takePositional(args, "id", `usage: ${USAGE}`));
    assertNoExtra(args, USAGE);
    const command = words.join(" ");
    if (command.trim() === "" || command.includes("\0")) {
      throw new AxiError("run needs a program after `--`", "VALIDATION_ERROR", [
        `usage: ${USAGE}`,
      ]);
    }
    const log = resolveRemotePath(logRaw ?? "run.log", cwd, "--log");

    const endpoint = await requireEndpoint(id);
    const result = await runProbe(
      deps,
      id,
      endpoint,
      buildLaunchScript(
        { name, token: newToken(), cwd, log, command, overwrite },
        TAIL_LINES,
      ),
    );

    switch (result.kind) {
      case "nocwd":
        throw new AxiError(
          `--cwd ${cwd} does not exist on #${id}`,
          "REMOTE_CWD_MISSING",
          [`Create it: \`vast-axi ssh ${id} --exec -- mkdir -p ${cwd}\``],
        );
      case "running":
        throw new AxiError(
          `job "${name}" is still running on #${id}`,
          "JOB_RUNNING",
          [
            `Check it: \`vast-axi job ${id} --name ${name}\``,
            "Pick another --name to run a second program",
          ],
        );
      case "logexists":
        throw new AxiError(
          `${log} already exists on #${id}; refusing to overwrite it`,
          "LOG_EXISTS",
          [
            "Add --overwrite to reuse (truncate) it",
            "Or choose another file with --log <path>",
          ],
        );
      case "logunwritable":
        throw new AxiError(
          `cannot write the log ${log} on #${id}`,
          "LOG_UNWRITABLE",
          ["Choose a writable path with --log <path>"],
        );
      case "jobs": {
        const rec = result.jobs[0]!;
        const view = describeJob(id, rec, TAIL_LINES);
        return {
          ...view,
          ...(rec.pid !== undefined ? { pid: rec.pid } : {}),
          help: stateHelp(id, rec),
        };
      }
      default:
        throw new AxiError(
          `unexpected reply while starting the job on #${id}: ${result.kind}`,
          "REMOTE_FAILED",
        );
    }
  };
}

export const command: VastCommand = createRunCommand();
