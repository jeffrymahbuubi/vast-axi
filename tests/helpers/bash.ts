// Finding a real local bash for the tests that run generated scripts under it.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
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
