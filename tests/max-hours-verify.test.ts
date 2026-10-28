import { afterEach, describe, expect, it } from "vitest";
import { scheduleOk } from "./helpers/fake-rest.js";
import {
  IMG,
  INSTANCE,
  KEY,
  closeRest,
  created,
  destroyed,
  jobDeletes,
  jobsRoute,
  dailyJob,
  rent,
  routes,
  serve,
  upstreamFailure,
  withBurn,
  withTimer,
  type Run,
} from "./helpers/max-hours-world.js";
import type { Env } from "./helpers/run-cli.js";

// rent --max-hours reads the job back after the POST (OQ42) and rolls the rental
// back when the job is missing or not what was asked for. Clock: 16:40Z, N=12,
// so the planned job is DAILY at UTC hour 4.
afterEach(closeRest);

const run = (env: Env) =>
  rent(["5001", ...IMG, "--max-hours", "12"], { VAST_API_KEY: KEY, ...env });

const rolledBack = (r: Run) => {
  expect(r.exitCode).toBe(1);
  expect(r.stdout).toContain("SCHEDULE_FAILED");
  expect(r.stdout).toContain("destroyed because its destroy timer");
  expect(created(r)).toHaveLength(1);
  expect(destroyed(r)).toHaveLength(1);
  expect(destroyed(r)[0]!.tokens[2]).toBe(String(INSTANCE));
  expect(r.stdout).not.toContain("destroy_timer:");
  expect(r.stdout).not.toContain(KEY);
  expect(JSON.stringify(r.calls)).not.toContain(KEY);
};

describe("E104: the read-back must match, or the rental is rolled back", () => {
  it.each([
    ["hour", { hour_of_the_day: 5 }, "hour_of_the_day 5 instead of 4"],
    ["frequency", { frequency: "HOURLY" }, "frequency HOURLY instead of DAILY"],
    ["method", { request_method: "GET" }, "method GET instead of DELETE"],
    [
      "instance",
      { instance_id: 99, api_endpoint: "/api/v0/instances/99/" },
      `does not target instance ${INSTANCE}`,
    ],
  ])(
    "E104: a listed job with the wrong %s deletes the job, destroys the instance, exit 1",
    async (_name, over, text) => {
      const fake = await serve(() => scheduleOk(5081));
      const r = await run(withTimer(4, 5081, over));
      rolledBack(r);
      expect(r.stdout).toContain("does not match what was requested");
      expect(r.stdout).toContain(text);
      expect(fake.requests).toHaveLength(1);
      expect(jobDeletes(r).map((c) => c.tokens[2])).toEqual(["5081"]);
      // the job is removed before the instance is destroyed
      expect(r.tokens.indexOf("delete scheduled-job 5081")).toBeLessThan(
        r.tokens.findIndex((t) => t.startsWith("destroy instance")),
      );
    },
  );

  it("E104: a job id that is not listed destroys the instance (nothing to delete)", async () => {
    await serve(() => scheduleOk(5081));
    const r = await run(routes(jobsRoute([dailyJob(6000, 4)]), withBurn));
    rolledBack(r);
    expect(r.stdout).toContain("not in `show scheduled-jobs`");
    expect(jobDeletes(r)).toHaveLength(0);
  });

  it("E104: an unreadable job list cannot verify the timer: it is deleted, the instance destroyed", async () => {
    await serve(() => scheduleOk(5081));
    const r = await run(
      routes({ "show scheduled-jobs": upstreamFailure("backend down") }),
    );
    rolledBack(r);
    expect(r.stdout).toContain("could not read scheduled job 5081 back");
    expect(jobDeletes(r).map((c) => c.tokens[2])).toEqual(["5081"]);
  });

  it("E104: a failing job delete does not stop the rollback", async () => {
    await serve(() => scheduleOk(5081));
    const r = await run(
      routes(
        { "delete scheduled-job": upstreamFailure("nope") },
        withTimer(4, 5081, { hour_of_the_day: 9 }),
      ),
    );
    rolledBack(r);
  });

  it("E104: if the rollback destroy fails too, it says the instance is STILL RUNNING", async () => {
    await serve(() => scheduleOk(5081));
    const r = await run(
      routes(
        { "destroy instance": upstreamFailure("backend down") },
        withTimer(4, 5081, { hour_of_the_day: 9 }),
      ),
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain(`Instance ${INSTANCE} is STILL RUNNING`);
    expect(r.stdout).toContain("billing");
    expect(r.stdout).not.toContain(KEY);
  });

  it("E104: a matching job succeeds (same flow, hour 4)", async () => {
    await serve(() => scheduleOk(5081));
    const r = await run(withTimer(4));
    expect(r.exitCode).toBe(0);
    expect(destroyed(r)).toHaveLength(0);
    expect(jobDeletes(r)).toHaveLength(0);
  });
});

describe("E105: HTTP 422 job_exists", () => {
  it("rolls the rental back and says a timer already exists", async () => {
    const fake = await serve(() => ({
      status: 422,
      body: { error: "job_exists", msg: "a job already exists" },
    }));
    const r = await run(withTimer(4));
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("SCHEDULE_FAILED");
    expect(r.stdout).toContain("a destroy timer already exists");
    expect(r.stdout).toContain("job_exists");
    expect(destroyed(r)).toHaveLength(1);
    // it is not our job: nothing is read back or deleted
    expect(jobDeletes(r)).toHaveLength(0);
    expect(r.tokens).not.toContain("show scheduled-jobs");
    expect(fake.requests).toHaveLength(1);
    expect(r.stdout).not.toContain(KEY);
  });

  it("a 422 without the job_exists text is treated the same", async () => {
    await serve(() => ({ status: 422, body: { error: "bad" } }));
    const r = await run(withTimer(4));
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("a destroy timer already exists");
    expect(destroyed(r)).toHaveLength(1);
  });
});
