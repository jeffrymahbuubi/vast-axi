import { afterEach, describe, expect, it } from "vitest";
import { scheduleOk, startFakeRest } from "./helpers/fake-rest.js";
import {
  INSTANCE,
  KEY,
  NOW,
  closeRest,
  dailyJob,
  jobsRoute,
  routes,
  serve,
  withBurn,
} from "./helpers/max-hours-world.js";
import {
  newCallLog,
  readCallLog,
  runCli,
  type Env,
} from "./helpers/run-cli.js";

// BF1 (G3, G4): `timer --max-hours` says "unchanged" / "no timer was set" only when
// vast.ai answered with an HTTP status; no answer or a failed read-back is "may or may not".
afterEach(closeRest);

const OLD = "2026-10-21T04:00Z";
const withOld = routes(jobsRoute([dailyJob(5081, 4)]));

async function timer(env: Env) {
  const log = newCallLog();
  const { stdout, exitCode } = await runCli(
    ["timer", String(INSTANCE), "--max-hours", "3", "--json"],
    {
      env: {
        ...withBurn,
        FAKE_VASTAI_LOG: log,
        VAST_AXI_NOW: NOW,
        VAST_API_KEY: KEY,
        VAST_AXI_REST_TIMEOUT_MS: "300",
        ...env,
      },
    },
  );
  const calls = readCallLog(log);
  const bad = calls.filter(
    (c) =>
      c.tokens[0] === "destroy" ||
      c.tokens[0] === "stop" ||
      (c.tokens[0] === "delete" && c.tokens[1] === "scheduled-job"),
  );
  return { stdout, exitCode, bad, calls };
}

describe("timer --max-hours: uncertain outcomes", () => {
  it("E171: a PUT that times out may or may not have moved; no delete call", async () => {
    const fake = await serve(() => ({ hang: true }));
    const r = await timer({ ...withOld, VAST_AXI_API_URL: fake.url });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("TIMER_FAILED");
    expect(r.stdout).toContain(
      `the timer may or may not have moved; it was ${OLD}`,
    );
    expect(r.stdout).not.toContain("timer unchanged");
    expect(r.stdout).toContain(`vast-axi timer ${INSTANCE}`);
    expect(r.bad).toHaveLength(0);
  });

  it("E171: a dropped connection is also uncertain", async () => {
    const fake = await startFakeRest();
    const url = fake.url;
    await fake.close();
    const r = await timer({ ...withOld, VAST_AXI_API_URL: url });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("could not confirm the timer change");
    expect(r.stdout).toContain("may or may not have moved");
    expect(r.bad).toHaveLength(0);
  });

  it.each([
    ["a 400", { status: 400, body: { error: "bad" } }],
    ["a 500", { status: 500, body: { error: "boom" } }],
    [
      "a 2xx with success false",
      { status: 200, body: { success: false, msg: "nope" } },
    ],
  ])("E172: %s on the PUT is certain: unchanged", async (_n, reply) => {
    const fake = await serve(() => reply);
    const r = await timer({ ...withOld, VAST_AXI_API_URL: fake.url });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain(`timer unchanged, still ${OLD}`);
    expect(r.stdout).not.toContain("may or may not");
    expect(r.bad).toHaveLength(0);
  });

  it("E173: create, a POST that times out may leave no timer", async () => {
    const fake = await serve(() => ({ hang: true }));
    const r = await timer({
      ...routes(jobsRoute([])),
      VAST_AXI_API_URL: fake.url,
    });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("TIMER_FAILED");
    expect(r.stdout).toContain("the instance may have no timer");
    expect(r.stdout).toContain(`vast-axi timer ${INSTANCE}`);
    expect(r.stdout).not.toContain("no timer was set");
  });

  it("E173: create, POST ok but read-back and delete both fail: may have no timer", async () => {
    const fake = await serve(() => scheduleOk(5090));
    const r = await timer({
      ...routes({
        "show scheduled-jobs": {
          sequence: [
            { stdout: "[]" },
            { stderr: "Traceback: boom\n", exit: 1 },
          ],
        },
        "delete scheduled-job": { stderr: "Traceback: boom\n", exit: 1 },
      }),
      VAST_AXI_API_URL: fake.url,
    });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("the instance may have no timer");
    expect(r.stdout).not.toContain("no timer was set");
    expect(
      r.calls.filter(
        (c) => c.tokens[0] === "destroy" || c.tokens[0] === "stop",
      ),
    ).toHaveLength(0);
  });

  it("E174: create, a POST that answers 500 means no timer was set", async () => {
    const fake = await serve(() => ({ status: 500, body: { error: "down" } }));
    const r = await timer({
      ...routes(jobsRoute([])),
      VAST_AXI_API_URL: fake.url,
    });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("no timer was set");
    expect(r.stdout).not.toContain("may have no timer");
    expect(r.bad).toHaveLength(0);
  });

  it("E174: create, a 422 job_exists says a destroy timer already exists", async () => {
    const fake = await serve(() => ({
      status: 422,
      body: { error: "job_exists" },
    }));
    const r = await timer({
      ...routes(jobsRoute([])),
      VAST_AXI_API_URL: fake.url,
    });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("a destroy timer already exists");
    expect(r.stdout).toContain(`vast-axi timer ${INSTANCE}`);
    expect(r.stdout).not.toContain("no timer was set");
    expect(r.bad).toHaveLength(0);
  });
});
