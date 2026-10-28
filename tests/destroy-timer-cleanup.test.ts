import { describe, expect, it } from "vitest";
import { build, finished, vastCalls, withLog } from "./helpers/finish-world.js";
import { runCli, type Env } from "./helpers/run-cli.js";

// Cleanup and display of destroy timers (rent --max-hours) by destroy, finish,
// status and the dashboard. tests/fixtures/u11-jobs.json holds, for instance 42:
// destroy timers 5080 (04:00Z) and 5081 (05:00Z, already fired once), a GET job
// 5095 and a DELETE job 5096 aimed at instance 99's endpoint (both must be left
// alone); and timer 5090 for instance 777.

const routes = (over: Record<string, unknown>): Env => ({
  FAKE_VASTAI_ROUTES: JSON.stringify(over),
});
const JOBS = { "show scheduled-jobs": { fixture: "u11-jobs.json" } };
const ONE_JOB = {
  "show scheduled-jobs": {
    stdout: JSON.stringify([
      {
        id: 5080,
        api_endpoint: "/api/v0/instances/42/",
        request_method: "DELETE",
        instance_id: 42,
        start_time: 1792554600.0,
      },
    ]),
  },
};
const MISSING = { "show instance": { fixture: "u6-instance-missing.json" } };
const deletes = (calls: Array<{ tokens: string[] }>) =>
  calls
    .filter((c) => c.tokens[0] === "delete" && c.tokens[1] === "scheduled-job")
    .map((c) => c.tokens[2]);

async function destroy(argv: string[], over: Record<string, unknown>) {
  const { log, env } = withLog();
  const out = await runCli(["destroy", ...argv, "--json"], {
    env: { ...env, ...routes(over) },
  });
  const calls = vastCalls(log);
  return {
    ...out,
    calls,
    json: JSON.parse(out.stdout) as Record<string, unknown>,
    deleted: deletes(calls),
  };
}

