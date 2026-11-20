// Finding a real local bash for the tests that run generated scripts under it.
import { spawn, spawnSync } from "node:child_process";
import { delimiter, dirname, join } from "node:path";
import { findOnPath } from "../../src/transfer.js";

export const WIN = process.platform === "win32";

/** Git Bash on Windows (never System32\bash.exe, the WSL launcher); bash on PATH elsewhere. */
export function findBash(): string | undefined {
  const env = process.env["VAST_AXI_TEST_BASH"];
  const candidates: string[] = env ? [env] : [];
  if (WIN) {
    const git = findOnPath("git");
    if (git)
      candidates.push(join(dirname(git), "..", "usr", "bin", "bash.exe"));
    candidates.push("C:\\Program Files\\Git\\usr\\bin\\bash.exe");
  } else {
    const found = findOnPath("bash");
    if (found) candidates.push(found);
  }
  return candidates.find((c) => {
    const r = spawnSync(c, ["-c", "echo ok"], { encoding: "utf8" });
    return r.status === 0 && r.stdout.trim() === "ok";
  });
}

/** `C:\a\b` to `/c/a/b` for Git Bash; unchanged elsewhere. */
export function bashPath(p: string): string {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  return WIN && m ? `/${m[1]!.toLowerCase()}/${m[2]!.replace(/\\/g, "/")}` : p;
}

/** The body a `cat > <target> <<'DELIM'` heredoc in `launcher` writes (it always ends with a newline). */
export function heredocBody(launcher: string, target: string): string {
  const lines = launcher.split("\n");
  const start = lines.findIndex(
    (l) => l.startsWith(`cat > "$d/${target}" <<'`) && l.endsWith("'"),
  );
  if (start < 0) throw new Error(`no cat heredoc for ${target}`);
  const delim = lines[start]!.slice(lines[start]!.indexOf("<<'") + 3, -1);
  const end = lines.indexOf(delim, start + 1);
  return `${lines.slice(start + 1, end).join("\n")}\n`;
}

/**
 * The env with the directory of `bash` first on PATH, so a nested `bash -c`
 * in a script resolves to the same bash. On Windows a PowerShell PATH lists
 * System32\bash.exe (the WSL launcher) before Git Bash.
 */
function bashFirstOnPath(
  env: NodeJS.ProcessEnv,
  bash: string,
): NodeJS.ProcessEnv {
  // Windows only: elsewhere dirname(bash) is /usr/bin, and putting it first
  // would shadow the shims (fake python3, setsid) a test puts on PATH.
  if (!WIN) return env;
  const key =
    Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const dir = dirname(bash);
  const parts = (env[key] ?? "").split(delimiter);
  // A test that already placed the bash dir (after its shims) keeps its order.
  if (parts.some((p) => p.toLowerCase() === dir.toLowerCase())) return env;
  return { ...env, [key]: [dir, ...parts].join(delimiter) };
}

/** Async bash run: never blocks the vitest worker (spawnSync starves its RPC heartbeat). */
export function runBash(
  bash: string,
  args: string[],
  opts: { input?: string; env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bash, args, {
      env: bashFirstOnPath(opts.env ?? process.env, bash),
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.on("error", () => undefined);
    child.stdin.end(opts.input ?? "");
  });
}
