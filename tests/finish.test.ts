import { describe, expect, it } from "vitest";
import { decodeRemote, ok, type SpawnCall } from "./helpers/job-records.js";
import { runCli } from "./helpers/run-cli.js";
import {
  build,
  failed,
  finished,
  listing,
  lost,
  running,
  sshDown,
  vastCalls,
  withLog,
} from "./helpers/finish-world.js";
describe("finish: waiting", () => {
  it("without --wait a running job exits 1 and nothing is fetched", async () => {
    const w = build({
      probes: [running],
      list: listing([5, "/workspace/out/m.pt"]),
    });
    const out = await runCli(["finish", "42", "--fetch", "out/m.pt:./m.pt"], {
      registry: w.registry,
    });
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("state: running");
    expect(out.stdout).toContain("job still running; nothing fetched");
    expect(w.calls).toHaveLength(1);
    expect(w.scpCalls).toHaveLength(0);
  });

  it("--wait polls every 15m by default until the job ends, then exits 0", async () => {
    const w = build({ probes: [running, running, finished()] });
    const out = await runCli(["finish", "42", "--wait"], {
      registry: w.registry,
    });
    expect(out.exitCode).toBe(0);
    expect(w.sleeps).toEqual([900_000, 900_000]);
    expect(out.stdout).toContain("state: finished");
    expect(out.stdout).toContain("finish: complete");
  });

  it("--poll 30s sets the interval", async () => {
    const w = build({ probes: [running, finished()] });
    await runCli(["finish", "42", "--wait", "--poll", "30s"], {
      registry: w.registry,
    });
    expect(w.sleeps).toEqual([30_000]);
  });

  it("--timeout stops the wait with exit 1, trimming the last sleep", async () => {
    const w = build({ probes: [running] });
    const out = await runCli(
      ["finish", "42", "--wait", "--poll", "30s", "--timeout", "100s"],
      { registry: w.registry },
    );
    expect(out.exitCode).toBe(1);
    expect(w.sleeps).toEqual([30_000, 30_000, 30_000, 10_000]);
    expect(out.stdout).toContain("timed out after 1m;");
    expect(w.scpCalls).toHaveLength(0);
  });

  it("E45: transient ssh failures are retried and the instance is not even checked", async () => {
    const { log, env } = withLog();
    const w = build({ probes: [sshDown, sshDown, finished()] });
    const out = await runCli(["finish", "42", "--wait", "--poll", "30s"], {
      registry: w.registry,
      env,
    });
    expect(out.exitCode).toBe(0);
    expect(w.sleeps).toEqual([30_000, 30_000]);
    expect(vastCalls(log, "show", "instance")).toHaveLength(1);
  });

  it("E45: without --wait an ssh failure is reported at once (SSH_FAILED)", async () => {
    const w = build({ probes: [sshDown] });
    const out = await runCli(["finish", "42"], { registry: w.registry });
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("code: SSH_FAILED");
    expect(w.calls).toHaveLength(1);
  });

  it("E45: three failures in a row check the instance; a running one keeps the wait going", async () => {
    const { log, env } = withLog();
    const w = build({ probes: [sshDown, sshDown, sshDown, finished()] });
    const out = await runCli(["finish", "42", "--wait", "--poll", "30s"], {
      registry: w.registry,
      env,
    });
    expect(out.exitCode).toBe(0);
    expect(vastCalls(log, "show", "instance")).toHaveLength(2);
  });

  it("E46: three failures and a stopped instance is INSTANCE_GONE (exit 1)", async () => {
    const { env } = withLog();
    const w = build({ probes: [sshDown] });
    const out = await runCli(["finish", "42", "--wait", "--poll", "30s"], {
      registry: w.registry,
      env: {
        ...env,
        FAKE_VASTAI_ROUTES: JSON.stringify({
          "show instance": {
            sequence: [
              { fixture: "u6-instance-running.json" },
              { fixture: "u6-instance-stopped.json" },
            ],
          },
        }),
      },
    });
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("code: INSTANCE_GONE");
    expect(out.stdout).toContain("exited");
  });

  it("E46: three failures and a destroyed instance is INSTANCE_GONE", async () => {
    const { env } = withLog();
    const w = build({ probes: [sshDown] });
    const out = await runCli(["finish", "42", "--wait", "--poll", "30s"], {
      registry: w.registry,
      env: {
        ...env,
        FAKE_VASTAI_ROUTES: JSON.stringify({
          "show instance": {
            sequence: [
              { fixture: "u6-instance-running.json" },
              { fixture: "u6-instance-missing.json" },
            ],
          },
        }),
      },
    });
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("code: INSTANCE_GONE");
    expect(out.stdout).toContain("no longer exists");
  });

  it("an unknown job is JOB_NOT_FOUND", async () => {
    const w = build({ probes: [ok("@vaxi notfound\n")] });
    const out = await runCli(["finish", "42", "--name", "ghost"], {
      registry: w.registry,
    });
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("code: JOB_NOT_FOUND");
  });
});

