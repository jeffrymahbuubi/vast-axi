import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { main, type MainOptions } from "../../src/cli.js";

export interface CliResult {
  stdout: string;
  exitCode: number;
}

export type Env = Record<string, string | undefined>;

/** Absolute path of the replay stand-in for `vastai`. */
export const FAKE_BIN = fileURLToPath(
  new URL("./fake-vastai.cjs", import.meta.url),
);

/**
 * Environment for tests that go through the real runner: VAST_AXI_BIN points at
 * the fake, the user's config and any spend/fake variables are neutralised
 * (undefined deletes a variable), and `extra` overrides on top.
 */
export function fakeEnv(extra: Env = {}): Env {
  return {
    VAST_AXI_BIN: FAKE_BIN,
    VAST_API_KEY: "test-key-not-real",
    VAST_AXI_CONFIG: join(tmpdir(), "vast-axi-tests-no-such-config.json"),
    VAST_AXI_MAX_DPH: undefined,
    VAST_AXI_MAX_BURN: undefined,
    VAST_AXI_IDLE_MINUTES: undefined,
    VAST_AXI_TIMEOUT_MS: undefined,
    FAKE_VASTAI_SCENARIO: undefined,
    FAKE_VASTAI_ROUTES: undefined,
    FAKE_VASTAI_LOG: undefined,
    FAKE_VASTAI_VERSION: undefined,
    ...extra,
  };
}

/** A fresh call-log path for FAKE_VASTAI_LOG. */
export function newCallLog(): string {
  return join(mkdtempSync(join(tmpdir(), "vast-axi-test-")), "calls.jsonl");
}

export interface FakeCall {
  /** Full argv as the fake received it, including `--raw --retry 1`. */
  argv: string[];
  /** Leading non-flag tokens, for example ["search", "offers"]. */
  tokens: string[];
  /** The matched route key, or null. */
  route: string | null;
}

/** Calls the fake has answered so far, oldest first (empty when none ran). */
export function readCallLog(path: string): FakeCall[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FakeCall);
}

/** Apply `env` to process.env, run `fn`, then restore. Use it to call vastExec/vastJson directly. */
export async function withEnv<T>(env: Env, fn: () => Promise<T>): Promise<T> {
  const saved: Env = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/**
 * Run the CLI in-process with captured stdout, against the fake vastai
 * (see fakeEnv; `opts.env` overrides it). process.exitCode is captured and
 * restored.
 */
export async function runCli(
  argv: string[],
  opts: { env?: Env; registry?: MainOptions["registry"] } = {},
): Promise<CliResult> {
  const previousExit = process.exitCode;
  process.exitCode = undefined;
  let stdout = "";
  try {
    await withEnv(fakeEnv(opts.env), () =>
      main({
        argv,
        stdout: {
          write: (chunk) => {
            stdout += chunk;
            return true;
          },
        },
        ...(opts.registry ? { registry: opts.registry } : {}),
      }),
    );
    return { stdout, exitCode: Number(process.exitCode ?? 0) };
  } finally {
    process.exitCode = previousExit;
  }
}
