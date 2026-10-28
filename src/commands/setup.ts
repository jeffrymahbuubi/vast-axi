import { installSessionStartHooks, sessionStartHookStatus } from "axi-sdk-js";
import { assertKnownFlags } from "../args.js";
import { AxiError, mapVastError, redactSecrets } from "../errors.js";
import { buildHelp } from "../help.js";
import { vastRaw, type VastRunner } from "../vastai.js";
import type { VastCommand } from "./types.js";

const MARKER = "vast-axi";
const KEY_USAGE = "vast-axi setup key <key>";

export const help = buildHelp({
  usage: "vast-axi setup hooks | vast-axi setup key <key>",
  summary: "One-time setup. Nothing here runs unless you ask for it.",
  flags: [
    "hooks       install the SessionStart hook so each agent session opens with the dashboard (Claude Code, Codex, OpenCode)",
    "key <key>   store your vast.ai API key by forwarding it to `vastai set api-key`; the key is never printed",
  ],
  notes: [
    "the hook runs `vast-axi` at every session start, which makes 2 vast.ai API calls",
    "hooks must be installed from the installed `vast-axi` binary, not a dev checkout",
    "the key lands in ~/.config/vastai/vast_api_key; VAST_API_KEY in the environment also works",
  ],
  examples: ["vast-axi setup hooks", "vast-axi setup key <key>"],
});

export interface SetupDeps {
  /** vastai runner for `setup key` (tests inject a fake; real runs spawn vastai). */
  runner?: VastRunner;
  /** Home directory the hook files are written under (tests pass a temp dir). */
  homeDir?: string;
  /** Entrypoint the hook should run (defaults to the running script). */
  execPath?: string;
}

function unknownAction(): AxiError {
  // The token is deliberately not echoed: a key pasted without `key` would leak.
  return new AxiError(
    "unknown setup action; use `hooks` or `key`",
    "VALIDATION_ERROR",
    [
      "vast-axi setup hooks",
      `${KEY_USAGE}`,
      "vast-axi setup --help lists both",
    ],
  );
}

function setupHooks(deps: SetupDeps) {
  const problems: string[] = [];
  const options = {
    marker: MARKER,
    binaryNames: [MARKER],
    distEntrypoints: [`dist/bin/${MARKER}.js`],
    onError: (message: string) => problems.push(message),
    ...(deps.homeDir ? { homeDir: deps.homeDir } : {}),
    ...(deps.execPath ? { execPath: deps.execPath } : {}),
  };
  installSessionStartHooks(options);
  const status = sessionStartHookStatus({
    marker: MARKER,
    ...(deps.homeDir ? { homeDir: deps.homeDir } : {}),
  });
  const integrations = [
    status.claude.installed && "Claude Code",
    status.codex.installed && "Codex",
    status.opencode.installed && "OpenCode",
  ].filter((name): name is string => typeof name === "string");
  if (integrations.length === 0) {
    throw new AxiError(
      "no SessionStart hook was installed",
      "HOOKS_NOT_INSTALLED",
      [
        ...problems.map((p) => redactSecrets(p)),
        "Run `vast-axi setup hooks` from the installed binary (release tarball: see `vast-axi update --check`), not from a dev checkout",
      ],
    );
  }
  return {
    hooks: { status: "installed", integrations: integrations.join(", ") },
    help: [
      "Restart your agent session to see the vast-axi dashboard at session start",
      "Each session start makes 2 vast.ai API calls (show user, show instances)",
    ],
  };
}

async function setupKey(args: string[], deps: SetupDeps) {
  if (args.length === 0) {
    throw new AxiError("Missing <key>", "VALIDATION_ERROR", [
      `usage: ${KEY_USAGE}`,
    ]);
  }
  // Neither the key nor the extra tokens are echoed: any of them might be a key.
  if (args.length > 1 || args[0]!.startsWith("-")) {
    throw new AxiError(
      "setup key takes exactly one value (the key)",
      "VALIDATION_ERROR",
      [`usage: ${KEY_USAGE}`],
    );
  }
  const key = args[0]!;
  const scrub = (text: string) =>
    redactSecrets(text.split(key).join("<redacted>"));
  const result = await vastRaw(["set", "api-key", key], {
    ...(deps.runner ? { runner: deps.runner } : {}),
  });
  if (result.upstreamError) {
    // Upstream text may quote the key; scrub it before mapping.
    throw mapVastError({
      ...result.upstreamError,
      msg: scrub(result.upstreamError.msg),
    });
  }
  if (result.exitCode !== 0) {
    const detail = scrub(result.stderr.trim().split(/\r?\n/)[0] ?? "");
    throw new AxiError(
      `vastai could not store the key${detail ? `: ${detail.slice(0, 200)}` : ""}`,
      "SETUP_FAILED",
      ["Run `vast-axi raw set api-key --help` for what vastai expects"],
    );
  }
  return {
    key: { status: "saved", via: "vastai set api-key" },
    help: ["Run `vast-axi` to check that the key works"],
  };
}

/** Factory so tests can inject the home directory and runner; real runs use the default below. */
export function createSetupCommand(deps: SetupDeps = {}): VastCommand {
  return async (args) => {
    const [action, ...rest] = args;
    // E20: a flag where the action belongs. A key is never flag-shaped (it is hex).
    if (action?.startsWith("-")) assertKnownFlags(args, [], "setup");
    if (action === "hooks") {
      assertKnownFlags(rest, [], "setup hooks");
      if (rest.length > 0) {
        throw new AxiError(
          "setup hooks takes no arguments",
          "VALIDATION_ERROR",
          ["usage: vast-axi setup hooks"],
        );
      }
      return setupHooks(deps);
    }
    if (action === "key") return setupKey(rest, deps);
    throw unknownAction();
  };
}

export const command: VastCommand = createSetupCommand();
