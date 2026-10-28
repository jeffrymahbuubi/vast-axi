import { describe, expect, it } from "vitest";
import { build, finished, vastCalls, withLog } from "./helpers/finish-world.js";
import { runCli, type Env } from "./helpers/run-cli.js";

// DAILY destroy timers (rent --max-hours since v0.1.8) and legacy HOURLY ones
// (v0.1.4 to v0.1.6, which vast.ai fires at the next :00 whatever start_time says).
// Clock: 2026-10-20T16:40:00Z. Fixtures: tests/fixtures/u11-jobs.json (DAILY, hours 4
// and 5 for instance 42) and u11-jobs-legacy.json (HOURLY job 5100 for instance 42).
const NOW = "1792514400";
const routes = (over: Record<string, unknown>): Env => ({
  FAKE_VASTAI_ROUTES: JSON.stringify(over),
  VAST_AXI_NOW: NOW,
});
const DAILY = { "show scheduled-jobs": { fixture: "u11-jobs.json" } };
const LEGACY = { "show scheduled-jobs": { fixture: "u11-jobs-legacy.json" } };
const deletes = (calls: Array<{ tokens: string[] }>) =>
  calls
    .filter((c) => c.tokens[0] === "delete" && c.tokens[1] === "scheduled-job")
    .map((c) => c.tokens[2]);

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
  start_date: Date.now() / 1000 - 7200,
  gpu_util: 80,
});
const instances = (...ids: number[]) => ({
  "show instances": { stdout: JSON.stringify(ids.map(running)) },
});

const status = async (over: Record<string, unknown>) => {
  const out = await runCli(["status", "42", "--json"], {
    env: routes({ ...instances(42), ...over }),
  });
  return { ...out, json: JSON.parse(out.stdout) as Record<string, unknown> };
};

describe("E106: status shows a DAILY timer's planned time", () => {
  it("hour 10, created 07:38:13Z -> 10:00Z the same day (not the 08:00Z an HOURLY job would fire)", async () => {
    const r = await status({
      "show scheduled-jobs": {
        stdout: JSON.stringify([
          {
            id: 5200,
            api_endpoint: "/api/v0/instances/42/",
            request_method: "DELETE",
            instance_id: 42,
            start_time: 1792568293,
            end_time: 1792568293 + 2 * 86400,
            frequency: "DAILY",
            hour_of_the_day: 10,
            day_of_the_week: null,
            last_executed_around: null,
          },
        ]),
      },
      // The clock is the 07:38Z creation time, so a wrong HOURLY rule would say 08:00Z.
    });
    expect(r.exitCode).toBe(0);
    expect(r.json["destroy_at"]).toBe("2026-10-21T10:00Z");
    expect(r.json).not.toHaveProperty("destroy_timer");
  });

  it("the fixture's DAILY timers give the earliest hour (04:00Z)", async () => {
    const r = await status(DAILY);
    expect(r.json["destroy_at"]).toBe("2026-10-21T04:00Z");
    expect(r.json).not.toHaveProperty("destroy_timer");
  });
});

describe("E107: status flags a legacy HOURLY timer as dangerous", () => {
  it("destroy_timer says it fires at the next :00 and the help gives the delete command", async () => {
    const r = await status(LEGACY);
    expect(r.exitCode).toBe(0);
    // 16:40Z now -> next :00 is 17:00Z, not the 03:50Z start_time.
    expect(r.json["destroy_at"]).toBe("2026-10-20T17:00Z");
    expect(r.json["destroy_timer"]).toBe(
      "legacy HOURLY, fires at the next :00 (2026-10-20T17:00Z)",
    );
    const help = r.json["help"] as string[];
    expect(help[0]).toContain("Legacy destroy timer job 5100");
    expect(help[0]).toContain(
      "Delete it now: `vast-axi raw delete scheduled-job 5100`",
    );
    expect(help[0]).toContain(
      "vast-axi finish 42 --wait --fetch <remote>:<local> --destroy",
    );
  });

  it("text output carries the flag too", async () => {
    const out = await runCli(["status", "42"], {
      env: routes({ ...instances(42), ...LEGACY }),
    });
    expect(out.stdout).toContain(
      'destroy_timer: "legacy HOURLY, fires at the next :00 (2026-10-20T17:00Z)"',
    );
  });
});

