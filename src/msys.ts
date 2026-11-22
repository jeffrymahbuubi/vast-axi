// Detects arguments Git Bash (MSYS) rewrote into Windows paths before we saw them.
import { AxiError } from "./errors.js";

/** The same sentence as the hint in src/job.ts (I9). */
export const MSYS_HINT =
  "In Git Bash, run with MSYS_NO_PATHCONV=1 so /workspace/... is not rewritten to a Windows path";

const norm = (s: string) => s.replace(/\\/g, "/").toLowerCase();

function roots(): string[] {
  const out: string[] = [];
  if (process.platform !== "win32") return out;
  const exe = process.env["EXEPATH"];
  if (exe) {
    const dir = norm(exe).replace(/\/+$/, "");
    if (dir) out.push(`${dir}/`);
    if (dir.endsWith("/bin")) out.push(`${dir.slice(0, -4)}/`);
  }
  return out;
}

/**
 * OQ62: Git Bash on Windows (MSYSTEM set, path conversion not disabled)
 * rewrites /x into <root>/x; with an unknown root any drive-letter word is
 * suspect, so it is refused.
 */
function driveWordsSuspect(): boolean {
  return (
    process.platform === "win32" &&
    Boolean(process.env["MSYSTEM"]) &&
    !process.env["MSYS_NO_PATHCONV"]
  );
}

/** The first word holding a Git Bash root prefix, if any. */
export function findMangled(words: string[]): string | undefined {
  const extra = roots();
  const drive = driveWordsSuspect();
  return words.find((w) => {
    if (drive && /(^|=)[A-Za-z]:[\\/]/.test(w)) return true;
    if (/[A-Za-z]:[\\/]Program Files[\\/]Git[\\/]/i.test(w)) return true;
    const n = norm(w);
    return extra.some((r) => n.includes(r));
  });
}

export function assertNotMangled(words: string[], what: string): void {
  const bad = findMangled(words);
  if (bad === undefined) return;
  throw new AxiError(
    `${what} "${bad}" was rewritten by Git Bash into a Windows path`,
    "VALIDATION_ERROR",
    [MSYS_HINT, "Or pass the remote command as ONE quoted string"],
  );
}
