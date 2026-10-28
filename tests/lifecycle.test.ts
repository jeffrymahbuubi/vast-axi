import { describe, expect, it } from "vitest";
import { newCallLog, readCallLog, runCli } from "./helpers/run-cli.js";

const showInstance = (...responses: object[]) =>
  JSON.stringify({
    "show instance":
      responses.length === 1 ? responses[0] : { sequence: responses },
  });
const RUNNING = { fixture: "u6-instance-running.json" };
const STOPPED = { fixture: "u6-instance-stopped.json" };
const MISSING = { fixture: "u6-instance-missing.json" };

/** The leading tokens of every vastai call, for example "stop instance". */
async function calls(log: string): Promise<string[]> {
  return readCallLog(log).map((c) => c.tokens.slice(0, 2).join(" "));
}

describe("stop", () => {
  it("E19/AE4: stopping a stopped instance is a no-op and never calls stop", async () => {
    const log = newCallLog();
    const out = await runCli(["stop", "42"], {
      env: {
        FAKE_VASTAI_LOG: log,
        FAKE_VASTAI_ROUTES: showInstance(STOPPED),
      },
    });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("instance: #42 already stopped (no-op)");
    expect(await calls(log)).toEqual(["show instance"]);
  });

  it("E19: accepts `stopping instance 42.`, then reports the state it reads back", async () => {
    const log = newCallLog();
    const out = await runCli(["stop", "42"], {
      env: {
        FAKE_VASTAI_LOG: log,
        FAKE_VASTAI_ROUTES: showInstance(RUNNING, STOPPED),
      },
    });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("instance: #42 stopping");
    expect(out.stdout).toContain("state: exited");
    expect(await calls(log)).toEqual([
      "show instance",
      "stop instance",
      "show instance",
    ]);
  });

  it("OQ14: the help says storage still bills and offers destroy <id>", async () => {
    const out = await runCli(["stop", "42"]);
    expect(out.stdout).toMatch(/Storage still bills/);
    expect(out.stdout).toContain("vast-axi destroy 42");
  });

  it("does not report success when upstream answers with a refusal (exit 0)", async () => {
    const out = await runCli(["stop", "42"], {
      env: {
        FAKE_VASTAI_ROUTES: JSON.stringify({
          "stop instance": { stdout: "Could not stop instance 42.\n" },
        }),
      },
    });
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("code: UPSTREAM_ERROR");
  });

  it("a missing instance is NOT_FOUND (exit 1)", async () => {
    const out = await runCli(["stop", "42"], {
      env: { FAKE_VASTAI_ROUTES: showInstance(MISSING) },
    });
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("code: NOT_FOUND");
  });

  it("an upstream 404 from show instance is also a missing instance", async () => {
    const out = await runCli(["destroy", "42"], {
      env: {
        FAKE_VASTAI_ROUTES: showInstance({
          stderr:
            '{"error": true, "status_code": 404, "msg": "Instance not found"}',
        }),
      },
    });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("(no-op)");
  });

  it("an auth error from show instance is surfaced, not treated as missing", async () => {
    const out = await runCli(["stop", "42"], {
      env: {
        FAKE_VASTAI_ROUTES: showInstance({
          fixture: "error-401.json",
          stream: "stderr",
        }),
      },
    });
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("code: AUTH_REQUIRED");
  });

  it("validates the id", async () => {
    expect((await runCli(["stop"])).exitCode).toBe(2);
    expect((await runCli(["stop", "4x"])).exitCode).toBe(2);
    expect((await runCli(["stop", "42", "43"])).exitCode).toBe(2);
  });
});