describe("E108: the dashboard flags a legacy HOURLY timer", () => {
  const dash = (over: Record<string, unknown>) =>
    runCli([], { env: routes({ ...instances(42, 43), ...over }) });

  it("marks the destroy_at cell LEGACY and leads the help with the delete command", async () => {
    const { stdout, exitCode } = await dash(LEGACY);
    expect(exitCode).toBe(0);
    const row42 = stdout.split("\n").find((l) => l.includes("job42"));
    expect(row42).toContain("2026-10-20T17:00Z LEGACY");
    const row43 = stdout.split("\n").find((l) => l.includes("job43"));
    expect(row43).toMatch(/,null$/);
    expect(stdout).toContain(
      "Delete it now: `vast-axi raw delete scheduled-job 5100`",
    );
    const helpAt = stdout.indexOf("Legacy destroy timer job 5100");
    expect(helpAt).toBeGreaterThan(-1);
    expect(helpAt).toBeLessThan(stdout.indexOf("Run `vast-axi status <id>`"));
  });

  it("a DAILY timer is not flagged", async () => {
    const { stdout } = await dash(DAILY);
    expect(stdout).toContain("2026-10-21T04:00Z");
    expect(stdout).not.toContain("LEGACY");
    expect(stdout).not.toContain("Legacy destroy timer");
  });
});

describe("E109: clean-up removes DAILY and legacy HOURLY timers alike", () => {
  const both = {
    "show scheduled-jobs": {
      stdout: JSON.stringify([
        {
          id: 5300,
          api_endpoint: "/api/v0/instances/42/",
          request_method: "DELETE",
          instance_id: 42,
          start_time: 1792514400,
          frequency: "DAILY",
          hour_of_the_day: 4,
          last_executed_around: 1792555212,
          status: "IN-PROGRESS",
        },
        {
          id: 5301,
          api_endpoint: "/api/v0/instances/42/",
          request_method: "DELETE",
          instance_id: 42,
          start_time: 1792514400,
          frequency: "HOURLY",
        },
      ]),
    },
  };

  it("destroy deletes the fired DAILY job and the HOURLY one", async () => {
    const { log, env } = withLog();
    const out = await runCli(["destroy", "42", "--json"], {
      env: { ...env, ...routes(both) },
    });
    expect(out.exitCode).toBe(0);
    const json = JSON.parse(out.stdout) as Record<string, unknown>;
    expect(json["destroy_timer"]).toBe("removed jobs 5300, 5301");
    expect(deletes(vastCalls(log))).toEqual(["5300", "5301"]);
  });

  it("finish --destroy deletes both too", async () => {
    const { log, env } = withLog();
    const w = build({ probes: [finished()] });
    const out = await runCli(["finish", "42", "--destroy", "--json"], {
      registry: w.registry,
      env: { ...env, ...routes(both) },
    });
    expect(out.exitCode).toBe(0);
    const json = JSON.parse(out.stdout) as Record<string, unknown>;
    expect(json["destroy_timer"]).toBe("removed jobs 5300, 5301");
    expect(deletes(vastCalls(log))).toEqual(["5300", "5301"]);
  });

  it("a fired DAILY job shows the 24 h retry as destroy_at", async () => {
    const r = await status({
      "show scheduled-jobs": {
        stdout: JSON.stringify([
          JSON.parse(both["show scheduled-jobs"].stdout)[0],
        ]),
      },
    });
    // fired at 04:00:12Z on 10-21 -> next 04:00Z is the day after
    expect(r.json["destroy_at"]).toBe("2026-10-22T04:00Z");
  });
});
