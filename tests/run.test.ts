import { describe, expect, it } from "vitest";
import { REGISTRY, type Registry } from "../src/commands/index.js";
import * as run from "../src/commands/run.js";
import { shellQuote } from "../src/job.js";
import type { ToolRun } from "../src/transfer.js";
import {
  decodeRemote,
  embeddedRunScript,
  ok,
  record,
  recordingSpawner,
  type SpawnCall,
} from "./helpers/job-records.js";
import { newCallLog, readCallLog, runCli } from "./helpers/run-cli.js";

/** A registry whose `run` talks to a recording spawner instead of ssh. */
function runRegistry(reply: (call: SpawnCall) => ToolRun): {
  registry: Registry;
  calls: SpawnCall[];
} {
  const { spawn, calls } = recordingSpawner(reply);
  const command = run.createRunCommand({ spawn, resolveTool: () => "ssh" });
  return {
    calls,
    registry: {
      home: REGISTRY.home,
      commands: { ...REGISTRY.commands, run: { command, help: run.help } },
    },
  };
}

const started = (o = {}) => ok(record({ alive: true, ...o }));

describe("run", () => {
  it("starts a job over one ssh call and prints job, state, pid, cwd, log and cmd", async () => {
    const { registry, calls } = runRegistry(() => started());
    const out = await runCli(
      ["run", "42", "--cwd", "/workspace/proj", "--", "python", "train.py"],
      { registry },
    );
    expect(out.exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.file).toBe("ssh");
    expect(calls[0]!.capture).toBe(true);
    expect(calls[0]!.args.slice(0, 6)).toEqual([
      "-p",
      "2222",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "BatchMode=yes",
    ]);
    expect(calls[0]!.args).toContain("root@1.2.3.4");
    for (const field of [
      "job: main (#42)",
      "state: running",
      "pid: 4242",
      "cwd: /workspace",
      "log: ",
      "cmd: python train.py",
    ]) {
      expect(out.stdout).toContain(field);
    }
    expect(out.stdout).toContain("vast-axi finish 42");
    expect(out.stdout).toContain("vast-axi job 42");
  });

  it("builds the launcher with the default log <cwd>/run.log and the default name main", async () => {
    const { registry, calls } = runRegistry(() => started());
    await runCli(
      ["run", "42", "--cwd", "/workspace/proj", "--", "echo", "hi"],
      { registry },
    );
    const launcher = decodeRemote(calls[0]!.args);
    expect(launcher).toContain(`LOG=${shellQuote("/workspace/proj/run.log")}`);
    expect(launcher).toContain('d="$HOME/.vast-axi/jobs/main"');
    expect(embeddedRunScript(launcher)).toContain("bash -c 'echo hi'");
  });

  it("--log relative resolves against --cwd, --name selects the job dir", async () => {
    const { registry, calls } = runRegistry(() => started({ name: "t1" }));
    const out = await runCli(
      [
        "run",
        "42",
        "--name",
        "t1",
        "--cwd",
        "/workspace/p",
        "--log",
        "logs/t1.log",
        "--",
        "true",
      ],
      { registry },
    );
    expect(out.exitCode).toBe(0);
    const launcher = decodeRemote(calls[0]!.args);
    expect(launcher).toContain(`LOG=${shellQuote("/workspace/p/logs/t1.log")}`);
    expect(launcher).toContain('d="$HOME/.vast-axi/jobs/t1"');
    expect(out.stdout).toContain("job: t1 (#42)");
    expect(out.stdout).toContain("--name t1");
  });

  it("E33: --cwd /, /root, ~ or empty exits 2 before any ssh", async () => {
    for (const cwd of ["/", "/root", "~", ""]) {
      const { registry, calls } = runRegistry(() => started());
      const log = newCallLog();
      const out = await runCli(["run", "42", `--cwd=${cwd}`, "--", "true"], {
        registry,
        env: { FAKE_VASTAI_LOG: log },
      });
      expect(out.exitCode, `cwd=${JSON.stringify(cwd)}`).toBe(2);
      expect(out.stdout).toContain("code: VALIDATION_ERROR");
      expect(calls).toHaveLength(0);
      expect(readCallLog(log)).toHaveLength(0);
    }
  });

  it("E34: a --cwd missing on the instance is REMOTE_CWD_MISSING (exit 1)", async () => {
    const { registry } = runRegistry(() => ok("@vaxi nocwd\n"));
    const out = await runCli(
      ["run", "42", "--cwd", "/workspace/nope", "--", "true"],
      { registry },
    );
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("code: REMOTE_CWD_MISSING");
    expect(out.stdout).toContain("mkdir -p /workspace/nope");
  });

  it("E35: an existing log is LOG_EXISTS with --overwrite and --log hints", async () => {
    const { registry } = runRegistry(() => ok("@vaxi logexists\n"));
    const out = await runCli(["run", "42", "--", "true"], { registry });
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("code: LOG_EXISTS");
    expect(out.stdout).toContain("--overwrite");
    expect(out.stdout).toContain("--log");
  });

  it("OQ19: --overwrite is passed to the launcher", async () => {
    const { registry, calls } = runRegistry(() => started());
    await runCli(["run", "42", "--overwrite", "--", "true"], { registry });
    expect(decodeRemote(calls[0]!.args)).not.toContain("logexists");
  });

  it("E36: a name that is already running is JOB_RUNNING (exit 1)", async () => {
    const { registry } = runRegistry(() => ok("@vaxi running\n"));
    const out = await runCli(["run", "42", "--name", "train", "--", "true"], {
      registry,
    });
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("code: JOB_RUNNING");
    expect(out.stdout).toContain("vast-axi job 42 --name train");
  });

  it("E37: pipes, quotes, $VAR and unicode reach the remote script unchanged, not in the ssh args", async () => {
    const { registry, calls } = runRegistry(() => started());
    const program = `echo "a | b" 'it'"'"'s $HOME' ü☃ && cat < in.txt`;
    const out = await runCli(["run", "42", "--", program], { registry });
    expect(out.exitCode).toBe(0);
    const remote = calls[0]!.args[calls[0]!.args.length - 1]!;
    expect(remote).not.toContain("$HOME");
    expect(remote).toMatch(/^[\x20-\x7e]+$/);
    expect(embeddedRunScript(decodeRemote(calls[0]!.args))).toContain(
      `bash -c ${shellQuote(program)}`,
    );
  });

  it("E38: an instant failure reports state failed, the exit code and the tail", async () => {
    const { registry } = runRegistry(() =>
      ok(
        record({
          marker: { code: 127, end: "2026-10-20T10:00:01Z" },
          tail: "bash: line 1: nopeprog: command not found\n",
        }),
      ),
    );
    const out = await runCli(["run", "42", "--", "nopeprog"], { registry });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("state: failed");
    expect(out.stdout).toContain("exit_code: 127");
    expect(out.stdout).toContain("nopeprog: command not found");
    expect(out.stdout).toContain("--overwrite");
  });

  it("E39: the launcher detaches the job from the ssh session", async () => {
    const { registry, calls } = runRegistry(() => started());
    await runCli(["run", "42", "--", "sleep 1000"], { registry });
    expect(decodeRemote(calls[0]!.args)).toContain(
      'nohup setsid bash "$d/run.sh" </dev/null >/dev/null 2>&1 &',
    );
  });

  it("E52: a bad --name exits 2 before any ssh", async () => {
    const { registry, calls } = runRegistry(() => started());
    const out = await runCli(
      ["run", "42", "--name", "bad name!", "--", "true"],
      { registry },
    );
    expect(out.exitCode).toBe(2);
    expect(out.stdout).toContain("--name");
    expect(calls).toHaveLength(0);
  });

  it("a missing program after -- or without -- exits 2", async () => {
    const { registry, calls } = runRegistry(() => started());
    for (const argv of [
      ["run", "42"],
      ["run", "42", "--"],
      ["run", "42", "python", "x.py"],
    ]) {
      const out = await runCli(argv, { registry });
      expect(out.exitCode, argv.join(" ")).toBe(2);
    }
    expect(calls).toHaveLength(0);
  });

  it("a flag after -- belongs to the program, an unknown flag before it exits 2", async () => {
    const { registry } = runRegistry(() => started());
    const good = await runCli(
      ["run", "42", "--", "python", "t.py", "--cwd", "x"],
      { registry },
    );
    expect(good.exitCode).toBe(0);
    const bad = await runCli(["run", "42", "--cwdd", "/w", "--", "true"], {
      registry,
    });
    expect(bad.exitCode).toBe(2);
    expect(bad.stdout).toContain("--cwd");
  });

  it("a missing remote tool is REMOTE_TOOL_MISSING", async () => {
    const { registry } = runRegistry(() => ok("@vaxi missing setsid\n"));
    const out = await runCli(["run", "42", "--", "true"], { registry });
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("code: REMOTE_TOOL_MISSING");
    expect(out.stdout).toContain("setsid");
  });

  it("ssh exit 255 is SSH_FAILED and a silent remote is REMOTE_FAILED", async () => {
    const down = runRegistry(() => ({
      exitCode: 255,
      stdout: "",
      stderr: "Permission denied",
    }));
    const a = await runCli(["run", "42", "--", "true"], {
      registry: down.registry,
    });
    expect(a.exitCode).toBe(1);
    expect(a.stdout).toContain("code: SSH_FAILED");
    const silent = runRegistry(() => ({
      exitCode: 127,
      stdout: "",
      stderr: "bash: not found",
    }));
    const b = await runCli(["run", "42", "--", "true"], {
      registry: silent.registry,
    });
    expect(b.stdout).toContain("code: REMOTE_FAILED");
  });

  it("a command too long for one command line is refused before ssh", async () => {
    const { registry, calls } = runRegistry(() => started());
    const out = await runCli(["run", "42", "--", "x".repeat(30_000)], {
      registry,
    });
    expect(out.exitCode).toBe(2);
    expect(out.stdout).toContain("too long");
    expect(calls).toHaveLength(0);
  });

  it("has --help with the usage line", async () => {
    const out = await runCli(["run", "--help"]);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("usage: vast-axi run <id>");
  });

  it("--json keeps the same structure", async () => {
    const { registry } = runRegistry(() => started());
    const out = await runCli(["run", "42", "--json", "--", "true"], {
      registry,
    });
    const body = JSON.parse(out.stdout) as Record<string, unknown>;
    expect(body["state"]).toBe("running");
    expect(body["job"]).toBe("main (#42)");
  });
});
