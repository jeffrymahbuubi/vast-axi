// Global test guard (vitest setupFiles): no unit test may start the real ssh or
// scp. Fixture instances carry documentation addresses, and a real ssh client
// dialing them is outbound traffic that antivirus tools flag. A test that needs
// ssh injects a fake spawner (`spawn` / `resolveTool` deps) instead.
// The blocked spawn throws, and since vast-axi maps spawn errors to tool
// errors (which some paths tolerate), every attempt is also recorded and
// fails the test in afterEach, so a regression can never pass silently.
import { afterEach, vi } from "vitest";

const attempts = vi.hoisted(() => [] as string[]);

vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const blocked = /(^|[\\/])(ssh|scp)(\.exe)?$/i;
  const spawn = ((file: string, ...rest: unknown[]) => {
    if (blocked.test(String(file))) {
      attempts.push(String(file));
      throw new Error(
        `test tried to start the real ${String(file)}; inject a fake spawner (tests/helpers/no-real-ssh.ts)`,
      );
    }
    return (real.spawn as (...a: unknown[]) => unknown)(file, ...rest);
  }) as typeof real.spawn;
  return { ...real, spawn, default: { ...real, spawn } };
});

afterEach(() => {
  if (attempts.length === 0) return;
  const seen = attempts.splice(0).join(", ");
  throw new Error(
    `this test started the real ssh/scp (${seen}); inject a fake spawner`,
  );
});
