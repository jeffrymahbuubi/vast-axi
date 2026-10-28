import { describe, expect, it } from "vitest";
import { REGISTRY, type Registry } from "../src/commands/index.js";
import * as job from "../src/commands/job.js";
import type { ToolRun } from "../src/transfer.js";
import {
  decodeRemote,
  ok,
  record,
  recordingSpawner,
  type SpawnCall,
} from "./helpers/job-records.js";
import { runCli } from "./helpers/run-cli.js";

/** A registry whose `job` talks to a recording spawner instead of ssh. */
function jobRegistry(reply: (call: SpawnCall) => ToolRun): {
  registry: Registry;
  calls: SpawnCall[];
} {
  const { spawn, calls } = recordingSpawner(reply);
  const command = job.createJobCommand({ spawn, resolveTool: () => "ssh" });
  return {
    calls,
    registry: {
      home: REGISTRY.home,
      commands: { ...REGISTRY.commands, job: { command, help: job.help } },
    },
  };
}

const done = { marker: { code: 0, end: "2026-10-20T10:42:00Z" } };

describe("job", () => {
  it("reports a running job in one ssh call with log path, size and a 20 line tail request", async () => {
    const { registry, calls } = jobRegistry(() =>
      ok(record({ alive: true, size: 1536, tail: "step 1\nstep 2\n" })),
    );
    const out = await runCli(["job", "42"], { registry });
    expect(out.exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(out.stdout).toContain("job: main (#42)");
    expect(out.stdout).toContain("state: running");
    expect(out.stdout).toContain('started: "2026-10-20T10:00:00Z"');
    expect(out.stdout).toContain("elapsed: 5m");
    expect(out.stdout).toContain("log: /workspace/run.log (1.5 KB)");
    expect(out.stdout).toContain("tail[2]: step 1,step 2");
    expect(out.stdout).not.toContain("exit_code");
    expect(decodeRemote(calls[0]!.args)).toContain('vaxi_probe_job "$d" 23');
  });

  it("a finished job shows exit_code 0, ended and the elapsed run time", async () => {
    const { registry } = jobRegistry(() =>
      ok(record({ ...done, tail: "all done\n" })),
    );
    const out = await runCli(["job", "42"], { registry });
    expect(out.stdout).toContain("state: finished");
    expect(out.stdout).toContain("exit_code: 0");
    expect(out.stdout).toContain('ended: "2026-10-20T10:42:00Z"');
    expect(out.stdout).toContain("elapsed: 42m");
    expect(out.stdout).toContain("vast-axi finish 42");
  });

  it("a failed job shows its non-zero exit code and the tail", async () => {
    const { registry } = jobRegistry(() =>
      ok(
        record({
          marker: { code: 1, end: "2026-10-20T10:01:00Z" },
          tail: "Traceback\nValueError: x\n",
        }),
      ),
    );
    const out = await runCli(["job", "42"], { registry });
    expect(out.stdout).toContain("state: failed");
    expect(out.stdout).toContain("exit_code: 1");
    expect(out.stdout).toContain("ValueError: x");
  });

  it("E41: a wrapper that died is lost and the hint says the instance is kept", async () => {
    const { registry } = jobRegistry(() => ok(record({ alive: false })));
    const out = await runCli(["job", "42"], { registry });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("state: lost");
    expect(out.stdout).toContain("instance is kept");
  });

  it("E43: tqdm progress shows only the last segment of each line", async () => {
    const { registry } = jobRegistry(() =>
      ok(record({ alive: true, tail: "a\r 1%\r 50%\r100%\nfinished epoch\n" })),
    );
    const out = await runCli(["job", "42", "--json"], { registry });
    const body = JSON.parse(out.stdout) as { tail: string[] };
    expect(body.tail).toEqual(["100%", "finished epoch"]);
  });

  it("E44: the probe reads only a bounded tail and lines are cut to 400 characters", async () => {
    const { registry, calls } = jobRegistry(() =>
      ok(
        record({
          alive: true,
          size: 5_000_000_000,
          tail: `${"q".repeat(5000)}\n`,
        }),
      ),
    );
    const out = await runCli(["job", "42", "--json"], { registry });
    expect(decodeRemote(calls[0]!.args)).toContain("tail -c 65536");
    const body = JSON.parse(out.stdout) as { tail: string[]; log: string };
    expect(body.tail[0]).toBe(`${"q".repeat(400)}[+4600 chars]`);
    expect(body.log).toContain("MB");
  });

  it("E51: secrets in the tail and in the command are redacted", async () => {
    const hex = "9f".repeat(25);
    const { registry } = jobRegistry(() =>
      ok(
        record({
          alive: true,
          cmd: `train --token ${hex}`,
          tail: `auth ${hex}\n`,
        }),
      ),
    );
    const out = await runCli(["job", "42"], { registry });
    expect(out.stdout).not.toContain(hex);
    expect(out.stdout).toContain("<redacted>");
  });

  it("selects by --name and by --log", async () => {
    const { registry, calls } = jobRegistry(() =>
      ok(record({ name: "prep", alive: true })),
    );
    const byName = await runCli(["job", "42", "--name", "prep"], { registry });
    expect(byName.stdout).toContain("job: prep (#42)");
    expect(decodeRemote(calls[0]!.args)).toContain(
      'd="$HOME/.vast-axi/jobs/prep"',
    );
    await runCli(["job", "42", "--log", "./logs/p.log"], { registry });
    expect(decodeRemote(calls[1]!.args)).toContain("SEL='logs/p.log'");
  });

  it("--list prints a table of every job", async () => {
    const out2 =
      record({ name: "a", marker: { code: 0, end: "2026-10-20T10:10:00Z" } }) +
      record({ name: "b", alive: true });
    const { registry, calls } = jobRegistry(() => ok(out2));
    const out = await runCli(["job", "42", "--list"], { registry });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("jobs[2]{name,state,exit,elapsed,log}:");
    expect(out.stdout).toContain("a,finished,0,10m,/workspace/run.log");
    expect(out.stdout).toContain("b,running,null,5m,/workspace/run.log");
    expect(decodeRemote(calls[0]!.args)).toContain("nojobs");
  });

  it("--list with no jobs is a definitive empty state", async () => {
    const { registry } = jobRegistry(() => ok("@vaxi nojobs\n"));
    const out = await runCli(["job", "42", "--list"], { registry });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("jobs: 0 jobs on #42");
  });

  it("an unknown job is JOB_NOT_FOUND (exit 1) with a --list hint", async () => {
    const { registry } = jobRegistry(() => ok("@vaxi notfound\n"));
    const out = await runCli(["job", "42", "--name", "ghost"], { registry });
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("code: JOB_NOT_FOUND");
    expect(out.stdout).toContain("vast-axi job 42 --list");
  });

  it("E52: bad --tail, --name and conflicting selectors exit 2 before any ssh", async () => {
    const { registry, calls } = jobRegistry(() => ok(record()));
    const bads = [
      ["job", "42", "--tail", "0"],
      ["job", "42", "--tail", "abc"],
      ["job", "42", "--tail", "501"],
      ["job", "42", "--name", "a/b"],
      ["job", "42", "--name", "a", "--log", "x"],
      ["job", "42", "--list", "--name", "a"],
      ["job", "42", "--bogus"],
      ["job", "abc"],
    ];
    for (const argv of bads) {
      const out = await runCli(argv, { registry });
      expect(out.exitCode, argv.join(" ")).toBe(2);
    }
    expect(calls).toHaveLength(0);
  });

  it("a missing remote tool and a silent remote are mapped to errors", async () => {
    const a = jobRegistry(() => ok("@vaxi missing base64-or-bash\n"));
    const missing = await runCli(["job", "42"], { registry: a.registry });
    expect(missing.stdout).toContain("code: REMOTE_TOOL_MISSING");
    const b = jobRegistry(() => ({
      exitCode: 0,
      stdout: "motd only\n",
      stderr: "",
    }));
    const silent = await runCli(["job", "42"], { registry: b.registry });
    expect(silent.stdout).toContain("code: REMOTE_FAILED");
  });

  it("a job whose log was deleted still reports its state from the exit file", async () => {
    const { registry } = jobRegistry(() =>
      ok(record({ nolog: true, exitfile: "0 2026-10-20T10:30:00Z" })),
    );
    const out = await runCli(["job", "42"], { registry });
    expect(out.stdout).toContain("state: finished");
    expect(out.stdout).toContain("(missing)");
  });

  it("has --help and logs --help points at job", async () => {
    const h = await runCli(["job", "--help"]);
    expect(h.exitCode).toBe(0);
    expect(h.stdout).toContain("usage: vast-axi job <id>");
    const logs = await runCli(["logs", "--help"]);
    expect(logs.stdout).toContain("vast-axi job <id>");
  });
});
