import { afterEach, describe, expect, it } from "vitest";
import { scheduleOk, startFakeRest, updateOk } from "./helpers/fake-rest.js";
import {
  INSTANCE,
  KEY,
  NOW,
  closeRest,
  dailyJob,
  emptyHome,
  jobsRoute,
  routes,
  serve,
  upstreamFailure,
  withBurn,
} from "./helpers/max-hours-world.js";
import {
  newCallLog,
  readCallLog,
  runCli,
  type Env,
} from "./helpers/run-cli.js";

// `vast-axi timer`. Clock pinned to 2026-10-20T16:40:00Z: --max-hours 3 destroys at
// 19:00Z (UTC hour 19); the old timer in these tests is DAILY at hour 4 (04:00Z tomorrow).
afterEach(closeRest);

const OLD = "2026-10-21T04:00Z";
const NEW = "2026-10-20T19:00Z";
const jobPath = "/api/v0/commands/schedule_job/5081/";

async function timer(argv: string[], env: Env = {}) {
  const log = newCallLog();
  const { stdout, exitCode } = await runCli(["timer", ...argv, "--json"], {
    env: {
      ...withBurn,
      FAKE_VASTAI_LOG: log,
      VAST_AXI_NOW: NOW,
      VAST_API_KEY: KEY,
      ...env,
    },
  });
  const calls = readCallLog(log);
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    // text output
  }
  return { stdout, exitCode, calls, json };
}

/** `show scheduled-jobs`: the old timer first, then (after the PUT) the given jobs. */
const afterPut = (...jobs: unknown[]) => ({
  "show scheduled-jobs": {
    sequence: [
      { stdout: JSON.stringify([dailyJob(5081, 4)]) },
      { stdout: JSON.stringify(jobs) },
    ],
  },
});
const moved = afterPut(dailyJob(5081, 19));
const stillOld = afterPut(dailyJob(5081, 4));
const withOld = routes(jobsRoute([dailyJob(5081, 4)]));
const none = (
  r: { calls: Array<{ tokens: string[] }> },
  a: string,
  b: string,
) => r.calls.filter((c) => c.tokens[0] === a && c.tokens[1] === b);

describe("timer: show", () => {
  it("E138: shows destroy_at and timer_left for an instance with a timer", async () => {
    const r = await timer([String(INSTANCE)], withOld);
    expect(r.exitCode).toBe(0);
    expect(r.json["instance"]).toBe(`#${INSTANCE}`);
    expect(r.json["destroy_at"]).toBe(OLD);
    expect(r.json["timer_left"]).toBe("11h20m");
    expect(r.json["destroy_timer"]).toBe(
      "vast.ai scheduled job 5081 (daily at 04:00 UTC)",
    );
  });

  it("E138: says destroy_timer: none, with the set hint, when there is no timer", async () => {
    const r = await timer([String(INSTANCE)]);
    expect(r.exitCode).toBe(0);
    expect(r.json["destroy_timer"]).toBe("none");
    expect(r.json["destroy_at"]).toBeUndefined();
    expect(JSON.stringify(r.json["help"])).toContain(
      `timer ${INSTANCE} --max-hours`,
    );
    expect(r.calls.some((c) => c.tokens[0] === "delete")).toBe(false);
  });

  it("E138: shows a legacy HOURLY timer with the legacy notice", async () => {
    const env = routes(jobsRoute([dailyJob(5081, 4, { frequency: "HOURLY" })]));
    const r = await timer([String(INSTANCE)], env);
    expect(r.exitCode).toBe(0);
    expect(String(r.json["destroy_timer"])).toContain("legacy HOURLY");
    expect(JSON.stringify(r.json["help"])).toContain(
      "raw delete scheduled-job 5081",
    );
  });
});

describe("timer --max-hours: move an existing timer", () => {
  it("E139: PUTs the nine fields to the job, reads it back, reports was and the new destroy_at", async () => {
    const fake = await serve(() => updateOk());
    const r = await timer([String(INSTANCE), "--max-hours", "3"], {
      ...routes(moved),
      VAST_AXI_API_URL: fake.url,
    });
    expect(r.exitCode).toBe(0);
    expect(fake.requests).toHaveLength(1);
    const req = fake.requests[0]!;
    expect(req.method).toBe("PUT");
    expect(req.url).toBe(jobPath);
    expect(req.headers["authorization"]).toBe(`Bearer ${KEY}`);
    expect(req.body).toEqual({
      start_time: 1792514400,
      end_time: 1792522800 + 86400 + 3600,
      api_endpoint: `/api/v0/instances/${INSTANCE}/`,
      request_method: "DELETE",
      request_body: {},
      day_of_the_week: null,
      hour_of_the_day: 19,
      frequency: "DAILY",
      instance_id: INSTANCE,
    });
    expect(r.json["destroy_at"]).toBe(NEW);
    expect(r.json["was"]).toBe(OLD);
    expect(r.json["max_hours"]).toBe(3);
    expect(r.json["runs_for_h"]).toBe(2.3);
    expect(String(r.json["destroy_timer"])).toContain(
      "scheduled job 5081 (daily at 19:00 UTC, verified",
    );
    expect(none(r, "delete", "scheduled-job")).toHaveLength(0);
    expect(none(r, "destroy", "instance")).toHaveLength(0);
  });

  it("E139: warns when the instance's contract ends before destroy_at", async () => {
    const fake = await serve(() => updateOk());
    const short = String(Number(NOW) + 3600);
    const r = await timer([String(INSTANCE), "--max-hours", "3"], {
      ...routes({
        ...moved,
        [`show instance ${INSTANCE}`]: {
          stdout: JSON.stringify({
            id: INSTANCE,
            actual_status: "running",
            end_date: Number(short),
          }),
        },
      }),
      VAST_AXI_API_URL: fake.url,
    });
    expect(r.exitCode).toBe(0);
    expect(String(r.json["contract_warning"])).toContain("2026-10-20T17:40Z");
  });
});

