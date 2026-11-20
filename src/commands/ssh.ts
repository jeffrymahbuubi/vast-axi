import { assertKnownFlags, takeBoolFlag, takePositional } from "../args.js";
import {
  assertNoExtra,
  parseInstanceId,
  requireEndpoint,
} from "../endpoint.js";
import { AxiError } from "../errors.js";
import { truncate } from "../format.js";
import { buildHelp } from "../help.js";
import { assertNotMangled } from "../msys.js";
import { joinRemoteArgv } from "../remote-argv.js";
import {
  renderCommand,
  requireTool,
  runSsh,
  spawnTool,
  type ToolSpawner,
} from "../transfer.js";
import type { VastCommand } from "./types.js";

const USAGE = "vast-axi ssh <id> [--exec -- <remote command...>]";
const OUTPUT_CAP = 20_000;

export const help = buildHelp({
  usage: USAGE,
  summary:
    "Print the ssh command for an instance; with --exec, run it. Never prompts.",
  flags: [
    "--exec  run the remote command after `--` and capture its output (an interactive session is never opened)",
  ],
  notes: [
    "The host and port come from `show instance`; a direct instance uses its public ip and mapped 22/tcp port.",
    "For an interactive shell, run the printed ssh command yourself.",
    'With 2+ words after `--`, a word holding spaces, quotes or shell operators is quoted so it arrives as one argument; plain words (`*`, `~`, `$VAR`) still expand remotely. For pipes, `&&` or redirects pass ONE quoted string: --exec -- "cd /w && ls | head".',
  ],
  examples: ["vast-axi ssh 42", "vast-axi ssh 42 --exec -- nvidia-smi"],
});

export interface SshDeps {
  spawn?: ToolSpawner;
  resolveTool?: (name: "ssh") => string;
}

/** Factory so tests can inject the spawner; real runs use the default below. */
export function createSshCommand(deps: SshDeps = {}): VastCommand {
  const spawn = deps.spawn ?? spawnTool;
  const resolveTool = deps.resolveTool ?? requireTool;
  return async (args) => {
    assertKnownFlags(args, ["--exec"], "ssh");
    // Everything after `--` is the remote command, never a flag of ours.
    const sep = args.indexOf("--");
    const remote = sep >= 0 ? args.splice(sep).slice(1) : [];
    const exec = takeBoolFlag(args, "--exec");
    const id = parseInstanceId(takePositional(args, "id", `usage: ${USAGE}`));
    assertNoExtra(args, USAGE);
    if (remote.length > 0 && !exec) {
      throw new AxiError("a remote command needs --exec", "VALIDATION_ERROR", [
        `usage: ${USAGE}`,
      ]);
    }
    // An interactive session would block an agent forever (AXI: no prompts).
    if (exec && remote.length === 0) {
      throw new AxiError(
        "--exec needs a remote command after `--`",
        "VALIDATION_ERROR",
        [
          `usage: ${USAGE}`,
          `For an interactive shell, run the command from \`vast-axi ssh ${id}\` yourself`,
        ],
      );
    }

    if (exec) assertNotMangled(remote, "the remote command");
    // Resolve the tool first so a missing ssh costs no vastai call.
    const sshPath = exec ? resolveTool("ssh") : "";
    const endpoint = await requireEndpoint(id);
    const target = `root@${endpoint.host}`;
    const printed = renderCommand("ssh", ["-p", String(endpoint.port), target]);
    if (!exec) {
      return {
        instance: `#${id}`,
        ssh: printed,
        help: [
          `Run it as is, or \`vast-axi ssh ${id} --exec -- <command>\` to run one command`,
          `Move files with \`vast-axi copy local:<path> C.${id}:<path>\``,
        ],
      };
    }

    const { run, sshArgs } = await runSsh(spawn, sshPath, id, endpoint, [
      joinRemoteArgv(remote),
    ]);
    const output = truncate(run.stdout, OUTPUT_CAP);
    const stderr = run.stderr.trim();
    return {
      instance: `#${id}`,
      ssh: renderCommand("ssh", sshArgs),
      exit_code: run.exitCode,
      ...(output ? { output } : {}),
      ...(stderr ? { stderr: truncate(stderr, 2_000) } : {}),
      ...(run.exitCode !== 0 && !output && !stderr
        ? {
            help: [
              "The remote command printed nothing; for pipes, `&&` or redirects pass ONE quoted string after `--`",
            ],
          }
        : {}),
    };
  };
}

export const command: VastCommand = createSshCommand();
