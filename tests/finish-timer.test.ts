import { afterEach, describe, expect, it, vi } from "vitest";
import * as finish from "../src/commands/finish.js";
import { REGISTRY, type Registry } from "../src/commands/index.js";
import * as job from "../src/commands/job.js";
import * as run from "../src/commands/run.js";
import {
  ok,
  record,
  recordingSpawner,
  type SpawnCall,
} from "./helpers/job-records.js";
import { runCli } from "./helpers/run-cli.js";
import { build, finished, running, timerOf } from "./helpers/finish-world.js";

function spyStderr(): { text: () => string } {
  let text = "";
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    text += String(chunk);
    return true;
  }) as typeof process.stderr.write);
  return { text: () => text };
}

afterEach(() => vi.restoreAllMocks());

const NOTICE =
  "finish 42: destroy timer fires in 14m (2026-10-20T17:00Z), before this wait can end; extend it with vast-axi timer 42 --max-hours <n>\n";

describe("finish and the destroy timer", () => {
  it("E158: a timer that fires before an open-ended wait ends gets a stderr notice at start and a warning in the result", async () => {
    const err = spyStderr();
    const w = build({
      probes: [running, finished()],
      timer: timerOf(14 * 60),
    });
    const out = await runCli(["finish", "42", "--wait", "--poll", "30s"], {
      registry: w.registry,
    });
    expect(err.text().startsWith(NOTICE)).toBe(true);
    expect(out.stdout).not.toContain("before this wait can end");
    // finished and kept: the final result still carries the timer
    expect(out.stdout).toContain("destroy_at: ");
    expect(out.stdout).toContain("timer_left: 14m");
    expect(out.stdout).toContain(
      "destroy timer fires in 14m (2026-10-20T17:00Z)",
    );
    expect(out.stdout).toContain("vast-axi timer 42 --max-hours <n>");
  });

  it("E158: --timeout longer than the timer also warns; a shorter one does not, and is passed as withinSec", async () => {
    const err = spyStderr();
    const long = build({ probes: [finished()], timer: timerOf(14 * 60) });
    await runCli(["finish", "42", "--wait", "--timeout", "1h"], {
      registry: long.registry,
    });
    expect(err.text()).toContain("before this wait can end");
    expect(long.timerCalls[0]).toEqual({ withinSec: 3600 });
    vi.restoreAllMocks();

    const err2 = spyStderr();
    const short = build({ probes: [finished()], timer: timerOf(14 * 60) });
    await runCli(["finish", "42", "--wait", "--timeout", "10m"], {
      registry: short.registry,
    });
    expect(err2.text()).toBe("");
  });

  it("E158: no stderr notice without --wait", async () => {
    const err = spyStderr();
    const w = build({ probes: [running], timer: timerOf(14 * 60) });
    const out = await runCli(["finish", "42"], { registry: w.registry });
    expect(err.text()).toBe("");
    expect(out.stdout).toContain("timer_warning:");
    expect(out.stdout).toContain("job still running; nothing fetched");
  });

  it("E161: a far timer shows destroy_at and timer_left but no warning", async () => {
    const w = build({ probes: [running], timer: timerOf(6 * 3600) });
    const out = await runCli(["finish", "42"], { registry: w.registry });
    expect(out.stdout).toContain("timer_left: 6h");
    expect(out.stdout).not.toContain("timer_warning");
  });

  it("E160: no timer and a failing scheduled-job listing leave the result without timer keys", async () => {
    const { spawn } = recordingSpawner(() => ok(finished().stdout));
    const command = finish.createFinishCommand({
      spawn,
      resolveTool: (n) => n,
    });
    const registry: Registry = {
      home: REGISTRY.home,
      commands: {
        ...REGISTRY.commands,
        finish: { command, help: finish.help },
      },
    };
    const out = await runCli(["finish", "42"], {
      registry,
      env: {
        FAKE_VASTAI_ROUTES: JSON.stringify({
          "show scheduled-jobs": { stderr: "Traceback: boom\n", exit: 1 },
        }),
      },
    });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).not.toContain("destroy_at");
    expect(out.stdout).not.toContain("timer_");
    expect(out.stdout).toContain("finish: complete");
  });

  it("E160: with no timer the finish result matches the pre-timer shape", async () => {
    const w = build({ probes: [finished()] });
    const out = await runCli(["finish", "42"], { registry: w.registry });
    expect(out.stdout).not.toContain("timer_");
    expect(out.stdout).not.toContain("destroy_at");
  });
});

describe("job and run and the destroy timer", () => {
  const note = timerOf(14 * 60);
  const reg = (
    name: "job" | "run",
    reply: (c: SpawnCall) => ReturnType<typeof ok>,
  ) => {
    const { spawn } = recordingSpawner(reply);
    const deps = {
      spawn,
      resolveTool: () => "ssh",
      timerNote: () => Promise.resolve(note),
    };
    const entry =
      name === "job"
        ? { command: job.createJobCommand(deps), help: job.help }
        : { command: run.createRunCommand(deps), help: run.help };
    const registry: Registry = {
      home: REGISTRY.home,
      commands: { ...REGISTRY.commands, [name]: entry },
    };
    return registry;
  };

  it("E161: job merges the timer fields after the job fields and its help after the state help", async () => {
    const registry = reg("job", () => ok(record({ alive: true })));
    const out = await runCli(["job", "42"], { registry });
    expect(out.exitCode).toBe(0);
    const text = out.stdout;
    expect(text.indexOf("cmd:")).toBeLessThan(text.indexOf("destroy_at:"));
    expect(text).toContain("timer_left: 14m");
    expect(text).toContain("timer_warning:");
    expect(text.indexOf("Check again with")).toBeLessThan(
      text.indexOf("Extend it:"),
    );
  });

  it("E161: job --list shows no timer fields", async () => {
    const registry = reg("job", () => ok(record({ alive: true })));
    const out = await runCli(["job", "42", "--list"], { registry });
    expect(out.stdout).not.toContain("destroy_at");
    expect(out.stdout).not.toContain("timer_");
  });

  it("E161: run carries destroy_at and timer_left", async () => {
    const registry = reg("run", () => ok(record({ alive: true })));
    const out = await runCli(["run", "42", "--", "python", "train.py"], {
      registry,
    });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("destroy_at: ");
    expect(out.stdout).toContain("timer_left: 14m");
    expect(out.stdout).toContain("Extend it:");
  });
});
