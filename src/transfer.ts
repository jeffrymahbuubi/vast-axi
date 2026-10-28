// Building and running the local tools `ssh` and `scp` (KTD8): copy-location
// parsing, the scp argument builder, display quoting, and the spawner that
// tests replace so no real ssh or scp ever starts.
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { delimiter, join, posix } from "node:path";
import { AxiError } from "./errors.js";
import type { Endpoint } from "./endpoint.js";
import { truncate } from "./format.js";

/** Result of one finished ssh or scp run. */
export interface ToolRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Starts `file` with `args` (no shell) and waits for it. With `capture` the
 * output is collected and stdin is closed; without it the child inherits the
 * terminal (an interactive `ssh --exec`).
 */
export type ToolSpawner = (
  file: string,
  args: string[],
  opts: { capture: boolean },
) => Promise<ToolRun>;

/**
 * E110 backstop: a tool that cannot be executed (EINVAL for a `.cmd` shim,
 * EACCES) gets a structured error with a hint, not a bare spawn error.
 */
function startError(file: string, error: unknown): unknown {
  const code = (error as NodeJS.ErrnoException).code;
  if (code !== "EINVAL" && code !== "EACCES") return error;
  return new AxiError(
    `could not start ${file} (${code})`,
    "TRANSFER_TOOL_MISSING",
    [installHint(), "Then rerun the same command"],
  );
}

