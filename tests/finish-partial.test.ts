import { afterEach, describe, expect, it, vi } from "vitest";
import { ok, type SpawnCall } from "./helpers/job-records.js";
import { runCli } from "./helpers/run-cli.js";
import {
  build,
  finished,
  listing,
  running,
  timerOf,
  vastCalls,
  withLog,
} from "./helpers/finish-world.js";

const place =
  (size: number) => (call: SpawnCall, put: (p: string, s: number) => void) => {
    put(call.args[call.args.length - 1]!, size);
    return ok();
  };

function spyStderr(): { text: () => string } {
  let text = "";
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    text += String(chunk);
    return true;
  }) as typeof process.stderr.write);
  return { text: () => text };
}

afterEach(() => vi.restoreAllMocks());

const FETCH = ["--fetch", "out/m.pt:./m.pt"];
const world = (extra = {}) => ({
  probes: [running],
  list: listing([5, "/workspace/out/m.pt"]),
  scp: place(5),
  ...extra,
});

describe("finish --fetch-partial", () => {
  it("E156: without --fetch it is a usage error (exit 2) and nothing runs", async () => {
    const w = build(world());
    const out = await runCli(["finish", "42", "--fetch-partial"], {
      registry: w.registry,
    });
    expect(out.exitCode).toBe(2);
    expect(out.stdout).toContain(
      "--fetch-partial needs at least one --fetch <remote>:<local>",
    );
    expect(w.calls).toHaveLength(0);
  });

  it("E156: a running job without --wait is fetched partially, exit 1, instance kept", async () => {
    const { log, env } = withLog();
    const w = build(world());
    const out = await runCli(
      ["finish", "42", ...FETCH, "--fetch-partial", "--destroy"],
      { registry: w.registry, env },
    );
    expect(out.exitCode).toBe(1);
    expect(w.scpCalls).toHaveLength(1);
    expect(out.stdout).toContain("state: running");
    expect(out.stdout).toContain("fetch[1]");
    expect(out.stdout).toContain("kept #42: job still running");
    expect(out.stdout).toContain(
      "job still running; partial fetch, files may be incomplete",
    );
    expect(vastCalls(log, "destroy")).toHaveLength(0);
  });

  it("E156: a partial fetch with an unverified row says so and still exits 1", async () => {
    const w = build(world({ scp: place(2) }));
    const out = await runCli(["finish", "42", ...FETCH, "--fetch-partial"], {
      registry: w.registry,
    });
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("Fix the fetch rows marked ok: no");
  });

  it("E156: without the flag, fetches given: nothing fetched and a hint names --fetch-partial", async () => {
    const w = build(world());
    const out = await runCli(["finish", "42", ...FETCH], {
      registry: w.registry,
    });
    expect(out.exitCode).toBe(1);
    expect(w.scpCalls).toHaveLength(0);
    expect(out.stdout).toContain("job still running; nothing fetched");
    expect(out.stdout).toContain("add --fetch-partial");
  });

  it("E156: without --fetch no --fetch-partial hint appears", async () => {
    const w = build(world());
    const out = await runCli(["finish", "42"], { registry: w.registry });
    expect(out.stdout).not.toContain("--fetch-partial");
  });

  it("E157: --timeout reached with --fetch-partial fetches and keeps the timeout prefix", async () => {
    const w = build(world());
    const out = await runCli(
      [
        "finish",
        "42",
        "--wait",
        "--poll",
        "30s",
        "--timeout",
        "60s",
        ...FETCH,
        "--fetch-partial",
      ],
      { registry: w.registry },
    );
    expect(out.exitCode).toBe(1);
    expect(w.sleeps).toEqual([30_000, 30_000]);
    expect(w.scpCalls).toHaveLength(1);
    expect(out.stdout).toContain(
      "timed out after 1m; job still running; partial fetch, files may be incomplete",
    );
  });

  it("E157: --timeout reached without --fetch-partial fetches nothing and offers the flag", async () => {
    const w = build(world());
    const out = await runCli(
      ["finish", "42", "--wait", "--poll", "30s", "--timeout", "60s", ...FETCH],
      { registry: w.registry },
    );
    expect(out.exitCode).toBe(1);
    expect(w.scpCalls).toHaveLength(0);
    expect(out.stdout).toContain(
      "timed out after 1m; job still running, nothing fetched",
    );
    expect(out.stdout).toContain("add --fetch-partial");
  });

  it("E156: a finished job is fetched in full as before; --fetch-partial changes nothing", async () => {
    const w = build(world({ probes: [finished()] }));
    const out = await runCli(["finish", "42", ...FETCH, "--fetch-partial"], {
      registry: w.registry,
    });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("finish: complete");
  });

  it("E159: --wait --fetch-partial stops 15 minutes before the timer and fetches, exit 1", async () => {
    const err = spyStderr();
    const w = build(
      world({ probes: [running, running, running], timer: timerOf(14 * 60) }),
    );
    const out = await runCli(
      ["finish", "42", "--wait", ...FETCH, "--fetch-partial", "--destroy"],
      { registry: w.registry },
    );
    expect(out.exitCode).toBe(1);
    // The timer is already inside the 15 minute margin: no sleep at all.
    expect(w.sleeps).toEqual([]);
    expect(w.scpCalls).toHaveLength(1);
    expect(out.stdout).toContain(
      "destroy timer due in 14m; partial fetch done; job still running",
    );
    expect(out.stdout).toContain("kept #42: job still running");
    expect(out.stdout).toContain("timer_warning:");
    expect(err.text()).toContain("finish 42: running, elapsed 5m (10:05Z)");
  });

  it("E159: a timer 40 minutes away caps the sleep so the loop wakes 15 minutes before it", async () => {
    // A real timer counts down, so the fake one shrinks as the clock sleeps.
    const holder: { sleeps?: number[] } = {};
    const w = build({
      ...world(),
      get timer() {
        const slept = (holder.sleeps ?? []).reduce((a, b) => a + b, 0);
        return timerOf(40 * 60 - slept / 1000);
      },
    });
    holder.sleeps = w.sleeps;
    const out = await runCli(
      ["finish", "42", "--wait", "--poll", "30m", ...FETCH, "--fetch-partial"],
      { registry: w.registry },
    );
    expect(out.exitCode).toBe(1);
    // poll 30m, but 40m - 15m = 25m to the rescue point
    expect(w.sleeps).toEqual([25 * 60_000]);
    expect(out.stdout).toContain(
      "destroy timer due in 15m; partial fetch done; job still running",
    );
  });

  it("E159: without --fetch-partial the wait is not cut short", async () => {
    const w = build(
      world({ probes: [running, finished()], timer: timerOf(14 * 60) }),
    );
    await runCli(["finish", "42", "--wait", "--poll", "30m", ...FETCH], {
      registry: w.registry,
    });
    expect(w.sleeps).toEqual([30 * 60_000]);
  });
  const rescueWorld = (later: () => ReturnType<typeof timerOf> | undefined) => {
    const holder: { sleeps?: number[] } = {};
    const base = world({ probes: [running, running, finished()] });
    const w = build({
      ...base,
      get timer() {
        return (holder.sleeps?.length ?? 0) === 0 ? timerOf(40 * 60) : later();
      },
    });
    holder.sleeps = w.sleeps;
    return w;
  };
  const RESCUE_ARGS = ["finish", "42", "--wait", "--poll", "30m", ...FETCH];

  it("E167: a timer extended mid-wait is re-read at the rescue point: no early fetch, wait completes", async () => {
    const err = spyStderr();
    const w = rescueWorld(() => timerOf(3 * 3600));
    const out = await runCli([...RESCUE_ARGS, "--fetch-partial"], {
      registry: w.registry,
    });
    expect(out.exitCode).toBe(0);
    // 25m to the old rescue point, then a normal poll; the job finishes on probe 3.
    expect(w.sleeps).toEqual([25 * 60_000, 30 * 60_000]);
    expect(w.scpCalls).toHaveLength(1);
    expect(out.stdout).not.toContain("partial fetch done");
    expect(out.stdout).toContain("finish: complete");
    expect(err.text()).toContain(
      "finish 42: destroy timer moved to 2026-10-20T17:00Z; still waiting",
    );
  });

  it("E168: a timer removed mid-wait keeps the wait going and it completes", async () => {
    const err = spyStderr();
    const w = rescueWorld(() => undefined);
    const out = await runCli([...RESCUE_ARGS, "--fetch-partial"], {
      registry: w.registry,
    });
    expect(out.exitCode).toBe(0);
    expect(w.sleeps).toEqual([25 * 60_000, 30 * 60_000]);
    expect(out.stdout).not.toContain("partial fetch done");
    expect(out.stdout).toContain("finish: complete");
    expect(err.text()).toContain(
      "finish 42: destroy timer removed; still waiting",
    );
  });

  it("E169: a timer unchanged at the rescue point still triggers the partial fetch", async () => {
    const err = spyStderr();
    const w = rescueWorld(() => timerOf(15 * 60));
    const out = await runCli([...RESCUE_ARGS, "--fetch-partial"], {
      registry: w.registry,
    });
    expect(out.exitCode).toBe(1);
    expect(w.sleeps).toEqual([25 * 60_000]);
    expect(w.scpCalls).toHaveLength(1);
    expect(out.stdout).toContain(
      "destroy timer due in 15m; partial fetch done; job still running",
    );
    expect(err.text()).not.toContain("still waiting");
  });
});
