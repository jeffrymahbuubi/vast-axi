import { afterEach, describe, expect, it, vi } from "vitest";
import { build, finished, sshDown } from "./helpers/finish-world.js";
import { ok, record } from "./helpers/job-records.js";
import { runCli } from "./helpers/run-cli.js";

const running = (now: string) =>
  ok(record({ alive: true, start: "2026-10-20T08:00:00Z", now }));

function spyStderr(): { lines: () => string } {
  let text = "";
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    text += String(chunk);
    return true;
  }) as typeof process.stderr.write);
  return { lines: () => text };
}

afterEach(() => vi.restoreAllMocks());

describe("finish --wait heartbeat", () => {
  it("E98: one stderr line per poll while running; stdout is only the result", async () => {
    const err = spyStderr();
    const w = build({
      probes: [
        running("2026-10-20T10:14:00Z"),
        running("2026-10-20T12:29:00Z"),
        finished(),
      ],
    });
    const out = await runCli(["finish", "42", "--wait"], {
      registry: w.registry,
    });
    expect(out.exitCode).toBe(0);
    const lines = err.lines().trimEnd().split("\n");
    expect(lines).toEqual([
      "finish 42: running, elapsed 2h14m (10:14Z)",
      "finish 42: running, elapsed 4h29m (12:29Z)",
    ]);
    expect(out.stdout).toContain("state: finished");
    expect(out.stdout).not.toContain("finish 42: running");
    expect(out.stdout).not.toContain("elapsed 2h14m");
  });

  it("E98: stdout is identical with and without the heartbeat", async () => {
    const quiet = build({ probes: [finished()] });
    const a = await runCli(["finish", "42", "--wait"], {
      registry: quiet.registry,
    });
    const err = spyStderr();
    const loud = build({
      probes: [running("2026-10-20T10:14:00Z"), finished()],
    });
    const b = await runCli(["finish", "42", "--wait"], {
      registry: loud.registry,
    });
    expect(b.stdout).toBe(a.stdout);
    expect(err.lines()).toContain("finish 42: running");
  });

  it("E98: no heartbeat without --wait", async () => {
    const err = spyStderr();
    const w = build({ probes: [running("2026-10-20T10:14:00Z")] });
    const out = await runCli(["finish", "42"], { registry: w.registry });
    expect(out.exitCode).toBe(1);
    expect(err.lines()).toBe("");
  });

  it("E98: a transient ssh failure while waiting writes a retry line", async () => {
    const err = spyStderr();
    const w = build({ probes: [sshDown, finished()] });
    await runCli(["finish", "42", "--wait", "--poll", "30s"], {
      registry: w.registry,
    });
    expect(err.lines()).toBe("finish 42: ssh failed, will retry\n");
  });
});