export const spawnTool: ToolSpawner = (file, args, opts) =>
  new Promise((resolve, reject) => {
    let child;
    try {
      // Node throws EINVAL synchronously for a .cmd/.bat file without a shell.
      child = spawn(file, args, {
        shell: false,
        windowsHide: true,
        stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit",
      });
    } catch (error) {
      reject(startError(file, error));
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", (error) => reject(startError(file, error)));
    child.on("close", (code) =>
      resolve({ exitCode: code ?? 1, stdout, stderr }),
    );
  });

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Windows batch shims, which `spawn` without a shell cannot start (EINVAL). */
const SHIM = /\.(cmd|bat)$/i;

/**
 * Absolute path of `name` on PATH (honouring PATHEXT on Windows), or
 * undefined. With `skipShims`, `.cmd`/`.bat` matches are passed over.
 */
export function findOnPath(
  name: string,
  opts: { skipShims?: boolean } = {},
): string | undefined {
  const dirs = (process.env["PATH"] ?? "").split(delimiter).filter(Boolean);
  const exts =
    process.platform === "win32"
      ? ["", ...(process.env["PATHEXT"] ?? ".EXE;.CMD;.BAT").split(";")]
      : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (opts.skipShims && SHIM.test(candidate)) continue;
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

function installHint(): string {
  return process.platform === "win32"
    ? "Install the OpenSSH client: Settings > System > Optional features > OpenSSH Client"
    : "Install the OpenSSH client (for example `apt install openssh-client`)";
}

/**
 * E23: resolve `ssh` or `scp`, or fail with an install hint instead of a raw
 * ENOENT. E110: a `.cmd`/`.bat` shim is skipped, because spawning it without
 * a shell fails with EINVAL; a later real executable on PATH is used instead.
 */
export function requireTool(name: "ssh" | "scp"): string {
  const found = findOnPath(name, { skipShims: true });
  if (found) return found;
  const shim = findOnPath(name);
  if (shim) {
    throw new AxiError(
      `\`${name}\` on PATH is a batch shim (${shim}) that vast-axi cannot run`,
      "TRANSFER_TOOL_MISSING",
      [installHint(), `Or put a real ${name}.exe ahead of the shim on PATH`],
    );
  }
  throw new AxiError(
    `\`${name}\` was not found on PATH`,
    "TRANSFER_TOOL_MISSING",
    [installHint(), "Then rerun the same command"],
  );
}

/** Where a `copy` argument points. */
export type Location =
  | { kind: "local"; path: string }
  | { kind: "instance"; id: number; path: string }
  | { kind: "other"; raw: string };

/**
 * Parse one side of `copy`. `local:<path>` and bare paths (including a
 * Windows drive such as `C:\data`) are local; `C.<id>:<path>` and the legacy
 * `<id>:<path>` are instances; anything else with a colon (`s3.101:`,
 * `drive:`, `V.1234:`) is a cloud or volume locator that only `vastai copy`
 * understands.
 */
export function parseLocation(raw: string): Location {
  if (raw.startsWith("local:")) {
    return { kind: "local", path: raw.slice("local:".length) };
  }
  if (/^[A-Za-z]:[\\/]/.test(raw)) return { kind: "local", path: raw };
  const instance = /^(?:C\.)?(\d+):(.*)$/s.exec(raw);
  if (instance) {
    return { kind: "instance", id: Number(instance[1]), path: instance[2]! };
  }
  if (raw.includes(":")) return { kind: "other", raw };
  return { kind: "local", path: raw };
}

/**
 * Upstream warns that writing to `/` or `/root` breaks the instance's ssh
 * keys (R13). Normalise first so `/root/`, `//` and `/root/.` are caught,
 * and treat an empty path or `~` as the home directory, which is `/root`.
 */
export function assertSafeDestination(path: string): void {
  const p = path.trim();
  const normal = posix.normalize(p === "" ? "~" : p);
  const flat = normal.length > 1 ? normal.replace(/\/+$/, "") : normal;
  if (["/", "/root", ".", "~"].includes(flat)) {
    throw new AxiError(
      `refusing to copy into "${path || "(empty)"}": writing to / or /root breaks ssh access to the instance`,
      "VALIDATION_ERROR",
      ["Pick a subdirectory, for example `C.<id>:/workspace/data`"],
    );
  }
}

/** scp would read `a:b` as host `a`; a leading `./` keeps a local path local. */
function scpLocalPath(path: string): string {
  const isDrive = /^[A-Za-z]:[\\/]/.test(path);
  return path.includes(":") && !isDrive ? `./${path}` : path;
}

/**
 * The scp argument vector for a local <-> instance copy:
 * `-P <port> -o StrictHostKeyChecking=accept-new -o BatchMode=yes -r src dst`.
 * BatchMode plus a closed stdin means scp can never stop to ask for a
 * password or a host-key answer. `direction` says which side is remote.
 */
export function buildScpArgs(
  direction: "up" | "down",
  endpoint: Endpoint,
  localPath: string,
  remotePath: string,
): string[] {
  const remote = `root@${endpoint.host}:${remotePath}`;
  const local = scpLocalPath(localPath);
  return [
    "-P",
    String(endpoint.port),
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "BatchMode=yes",
    "-r",
    ...(direction === "up" ? [local, remote] : [remote, local]),
  ];
}

export type QuoteStyle = "posix" | "powershell";

const SAFE = /^[A-Za-z0-9_@%+=:,./\\-]+$/;

/**
 * Quote one argument for a human to paste. Both Git Bash and PowerShell
 * accept single quotes; they differ only in how an embedded quote is written
 * (`'\''` versus `''`).
 */
export function quoteArg(arg: string, style: QuoteStyle): string {
  if (arg !== "" && SAFE.test(arg)) return arg;
  const inner =
    style === "powershell"
      ? arg.replace(/'/g, "''")
      : arg.replace(/'/g, `'\\''`);
  return `'${inner}'`;
}

/** The shell the user most likely pastes into: bash when SHELL is set, else PowerShell on Windows. */
export function defaultQuoteStyle(): QuoteStyle {
  if (process.env["SHELL"]) return "posix";
  return process.platform === "win32" ? "powershell" : "posix";
}

/**
 * Render `file args...` as one pasteable line. This is display only: the
 * commands are always started from an argument array with `shell: false`
 * (spawnTool), so a path with spaces reaches scp as one argument on every
 * shell and no quoting can go wrong at run time.
 */
export function renderCommand(
  file: string,
  args: string[],
  style: QuoteStyle = defaultQuoteStyle(),
): string {
  return [file, ...args.map((a) => quoteArg(a, style))].join(" ");
}

/**
 * The argv for one non-interactive `ssh` run (no shell). BatchMode makes ssh
 * fail rather than ask for a password or a host-key answer; accept-new records
 * a first-seen host key without prompting. `ssh --exec` and `status --live`
 * both go through here.
 */
export function buildSshArgs(endpoint: Endpoint, remote: string[]): string[] {
  return [
    "-p",
    String(endpoint.port),
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "BatchMode=yes",
    `root@${endpoint.host}`,
    ...remote,
  ];
}

/**
 * Run `remote` on an instance over ssh with captured output. Exit 255 is ssh's
 * own failure (no connection, no key), reported as SSH_FAILED; any other exit
 * code is the remote command's and is returned to the caller.
 */
export async function runSsh(
  spawn: ToolSpawner,
  sshPath: string,
  id: number,
  endpoint: Endpoint,
  remote: string[],
): Promise<{ run: ToolRun; sshArgs: string[] }> {
  const sshArgs = buildSshArgs(endpoint, remote);
  const run = await spawn(sshPath, sshArgs, { capture: true });
  if (run.exitCode === 255) {
    throw new AxiError(
      `ssh could not connect to #${id}: ${truncate(run.stderr.trim(), 300) || "connection failed"}`,
      "SSH_FAILED",
      [
        `Run \`vast-axi status ${id}\` to check the instance is running`,
        "The account needs an ssh key attached on vast.ai for key login to work",
      ],
    );
  }
  return { run, sshArgs };
}