describe("destroy", () => {
  it("E18: destroying a missing instance is a no-op and never calls destroy", async () => {
    const log = newCallLog();
    const out = await runCli(["destroy", "42"], {
      env: {
        FAKE_VASTAI_LOG: log,
        FAKE_VASTAI_ROUTES: showInstance(MISSING),
      },
    });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("(no-op)");
    // The only extra call is the leftover-timer sweep (E58).
    expect(await calls(log)).toEqual(["show instance", "show scheduled-jobs"]);
  });

  it("E26: always passes -y and runs immediately without --yes", async () => {
    const log = newCallLog();
    const out = await runCli(["destroy", "42"], {
      env: {
        FAKE_VASTAI_LOG: log,
        FAKE_VASTAI_ROUTES: showInstance(RUNNING, MISSING),
      },
    });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("instance: #42 destroyed");
    const destroy = readCallLog(log).find((c) => c.tokens[0] === "destroy")!;
    expect(destroy.argv.slice(3)).toEqual(["destroy", "instance", "42", "-y"]);
  });

  it("reports `destroying` while the instance is still listed", async () => {
    const out = await runCli(["destroy", "42"]);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("instance: #42 destroying");
  });

  it("accepts the plain-text acknowledgement too", async () => {
    const out = await runCli(["destroy", "42"], {
      env: {
        FAKE_VASTAI_ROUTES: JSON.stringify({
          "destroy instance": { stdout: "destroying instance 42.\n" },
        }),
      },
    });
    expect(out.exitCode).toBe(0);
  });

  it("a refused destroy ({success:false}) is an error, not a success", async () => {
    const out = await runCli(["destroy", "42"], {
      env: {
        FAKE_VASTAI_ROUTES: JSON.stringify({
          "destroy instance": {
            stdout: '{"success": false, "msg": "insufficient credit"}',
          },
        }),
      },
    });
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("code: INSUFFICIENT_CREDIT");
  });

  it("E26: --all without --yes exits 2 and calls nothing", async () => {
    const log = newCallLog();
    const out = await runCli(["destroy", "--all"], {
      env: { FAKE_VASTAI_LOG: log },
    });
    expect(out.exitCode).toBe(2);
    expect(out.stdout).toContain("--yes");
    expect(readCallLog(log)).toEqual([]);
  });

  it("--all --yes destroys every listed instance with -y", async () => {
    const log = newCallLog();
    const out = await runCli(["destroy", "--all", "--yes"], {
      env: {
        FAKE_VASTAI_LOG: log,
        FAKE_VASTAI_ROUTES: JSON.stringify({
          "show instances": {
            sequence: [{ fixture: "instances.json" }, { stdout: "[]" }],
          },
        }),
      },
    });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("destroyed: 3 instances");
    const destroy = readCallLog(log).find((c) => c.tokens[0] === "destroy")!;
    expect(destroy.argv.slice(3)).toEqual([
      "destroy",
      "instances",
      "1000001",
      "1000002",
      "1000003",
      "-y",
    ]);
  });

  it("--all --yes on an empty account is a no-op", async () => {
    const log = newCallLog();
    const out = await runCli(["destroy", "--all", "--yes"], {
      env: {
        FAKE_VASTAI_LOG: log,
        FAKE_VASTAI_ROUTES: JSON.stringify({
          "show instances": { stdout: "[]" },
        }),
      },
    });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("(no-op)");
    expect(await calls(log)).toEqual(["show instances"]);
  });

  it("an id together with --all is a validation error", async () => {
    const out = await runCli(["destroy", "42", "--all", "--yes"]);
    expect(out.exitCode).toBe(2);
  });

  it("validates the id", async () => {
    expect((await runCli(["destroy"])).exitCode).toBe(2);
    expect((await runCli(["destroy", "x"])).exitCode).toBe(2);
  });
});

describe("E20: unknown flags", () => {
  it.each([
    ["stop", ["stop", "42", "--force"], "valid flags for stop: (none)"],
    ["destroy", ["destroy", "42", "--forse"], "--all, --yes"],
  ])("%s exits 2 and lists the valid flags", async (_name, argv, listed) => {
    const out = await runCli(argv);
    expect(out.exitCode).toBe(2);
    expect(out.stdout).toContain(listed);
  });

  it("stop and destroy have --help", async () => {
    expect((await runCli(["stop", "--help"])).stdout).toContain(
      "usage: vast-axi stop",
    );
    expect((await runCli(["destroy", "--help"])).stdout).toContain(
      "usage: vast-axi destroy",
    );
  });
});