describe("destroy removes the instance's destroy timers", () => {
  it("deletes exactly the DELETE jobs aimed at that instance", async () => {
    const r = await destroy(["42"], JOBS);
    expect(r.exitCode).toBe(0);
    expect(r.deleted).toEqual(["5080", "5081"]);
    expect(r.json["destroy_timer"]).toBe("removed jobs 5080, 5081");
    expect(r.json["instance"]).toMatch(/^#42 destroy/);
    expect(r.json).not.toHaveProperty("destroy_timer_warning");
  });

  it("one timer reads `removed job N`", async () => {
    const r = await destroy(["42"], ONE_JOB);
    expect(r.deleted).toEqual(["5080"]);
    expect(r.json["destroy_timer"]).toBe("removed job 5080");
  });

  it("destroys first, then lists and deletes", async () => {
    const r = await destroy(["42"], ONE_JOB);
    const order = r.calls.map((c) => c.tokens.slice(0, 2).join(" "));
    expect(order.indexOf("destroy instance")).toBeLessThan(
      order.indexOf("show scheduled-jobs"),
    );
    expect(order.indexOf("show scheduled-jobs")).toBeLessThan(
      order.indexOf("delete scheduled-job"),
    );
  });

  it("E57: no timers means no extra field and no error", async () => {
    const r = await destroy(["42"], {});
    expect(r.exitCode).toBe(0);
    expect(r.deleted).toEqual([]);
    expect(Object.keys(r.json).sort()).toEqual(["help", "instance", "state"]);
  });

  it("E58: a leftover timer on an already-gone instance is removed on the no-op path", async () => {
    const r = await destroy(["42"], { ...MISSING, ...JOBS });
    expect(r.exitCode).toBe(0);
    expect(r.json["instance"]).toBe("#42 not found, already destroyed (no-op)");
    expect(r.json["destroy_timer"]).toBe("removed jobs 5080, 5081");
    expect(r.calls.some((c) => c.tokens[0] === "destroy")).toBe(false);
    expect(r.deleted).toEqual(["5080", "5081"]);
  });

  it("E58: the no-op path with no timers stays a plain no-op", async () => {
    const r = await destroy(["42"], MISSING);
    expect(r.exitCode).toBe(0);
    expect(Object.keys(r.json).sort()).toEqual(["help", "instance"]);
  });

  it("a timer that cannot be deleted is a warning, never a failure", async () => {
    const r = await destroy(["42"], {
      ...ONE_JOB,
      "delete scheduled-job": {
        stdout: "{'success': False, 'msg': 'not allowed'}\n",
      },
    });
    expect(r.exitCode).toBe(0);
    expect(r.json["instance"]).toMatch(/^#42 destroy/);
    expect(r.json).not.toHaveProperty("destroy_timer");
    expect(String(r.json["destroy_timer_warning"])).toContain("5080");
    expect((r.json["help"] as string[]).join("\n")).toContain(
      "vast-axi raw delete scheduled-job 5080",
    );
  });

  it("a failing delete call is also a warning", async () => {
    const r = await destroy(["42"], {
      ...ONE_JOB,
      "delete scheduled-job": {
        stderr: JSON.stringify({ error: true, status_code: 500, msg: "down" }),
      },
    });
    expect(r.exitCode).toBe(0);
    expect(r.json).toHaveProperty("destroy_timer_warning");
  });

  it("an unreadable job list is a warning, never a failure", async () => {
    const r = await destroy(["42"], {
      "show scheduled-jobs": { stdout: "not json" },
    });
    expect(r.exitCode).toBe(0);
    expect(r.json["instance"]).toMatch(/^#42 destroy/);
    expect(String(r.json["destroy_timer_warning"])).toContain(
      "could not list scheduled jobs",
    );
    expect((r.json["help"] as string[]).join("\n")).toContain(
      "vast-axi raw delete scheduled-job <id>",
    );
  });

  it("a failing list call is a warning too", async () => {
    const r = await destroy(["42"], {
      "show scheduled-jobs": { stderr: "Traceback: boom\n", exit: 1 },
    });
    expect(r.exitCode).toBe(0);
    expect(r.json).toHaveProperty("destroy_timer_warning");
  });

  it("destroy --all --yes removes the timers of every destroyed instance", async () => {
    const r = await destroy(["--all", "--yes"], {
      ...JOBS,
      "show instances": {
        sequence: [
          { stdout: JSON.stringify([{ id: 42 }, { id: 777 }]) },
          { stdout: "[]" },
        ],
      },
    });
    expect(r.exitCode).toBe(0);
    expect(r.deleted).toEqual(["5080", "5081", "5090"]);
    expect(r.json["destroy_timer"]).toBe("removed jobs 5080, 5081, 5090");
  });

  it("destroy --all with nothing to destroy lists no jobs", async () => {
    const r = await destroy(["--all", "--yes"], {
      "show instances": { stdout: "[]" },
    });
    expect(r.exitCode).toBe(0);
    expect(r.calls.some((c) => c.tokens[1] === "scheduled-jobs")).toBe(false);
  });
});

describe("finish --destroy removes the timers too", () => {
  it("lists and deletes after a successful destroy", async () => {
    const { log, env } = withLog();
    const w = build({ probes: [finished()] });
    const out = await runCli(["finish", "42", "--destroy", "--json"], {
      registry: w.registry,
      env: { ...env, ...routes(JOBS) },
    });
    expect(out.exitCode).toBe(0);
    const json = JSON.parse(out.stdout) as Record<string, unknown>;
    expect(json["destroy"]).toBe("#42 destroyed");
    expect(json["destroy_timer"]).toBe("removed jobs 5080, 5081");
    expect(deletes(vastCalls(log))).toEqual(["5080", "5081"]);
  });

  it("a kept instance keeps its timer (no listing at all)", async () => {
    const { log, env } = withLog();
    const w = build({ probes: [finished({ marker: { code: 3, end: "x" } })] });
    const out = await runCli(["finish", "42", "--destroy"], {
      registry: w.registry,
      env: { ...env, ...routes(JOBS) },
    });
    expect(out.stdout).toContain("kept #42");
    expect(vastCalls(log, "show", "scheduled-jobs")).toHaveLength(0);
    expect(vastCalls(log, "delete")).toHaveLength(0);
  });

  it("finish without --destroy never touches timers", async () => {
    const { log, env } = withLog();
    const w = build({ probes: [finished()] });
    await runCli(["finish", "42"], {
      registry: w.registry,
      env: { ...env, ...routes(JOBS) },
    });
    expect(vastCalls(log, "show", "scheduled-jobs")).toHaveLength(0);
  });
});

const nowS = () => Date.now() / 1000;
const running = (id: number) => ({
  id,
  label: `job${id}`,
  gpu_name: "RTX 4090",
  num_gpus: 1,
  disk_space: 40,
  dph_total: 0.4,
  storage_cost: 0.1,
  actual_status: "running",
  intended_status: "running",
  status_msg: "",
  start_date: nowS() - 7200,
  gpu_util: 80,
});
const instances = (...ids: number[]) => ({
  "show instances": { stdout: JSON.stringify(ids.map(running)) },
});

describe("status <id> shows destroy_at", () => {
  const status = async (over: Record<string, unknown>) => {
    const out = await runCli(["status", "42", "--json"], {
      env: routes({ ...instances(42), ...over }),
    });
    return {
      ...out,
      json: JSON.parse(out.stdout) as Record<string, unknown>,
    };
  };

  it("the earliest timer's first :00 at or after start_time, ISO minute precision", async () => {
    const r = await status(JOBS);
    expect(r.exitCode).toBe(0);
    expect(r.json["destroy_at"]).toBe("2026-10-21T04:00Z");
  });

  it("no timer, no field", async () => {
    const r = await status({});
    expect(r.json).not.toHaveProperty("destroy_at");
  });

  it("a timer for another instance is ignored", async () => {
    const r = await runCli(["status", "43", "--json"], {
      env: routes({ ...instances(43), ...JOBS }),
    });
    expect(JSON.parse(r.stdout)).not.toHaveProperty("destroy_at");
  });

  it("a failed listing just omits the field", async () => {
    const r = await status({ "show scheduled-jobs": { stdout: "oops" } });
    expect(r.exitCode).toBe(0);
    expect(r.json).not.toHaveProperty("destroy_at");
  });

  it("makes exactly one scheduled-jobs call", async () => {
    const { log, env } = withLog();
    await runCli(["status", "42"], {
      env: { ...env, ...routes({ ...instances(42), ...JOBS }) },
    });
    expect(vastCalls(log, "show", "scheduled-jobs")).toHaveLength(1);
  });
});

describe("dashboard shows destroy_at and leftover timers", () => {
  const dash = (over: Record<string, unknown>) =>
    runCli([], { env: routes({ ...instances(42, 43), ...over }) });

  it("E58: no timers means no destroy_at column at all", async () => {
    const { stdout } = await dash({});
    expect(stdout).not.toContain("destroy_at");
    expect(stdout).not.toContain("Leftover");
  });

  it("adds destroy_at to every running row when one instance has a timer", async () => {
    const { stdout, exitCode } = await dash(JOBS);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("gpu_util,idle,destroy_at}:");
    expect(stdout).toContain("2026-10-21T04:00Z");
    const row43 = stdout.split("\n").find((l) => l.includes("job43"));
    expect(row43).toMatch(/,null$/);
  });

  it("E58: a timer for a gone instance becomes a help line", async () => {
    const { stdout } = await dash(JOBS);
    expect(stdout).toContain(
      "Leftover destroy timer job 5090 for gone instance 777: `vast-axi destroy 777` removes it",
    );
    // Instance 42's own timers are not leftovers.
    expect(stdout).not.toContain("Leftover destroy timer job 5080");
  });

  it("a leftover-only account adds the hint but no destroy_at column", async () => {
    const { stdout } = await runCli([], {
      env: routes({ ...instances(43), ...JOBS }),
    });
    expect(stdout).not.toContain("destroy_at");
    expect(stdout).toContain("Leftover destroy timer job 5080 for gone");
  });

  it("a failed listing changes nothing", async () => {
    const plain = await dash({});
    const broken = await dash({ "show scheduled-jobs": { stdout: "oops" } });
    expect(broken.exitCode).toBe(0);
    expect(broken.stdout).toBe(plain.stdout);
  });
});
