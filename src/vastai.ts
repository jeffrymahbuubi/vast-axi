import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { extname } from "node:path";
import {
  errorFromBody,
  mapVastError,
  outputTooLargeError,
  parseError,
  parseUpstreamError,
  timeoutError,
  vastNotInstalledError,
  versionHint,
  type UpstreamError,
} from "./errors.js";

/** Subprocess ceiling per call; `VAST_AXI_TIMEOUT_MS` overrides it (tests). */
export const DEFAULT_TIMEOUT_MS = 60_000;
export const MAX_BUFFER_BYTES = 10 * 1024 * 1024; // 10 MB

/** Result of one subprocess run before any classification. */
export interface RawExec {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Set when the process could not run to completion. */
  failure?: "ENOENT" | "EINVAL" | "TIMEOUT" | "MAXBUFFER";
}

export interface RunnerOptions {
  timeoutMs: number;
  maxBuffer: number;
  input?: string;
}

/** Runs the vastai binary with `argv` (global flags already included). Swappable in tests. */
export type VastRunner = (
  argv: string[],
  opts: RunnerOptions,
) => Promise<RawExec>;

export interface VastOptions {
  timeoutMs?: number;
  maxBuffer?: number;
  /** Text written to the child's stdin before it is closed (default: nothing). */
  input?: string;
  /** Prepend `--raw --retry 1` (default true). */
  globalFlags?: boolean;
  runner?: VastRunner;
}

/** stdout and stderr of a finished call, plus the upstream error object if stderr held one. */
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  upstreamError?: UpstreamError;
}

/**
 * Where to find vastai: `VAST_AXI_BIN` or PATH. A .js/.cjs/.mjs target (the
 * test fake) runs under this node, because Windows has no shebang support.
 */
function resolveBinary(): { command: string; prefix: string[] } | undefined {
  const bin = process.env["VAST_AXI_BIN"];
  if (!bin) return { command: "vastai", prefix: [] };
  if ([".js", ".cjs", ".mjs"].includes(extname(bin).toLowerCase())) {
    return existsSync(bin)
      ? { command: process.execPath, prefix: [bin] }
      : undefined;
  }
  return { command: bin, prefix: [] };
}

/** The real runner: execFile, no shell, stdin closed, UTF-8 forced on the Python side. */
export const spawnRunner: VastRunner = (argv, opts) =>
  new Promise((resolve) => {
    const bin = resolveBinary();
    if (!bin) {
      resolve({ stdout: "", stderr: "", exitCode: 127, failure: "ENOENT" });
      return;
    }
    const child = execFile(
      bin.command,
      [...bin.prefix, ...argv],
      {
        timeout: opts.timeoutMs,
        maxBuffer: opts.maxBuffer,
        windowsHide: true,
        encoding: "utf8",
        env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
      },
      (error, stdout, stderr) => {
        const result = { stdout: stdout ?? "", stderr: stderr ?? "" };
        if (!error) {
          resolve({ ...result, exitCode: 0 });
          return;
        }
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          resolve({ ...result, exitCode: 127, failure: "ENOENT" });
        } else if (code === "EINVAL" || code === "EACCES") {
          resolve({ ...result, exitCode: 126, failure: "EINVAL" });
        } else if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          resolve({ ...result, exitCode: 1, failure: "MAXBUFFER" });
        } else if (error.killed) {
          resolve({ ...result, exitCode: 1, failure: "TIMEOUT" });
        } else {
          resolve({
            ...result,
            exitCode: typeof code === "number" ? code : 1,
          });
        }
      },
    );
    // A child that exits before reading stdin must not crash us with EPIPE.
    child.stdin?.on("error", () => {});
    child.stdin?.end(opts.input ?? "");
  });

function timeoutMs(opts: VastOptions): number {
  const fromEnv = Number(process.env["VAST_AXI_TIMEOUT_MS"]);
  return opts.timeoutMs ?? (fromEnv > 0 ? fromEnv : DEFAULT_TIMEOUT_MS);
}

/**
 * Run vastai and return everything it said, without judging the exit code or
 * stderr. Only process-level failures throw (not installed, timeout, buffer),
 * so `raw` can render whatever came back. Upstream error objects on stderr are
 * parsed into `upstreamError` even when the exit code is 0 (A2).
 */
export async function vastRaw(
  args: string[],
  opts: VastOptions = {},
): Promise<ExecResult> {
  const runner = opts.runner ?? spawnRunner;
  const limit = timeoutMs(opts);
  const maxBuffer = opts.maxBuffer ?? MAX_BUFFER_BYTES;
  const argv =
    opts.globalFlags === false ? args : ["--raw", "--retry", "1", ...args];
  const run = await runner(argv, {
    timeoutMs: limit,
    maxBuffer,
    ...(opts.input !== undefined ? { input: opts.input } : {}),
  });
  if (run.failure === "ENOENT") throw vastNotInstalledError();
  if (run.failure === "EINVAL") {
    throw vastNotInstalledError(
      "VAST_AXI_BIN cannot be executed (use an .exe, or a .js/.cjs script)",
    );
  }
  if (run.failure === "TIMEOUT") throw timeoutError(limit);
  if (run.failure === "MAXBUFFER") throw outputTooLargeError(maxBuffer);
  const upstreamError = parseUpstreamError(run.stderr);
  return {
    stdout: run.stdout,
    stderr: run.stderr,
    exitCode: run.exitCode,
    ...(upstreamError ? { upstreamError } : {}),
  };
}

/**
 * Run vastai and return stdout as text (for `stop`, `destroy`, `logs`, which
 * print plain text under --raw). An upstream error object or a non-zero exit
 * throws the mapped AxiError.
 */
export async function vastExec(
  args: string[],
  opts: VastOptions = {},
): Promise<string> {
  const result = await vastRaw(args, opts);
  if (result.upstreamError) throw mapVastError(result.upstreamError);
  if (result.exitCode !== 0) {
    const msg =
      result.stderr.trim() || `vastai exited with code ${result.exitCode}`;
    throw mapVastError({ status: null, msg });
  }
  return result.stdout;
}

/** Ask `vastai --version` once; undefined when it cannot be determined. */
async function probeVersion(opts: VastOptions): Promise<string | undefined> {
  try {
    const result = await vastRaw(["--version"], {
      ...opts,
      globalFlags: false,
      timeoutMs: 5_000,
    });
    return /(\d+\.\d+\.\d+)/.exec(result.stdout + result.stderr)?.[1];
  } catch {
    return undefined;
  }
}

/**
 * Run a JSON-returning command (`search offers`, `show instances`,
 * `show instance`, `show user`, `create instance`) and parse stdout. A JSON
 * body that is itself an error object is mapped like a stderr one. Output
 * that is not JSON is UPSTREAM_PARSE_ERROR, and only then is the version
 * probed (E5, E7).
 */
export async function vastJson<T = unknown>(
  args: string[],
  opts: VastOptions = {},
): Promise<T> {
  const stdout = await vastExec(args, opts);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    const found = await probeVersion(opts);
    throw parseError(stdout, found ? versionHint(found) : undefined);
  }
  const bodyError = errorFromBody(parsed);
  if (bodyError) throw mapVastError(bodyError);
  return parsed as T;
}