describe("timer --max-hours: failures", () => {
  it.each([
    ["a 500", { status: 500, body: { error: "boom" } }, "HTTP 500"],
    ["a 422", { status: 422, body: { error: "bad" } }, "HTTP 422"],
    ["a 401", { status: 401, body: { error: "unauthorized" } }, "HTTP 401"],
  ])(
    "E140: %s on the PUT is TIMER_FAILED, timer unchanged, nothing deleted",
    async (_n, reply, text) => {
      const fake = await serve(() => reply);
      const r = await timer([String(INSTANCE), "--max-hours", "3"], {
        ...withOld,
        VAST_AXI_API_URL: fake.url,
      });
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain("TIMER_FAILED");
      expect(r.stdout).toContain(text);
      expect(r.stdout).toContain(`timer unchanged, still ${OLD}`);
      expect(none(r, "delete", "scheduled-job")).toHaveLength(0);
      expect(none(r, "destroy", "instance")).toHaveLength(0);
      expect(none(r, "stop", "instance")).toHaveLength(0);
    },
  );

  it("E140: a PUT that times out is TIMER_FAILED, may or may not have moved", async () => {
    const fake = await serve(() => ({ hang: true }));
    const r = await timer([String(INSTANCE), "--max-hours", "3"], {
      ...withOld,
      VAST_AXI_API_URL: fake.url,
      VAST_AXI_REST_TIMEOUT_MS: "300",
    });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("TIMER_FAILED");
    expect(r.stdout).toContain("no answer from the vast.ai API");
    expect(r.stdout).toContain("may or may not have moved");
    expect(none(r, "delete", "scheduled-job")).toHaveLength(0);
  });

  it("E141: a read-back that shows another hour is TIMER_FAILED naming the actual time; the job is not deleted", async () => {
    const fake = await serve(() => updateOk());
    const r = await timer([String(INSTANCE), "--max-hours", "3"], {
      ...routes(stillOld),
      VAST_AXI_API_URL: fake.url,
    });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("TIMER_FAILED");
    expect(r.stdout).toContain(`the timer now reads ${OLD}`);
    expect(r.stdout).toContain(`vast-axi timer ${INSTANCE}`);
    expect(none(r, "delete", "scheduled-job")).toHaveLength(0);
    expect(none(r, "destroy", "instance")).toHaveLength(0);
  });

  it("E141: a job missing from the read-back is TIMER_FAILED, not deleted", async () => {
    const fake = await serve(() => updateOk());
    const r = await timer([String(INSTANCE), "--max-hours", "3"], {
      ...routes(afterPut()),
      VAST_AXI_API_URL: fake.url,
    });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("TIMER_FAILED");
    expect(none(r, "delete", "scheduled-job")).toHaveLength(0);
  });

  it("E142: with no timer, POSTs, verifies and reports verified", async () => {
    const fake = await serve(() => scheduleOk(5090));
    const r = await timer([String(INSTANCE), "--max-hours", "3"], {
      // no timer at the first listing, the new job at the read-back
      ...routes({
        "show scheduled-jobs": {
          sequence: [
            { stdout: "[]" },
            { stdout: JSON.stringify([dailyJob(5090, 19)]) },
          ],
        },
      }),
      VAST_AXI_API_URL: fake.url,
    });
    expect(r.exitCode).toBe(0);
    expect(fake.requests[0]!.method).toBe("POST");
    expect(fake.requests[0]!.url).toBe("/api/v0/commands/schedule_job/");
    expect(r.json["destroy_at"]).toBe(NEW);
    expect(r.json["was"]).toBeUndefined();
    expect(String(r.json["destroy_timer"])).toContain(
      "scheduled job 5090 (daily at 19:00 UTC, verified",
    );
  });

  it("E142: with no timer, a failed create or verify is TIMER_FAILED and the instance is never destroyed", async () => {
    const fake = await startFakeRest(() => ({
      status: 500,
      body: { error: "down" },
    }));
    const a = await timer([String(INSTANCE), "--max-hours", "3"], {
      VAST_AXI_API_URL: fake.url,
    });
    await fake.close();
    expect(a.exitCode).toBe(1);
    expect(a.stdout).toContain("TIMER_FAILED");
    expect(none(a, "destroy", "instance")).toHaveLength(0);

    const ok = await startFakeRest(() => scheduleOk(5090));
    const b = await timer([String(INSTANCE), "--max-hours", "3"], {
      VAST_AXI_API_URL: ok.url,
    });
    await ok.close();
    expect(b.exitCode).toBe(1);
    expect(b.stdout).toContain("TIMER_FAILED");
    expect(b.stdout).toContain("not in `show scheduled-jobs`");
    expect(none(b, "destroy", "instance")).toHaveLength(0);
  });
});

