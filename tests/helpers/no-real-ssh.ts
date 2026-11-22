// Global test guard (vitest setupFiles): no unit test may start the real ssh or
// scp. Fixture instances carry documentation addresses, and a real ssh client
// dialing them is outbound traffic that antivirus tools flag. A test that needs
// ssh injects a fake spawner (`spawn` / `resolveTool` deps) instead.
// The blocked start throws, and since vast-axi maps spawn errors to tool
// errors (which some paths tolerate), every attempt is also recorded and
// fails the test in afterEach, so a regression can never pass silently.
// The wrapping logic lives in ./ssh-guard.ts; there is deliberately no export
// that clears the attempts.
import { afterEach, vi } from "vitest";
import type { makeGuard } from "./ssh-guard.js";

const guard = vi.hoisted(() => ({
  current: null as null | ReturnType<typeof makeGuard>,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const { makeGuard: build } = await import("./ssh-guard.js");
  const g = build(real as unknown as Parameters<typeof build>[0]);
  guard.current = g;
  const wrapped = {
    spawn: g.spawn,
    spawnSync: g.spawnSync,
    execFile: g.execFile,
    execFileSync: g.execFileSync,
    exec: g.exec,
    execSync: g.execSync,
  };
  return { ...real, ...wrapped, default: { ...real, ...wrapped } };
});

afterEach(() => {
  guard.current?.check();
});