describe("finish: destroy", () => {
  const place =
    (size: number) =>
    (call: SpawnCall, put: (p: string, s: number) => void) => {
      put(call.args[call.args.length - 1]!, size);
      return ok();
    };

  it("OQ21: --destroy after exit 0 and verified fetches destroys the instance (exit 0)", async () => {
    const { log, env } = withLog();
    const w = build({
      probes: [running, finished()],
      list: listing([5, "/workspace/out/m.pt"]),
      scp: place(5),
    });
    const out = await runCli(
      [
        "finish",
        "42",
        "--wait",
        "--poll",
        "30s",
        "--fetch",
        "out/m.pt:./m.pt",
        "--destroy",
      ],
      { registry: w.registry, env },
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("destroy: #42 destroyed");
    expect(out.stdout).toContain("finish: complete");
    const destroys = vastCalls(log, "destroy", "instance");
    expect(destroys).toHaveLength(1);
    expect(destroys[0]!.argv).toContain("42");
    expect(destroys[0]!.argv).toContain("-y");
  });

  it("--destroy with nothing to fetch destroys after a clean finish", async () => {
    const { log, env } = withLog();
    const w = build({ probes: [finished()] });
    const out = await runCli(["finish", "42", "--destroy"], {
      registry: w.registry,
      env,
    });
    expect(out.exitCode).toBe(0);
    expect(vastCalls(log, "destroy", "instance")).toHaveLength(1);
  });

  it("E49: --destroy after a failed job still fetches, keeps the instance and exits 1", async () => {
    const { log, env } = withLog();
    const w = build({
      probes: [failed(3)],
      list: listing([5, "/workspace/out/m.pt"]),
      scp: place(5),
    });
    const out = await runCli(
      ["finish", "42", "--fetch", "out/m.pt:./m.pt", "--destroy"],
      { registry: w.registry, env },
    );
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("state: failed");
    expect(out.stdout).toContain("exit_code: 3");
    expect(out.stdout).toContain("m.pt,1,5,yes");
    expect(out.stdout).toContain("kept #42: job failed (exit 3)");
    expect(w.scpCalls).toHaveLength(1);
    expect(vastCalls(log, "destroy")).toHaveLength(0);
  });

  it("E41 and E49: a lost job keeps the instance and says why", async () => {
    const { log, env } = withLog();
    const w = build({ probes: [lost] });
    const out = await runCli(["finish", "42", "--destroy"], {
      registry: w.registry,
      env,
    });
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("state: lost");
    expect(out.stdout).toContain("kept #42: job lost");
    expect(vastCalls(log, "destroy")).toHaveLength(0);
  });

  it("an upstream-refused destroy is reported as kept, with exit 1", async () => {
    const { env } = withLog();
    const w = build({ probes: [finished()] });
    const out = await runCli(["finish", "42", "--destroy"], {
      registry: w.registry,
      env: {
        ...env,
        FAKE_VASTAI_ROUTES: JSON.stringify({
          "destroy instance": { stdout: "failed: instance is busy\n" },
        }),
      },
    });
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("kept #42: destroy failed");
  });

  it("without --destroy a finished job exits 0 and the hint says the instance still bills", async () => {
    const { log, env } = withLog();
    const w = build({ probes: [finished()] });
    const out = await runCli(["finish", "42"], { registry: w.registry, env });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("still running and billing");
    expect(vastCalls(log, "destroy")).toHaveLength(0);
  });

  it("a failed job exits 1 even when every fetch verified", async () => {
    const w = build({ probes: [failed(1)] });
    const out = await runCli(["finish", "42"], { registry: w.registry });
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("finish: incomplete");
  });
});

describe("finish: arguments", () => {
  it("E52: bad --poll, --timeout and misplaced flags exit 2 before any ssh", async () => {
    const w = build({ probes: [finished()] });
    const bads = [
      ["finish", "42", "--wait", "--poll", "10s"],
      ["finish", "42", "--wait", "--poll", "abc"],
      ["finish", "42", "--wait", "--timeout", "5"],
      ["finish", "42", "--poll", "1m"],
      ["finish", "42", "--timeout", "1h"],
      ["finish", "42", "--name", "a b"],
      ["finish", "42", "--name", "a", "--log", "x"],
      ["finish", "42", "--bogus"],
      ["finish", "abc"],
    ];
    for (const argv of bads) {
      const out = await runCli(argv, { registry: w.registry });
      expect(out.exitCode, argv.join(" ")).toBe(2);
    }
    expect(w.calls).toHaveLength(0);
  });

  it("selects the job by --name or --log in the probe", async () => {
    const w = build({ probes: [finished({ name: "prep" })] });
    await runCli(["finish", "42", "--name", "prep"], { registry: w.registry });
    expect(decodeRemote(w.calls[0]!.args)).toContain(
      'd="$HOME/.vast-axi/jobs/prep"',
    );
    await runCli(["finish", "42", "--log", "out.log"], {
      registry: w.registry,
    });
    expect(decodeRemote(w.calls[1]!.args)).toContain("SEL='out.log'");
  });

  it("has --help and --json keeps the structure", async () => {
    const h = await runCli(["finish", "--help"]);
    expect(h.exitCode).toBe(0);
    expect(h.stdout).toContain("usage: vast-axi finish <id>");
    const w = build({ probes: [finished()] });
    const out = await runCli(["finish", "42", "--json"], {
      registry: w.registry,
    });
    const body = JSON.parse(out.stdout) as Record<string, unknown>;
    expect(body["state"]).toBe("finished");
    expect(body["finish"]).toBe("complete");
  });
});