describe("timer: refusals", () => {
  it("E143: a legacy HOURLY timer is refused with exit 2 and the delete hint", async () => {
    const fake = await serve(() => updateOk());
    const r = await timer([String(INSTANCE), "--max-hours", "3"], {
      ...routes(jobsRoute([dailyJob(5081, 4, { frequency: "HOURLY" })])),
      VAST_AXI_API_URL: fake.url,
    });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain("raw delete scheduled-job 5081");
    expect(fake.requests).toHaveLength(0);
  });

  it("E143: a missing instance is NOT_FOUND (with and without --max-hours)", async () => {
    const env = routes({
      [`show instance ${INSTANCE}`]: { stdout: '{"instances": null}' },
    });
    const a = await timer([String(INSTANCE)], env);
    expect(a.stdout).toContain("NOT_FOUND");
    const fake = await serve(() => updateOk());
    const b = await timer([String(INSTANCE), "--max-hours", "3"], {
      ...env,
      VAST_AXI_API_URL: fake.url,
    });
    expect(b.stdout).toContain("NOT_FOUND");
    expect(fake.requests).toHaveLength(0);
  });

  it("E143: no API key is CONFIG_ERROR before any call", async () => {
    const r = await timer([String(INSTANCE), "--max-hours", "3"], emptyHome());
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("CONFIG_ERROR");
    expect(r.calls).toHaveLength(0);
  });

  it.each(["1", "24"])("E143: --max-hours %s is exit 2", async (n) => {
    const r = await timer([String(INSTANCE), "--max-hours", n]);
    expect(r.exitCode).toBe(2);
    expect(r.calls).toHaveLength(0);
  });

  it("E143: an unknown flag and a missing id are exit 2", async () => {
    expect((await timer([String(INSTANCE), "--bogus"])).exitCode).toBe(2);
    expect((await timer([])).exitCode).toBe(2);
  });
});

describe("timer --max-hours: balance guard", () => {
  const burning = {
    "show instances": {
      stdout: JSON.stringify([
        { id: INSTANCE, actual_status: "running", dph_total: 6 },
      ]),
    },
  };

  it("E144: burn x hours above the balance is exit 2 unless --confirm", async () => {
    const fake = await serve(() => updateOk());
    const env = {
      ...routes({ ...burning, ...moved }),
      VAST_AXI_API_URL: fake.url,
    };
    const refused = await timer([String(INSTANCE), "--max-hours", "3"], env);
    expect(refused.exitCode).toBe(2);
    expect(refused.stdout).toContain("--confirm");
    expect(fake.requests).toHaveLength(0);
    const ok = await timer(
      [String(INSTANCE), "--max-hours", "3", "--confirm"],
      env,
    );
    expect(ok.exitCode).toBe(0);
    expect(fake.requests).toHaveLength(1);
  });

  it("E144: an unreadable balance proceeds with a guard note", async () => {
    const fake = await serve(() => updateOk());
    const r = await timer([String(INSTANCE), "--max-hours", "3"], {
      ...routes({ ...burning, ...moved, "show user": upstreamFailure("down") }),
      VAST_AXI_API_URL: fake.url,
    });
    expect(r.exitCode).toBe(0);
    expect(String(r.json["guard"])).toContain("balance not checked");
  });
});

describe("timer: key safety", () => {
  it("E145: a key echoed in a PUT error body is scrubbed from the output", async () => {
    const fake = await serve(() => ({
      status: 500,
      body: { error: `bad token ${KEY} and Bearer ${KEY}` },
    }));
    const r = await timer([String(INSTANCE), "--max-hours", "3"], {
      ...withOld,
      VAST_AXI_API_URL: fake.url,
    });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).not.toContain(KEY);
    expect(r.stdout).toContain("<redacted>");
  });

  it("E145: a redirect is refused and the key is not forwarded", async () => {
    const target = await startFakeRest(() => updateOk());
    const redirector = await serve(() => ({
      status: 307,
      headers: { Location: `${target.url}/elsewhere` },
    }));
    const r = await timer([String(INSTANCE), "--max-hours", "3"], {
      ...withOld,
      VAST_AXI_API_URL: redirector.url,
    });
    await target.close();
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("TIMER_FAILED");
    expect(r.stdout).not.toContain(KEY);
    expect(target.requests).toHaveLength(0);
  });
});
