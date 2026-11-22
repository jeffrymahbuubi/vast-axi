// Pure builder for the child_process guard used by tests/helpers/no-real-ssh.ts.
// Kept free of vitest so tests/no-real-ssh.test.ts can build its own guard over
// fake functions: no process can start, and the global guard records nothing.
import { promisify } from "node:util";

export const GUARD_MARK = Symbol.for("vast-axi.ssh-guard");

const BLOCKED = /^(ssh|scp)(\.exe|\.com)?$/i;

type AnyFn = (...args: unknown[]) => unknown;

/** The slice of node:child_process the guard wraps. */
export interface RealChildProcess {
  spawn: AnyFn;
  spawnSync: AnyFn;
  execFile: AnyFn;
  execFileSync: AnyFn;
  exec: AnyFn;
  execSync: AnyFn;
}

function baseName(file: string): string {
  return file.split(/[\\/]/).pop() ?? "";
}

/** True when `file` is the ssh or scp client (any directory, any case). */
export function isBlockedFile(file: unknown): boolean {
  return BLOCKED.test(baseName(String(file).trim()));
}

/** True when the first word of a shell command line is ssh or scp. */
export function isBlockedCommand(line: unknown): boolean {
  const text = String(line).trim();
  const first = /^(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(text);
  const word = first ? (first[1] ?? first[2] ?? first[3] ?? "") : "";
  return isBlockedFile(word);
}

export function makeGuard(real: RealChildProcess) {
  const attempts: string[] = [];

  const block = (what: string): never => {
    attempts.push(what);
    throw new Error(
      `test tried to start the real ${what}; inject a fake spawner (tests/helpers/no-real-ssh.ts)`,
    );
  };

  const byFile = (fn: AnyFn): AnyFn =>
    function (this: unknown, file: unknown, ...rest: unknown[]) {
      if (isBlockedFile(file)) block(String(file));
      return fn.call(this, file, ...rest);
    };
  const byCommand = (fn: AnyFn): AnyFn =>
    function (this: unknown, line: unknown, ...rest: unknown[]) {
      if (isBlockedCommand(line)) block(String(line));
      return fn.call(this, line, ...rest);
    };

  const spawn = byFile(real.spawn);
  Object.defineProperty(spawn, GUARD_MARK, { value: true });
  const spawnSync = byFile(real.spawnSync);
  const execFileSync = byFile(real.execFileSync);
  const execFile = byFile(real.execFile);
  const exec = byCommand(real.exec);
  const execSync = byCommand(real.execSync);

  // Keep promisify(execFile) / promisify(exec) resolving { stdout, stderr }.
  const custom = promisify.custom as symbol;
  const pairs: [AnyFn, AnyFn, (fn: AnyFn) => AnyFn][] = [
    [execFile, real.execFile, byFile],
    [exec, real.exec, byCommand],
  ];
  for (const [wrapped, original, guard] of pairs) {
    const orig = (original as unknown as Record<symbol, AnyFn | undefined>)[
      custom
    ];
    if (orig) {
      Object.defineProperty(wrapped, custom, {
        // A blocked promisified call rejects, as a failed real one would.
        value: (...args: unknown[]) => {
          try {
            return guard(orig)(...args);
          } catch (error) {
            return Promise.reject(error);
          }
        },
        configurable: true,
      });
    }
  }

  return {
    spawn,
    spawnSync,
    execFile,
    execFileSync,
    exec,
    execSync,
    attempts,
    /** Throw if any blocked start was attempted since the last check. */
    check(): void {
      if (attempts.length === 0) return;
      const seen = attempts.splice(0).join(", ");
      throw new Error(
        `this test started the real ssh/scp (${seen}); inject a fake spawner`,
      );
    },
  };
}
