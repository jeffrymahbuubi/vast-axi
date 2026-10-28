import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  destroyAtFor,
  destroyTarget,
  isoMinute,
  jobDestroyAt,
  jobFire,
  nowSec,
  planDestroy,
  timerSummaryFor,
} from "../src/destroy-timer.js";
import { takeMaxHoursFlag } from "../src/rent-timer.js";
import { findApiKey, scrubSecrets } from "../src/vast-rest.js";
import { withEnv } from "./helpers/run-cli.js";

const at = (iso: string): number => Date.parse(iso) / 1000;

describe("E67: destroy_at rounds down to the hour", () => {
  it.each([
    // [now, maxHours, destroy_at, runs_for_h]
    ["2026-10-20T16:40:00Z", 12, "2026-10-21T04:00Z", 11.3],
    ["2026-10-20T16:59:00Z", 2, "2026-10-20T18:00Z", 1.0],
    ["2026-10-20T16:00:00Z", 2, "2026-10-20T18:00Z", 2.0],
    ["2026-10-20T16:00:01Z", 2, "2026-10-20T18:00Z", 2.0],
    ["2026-10-20T16:30:00Z", 2.5, "2026-10-20T19:00Z", 2.5],
    ["2026-10-20T23:30:00Z", 23, "2026-10-21T22:00Z", 22.5],
  ])("now %s, N=%s -> %s (%s h)", (now, n, iso, runs) => {
    const plan = planDestroy(at(now), n);
    expect(isoMinute(plan.destroyAt)).toBe(iso);
    expect(plan.runsForH).toBe(runs);
    // Rounding down: the rental can never outlast N hours.
    expect(plan.destroyAt - at(now)).toBeLessThanOrEqual(n * 3600);
    expect(plan.destroyAt % 3600).toBe(0);
  });

  it("nowSec honours VAST_AXI_NOW and ignores garbage", async () => {
    await withEnv({ VAST_AXI_NOW: "1792514400" }, async () =>
      expect(nowSec()).toBe(1792514400),
    );
    await withEnv({ VAST_AXI_NOW: "soon" }, async () =>
      expect(Math.abs(nowSec() - Date.now() / 1000)).toBeLessThan(5),
    );
  });
});

describe("E101: planDestroy boundaries (DAILY hour and window)", () => {
  it.each([
    // [now, N, destroy_at, hour]
    ["2026-10-21T05:20:00Z", 14, "2026-10-21T19:00Z", 19],
    ["2026-10-20T23:30:00Z", 2, "2026-10-21T01:00Z", 1],
    ["2026-10-20T16:40:00Z", 12, "2026-10-21T04:00Z", 4],
    ["2026-10-20T00:00:00Z", 23, "2026-10-20T23:00Z", 23],
    ["2026-10-20T22:59:59Z", 2, "2026-10-21T00:00Z", 0],
  ])("now %s, N=%s -> %s, hour %s", (now, n, iso, hour) => {
    const plan = planDestroy(at(now), n);
    expect(isoMinute(plan.destroyAt)).toBe(iso);
    expect(plan.hour).toBe(hour);
  });

  it("the window is [floor(now), destroy_at + 1 day + 1 h], integer seconds", () => {
    const now = at("2026-10-21T05:20:00Z") + 0.7;
    const plan = planDestroy(now, 14);
    expect(plan.startTime).toBe(at("2026-10-21T05:20:00Z"));
    expect(plan.endTime).toBe(at("2026-10-22T20:00:00Z"));
    expect(Number.isInteger(plan.startTime)).toBe(true);
    expect(Number.isInteger(plan.endTime)).toBe(true);
  });

  it("the next hour:00 after now is exactly destroy_at for every N in 2..23", () => {
    for (const now of [
      at("2026-10-20T16:00:00Z"),
      at("2026-10-20T16:00:01Z"),
      at("2026-10-20T23:59:59Z"),
      at("2026-10-21T00:00:00Z"),
    ]) {
      for (const n of [2, 2.7, 5, 12, 22.9, 23]) {
        const plan = planDestroy(now, n);
        expect(plan.destroyAt).toBeGreaterThan(now);
        const tops: number[] = [];
        for (
          let t = Math.ceil(now / 3600) * 3600;
          t <= plan.destroyAt;
          t += 3600
        ) {
          if (new Date(t * 1000).getUTCHours() === plan.hour) tops.push(t);
        }
        expect(tops).toEqual([plan.destroyAt]);
      }
    }
  });
});

describe("E103: --max-hours range (2 to 23)", () => {
  const take = (v: string[]) => takeMaxHoursFlag(v);
  it.each([["2"], ["2.0"], ["12"], ["23"], ["3.5"]])("accepts %s", (v) => {
    expect(take(["--max-hours", v])).toBe(Number(v));
  });
  it.each([["1.9"], ["1.5"], ["1"], ["0"], ["-3"], ["abc"], ["NaN"]])(
    "rejects %s with VALIDATION_ERROR naming the range",
    (v) => {
      expect(() => take(["--max-hours", v])).toThrow(
        /--max-hours must be a number from 2 to 23/,
      );
    },
  );
  it.each([["24"], ["24.5"], ["720"], ["721"], ["1e9"]])(
    "rejects %s and explains the 23 h cap and the finish alternative",
    (v) => {
      let err: unknown;
      try {
        take(["--max-hours", v]);
      } catch (error) {
        err = error;
      }
      expect(String(err)).toContain(
        "--max-hours must be a number from 2 to 23",
      );
      expect(String(err)).toContain("23 h");
      expect(
        (err as { suggestions: string[] }).suggestions.join("\n"),
      ).toContain(
        "vast-axi finish <id> --wait --fetch <remote>:<local> --destroy",
      );
    },
  );
  it("a missing value is an error", () => {
    expect(() => take(["--max-hours"])).toThrow(/requires a value/);
  });
  it("accepts --max-hours=N", () => {
    expect(take(["--max-hours=4"])).toBe(4);
  });
});

describe("scheduled job helpers", () => {
  const job = (over: Record<string, unknown> = {}) => ({
    id: 1,
    api_endpoint: "/api/v0/instances/42/",
    request_method: "DELETE",
    instance_id: 42,
    start_time: 1792554600.0,
    frequency: "DAILY",
    hour_of_the_day: 4,
    ...over,
  });
  const NOW = 1792514400; // 2026-10-20T16:40:00Z

  it("destroyTarget accepts only a DELETE on the job's own instance endpoint, whatever the frequency", () => {
    expect(destroyTarget(job())).toBe(42);
    expect(destroyTarget(job({ frequency: "HOURLY" }))).toBe(42);
    expect(destroyTarget(job({ request_method: "GET" }))).toBeUndefined();
    expect(
      destroyTarget(job({ api_endpoint: "/api/v0/instances/43/" })),
    ).toBeUndefined();
    expect(destroyTarget(job({ instance_id: null }))).toBeUndefined();
    expect(destroyTarget(job({ instance_id: 42.5 }))).toBeUndefined();
  });

  it("E106: a DAILY job fires at the first hour:00 at or after start_time (hour 10, created 07:38Z)", () => {
    const j = job({ start_time: 1792568293, hour_of_the_day: 10 });
    expect(isoMinute(jobDestroyAt(j, NOW)!)).toBe("2026-10-21T10:00Z");
    expect(jobFire(j, NOW)).toEqual({
      at: at("2026-10-21T10:00:00Z"),
      legacy: false,
    });
  });

  it("E106: DAILY edge cases (hour already past today, exactly on the hour, wraps midnight)", () => {
    // created 23:30Z, hour 1 -> tomorrow 01:00Z
    expect(
      isoMinute(
        jobDestroyAt(
          job({ start_time: at("2026-10-20T23:30:00Z"), hour_of_the_day: 1 }),
        )!,
      ),
    ).toBe("2026-10-21T01:00Z");
    // start exactly on the hour counts ("at or after")
    expect(
      jobDestroyAt(
        job({ start_time: at("2026-10-21T10:00:00Z"), hour_of_the_day: 10 }),
      ),
    ).toBe(at("2026-10-21T10:00:00Z"));
    // a fired job (retry) next fires 24 h later
    expect(
      isoMinute(
        jobDestroyAt(
          job({
            start_time: 1792568293,
            hour_of_the_day: 10,
            last_executed_around: at("2026-10-21T10:00:12Z"),
            status: "IN-PROGRESS",
          }),
        )!,
      ),
    ).toBe("2026-10-22T10:00Z");
    // unusable hour or start_time
    expect(jobDestroyAt(job({ hour_of_the_day: null }))).toBeUndefined();
    expect(jobDestroyAt(job({ hour_of_the_day: 24 }))).toBeUndefined();
    expect(jobDestroyAt(job({ start_time: undefined }))).toBeUndefined();
  });

  it("E107: a legacy HOURLY job fires at the next :00 counted from now, ignoring start_time, and is flagged", () => {
    const j = job({ frequency: "HOURLY", hour_of_the_day: null });
    expect(jobFire(j, at("2026-10-21T07:38:00Z"))).toEqual({
      at: at("2026-10-21T08:00:00Z"),
      legacy: true,
    });
    // exactly on the hour fires right now
    expect(jobDestroyAt(j, at("2026-10-21T08:00:00Z"))).toBe(
      at("2026-10-21T08:00:00Z"),
    );
  });

  it("destroyAtFor / timerSummaryFor take the earliest timer of that instance only", () => {
    const jobs = [
      job({ id: 2, start_time: 1792558200, hour_of_the_day: 5 }),
      job({ id: 3 }),
      job({ id: 4, instance_id: 7, api_endpoint: "/api/v0/instances/7/" }),
    ];
    expect(destroyAtFor(jobs, 42, NOW)).toBe("2026-10-21T04:00Z");
    expect(destroyAtFor(jobs, 8, NOW)).toBeUndefined();
    expect(timerSummaryFor(jobs, 42, NOW)).toEqual({
      destroyAt: "2026-10-21T04:00Z",
      legacy: [],
    });
  });

  it("timerSummaryFor lists legacy HOURLY jobs", () => {
    const jobs = [job({ id: 9, frequency: "HOURLY", hour_of_the_day: null })];
    expect(timerSummaryFor(jobs, 42, NOW)).toEqual({
      destroyAt: "2026-10-20T17:00Z",
      legacy: [{ jobId: 9, at: "2026-10-20T17:00Z" }],
    });
  });
});

describe("API key lookup (never the developer's real key)", () => {
  function home(): { dir: string; xdg: string } {
    const dir = mkdtempSync(join(tmpdir(), "vast-axi-key-"));
    return { dir, xdg: join(dir, "xdg") };
  }
  const env = (dir: string, xdg: string | undefined) => ({
    VAST_API_KEY: undefined,
    HOME: dir,
    USERPROFILE: dir,
    XDG_CONFIG_HOME: xdg,
  });

  it("finds nothing when the key is nowhere", async () => {
    const { dir, xdg } = home();
    await withEnv(env(dir, xdg), async () =>
      expect(findApiKey()).toBeUndefined(),
    );
  });

  it("VAST_API_KEY wins and is trimmed", async () => {
    const { dir, xdg } = home();
    mkdirSync(join(xdg, "vastai"), { recursive: true });
    writeFileSync(join(xdg, "vastai", "vast_api_key"), "from-file\n");
    await withEnv(
      { ...env(dir, xdg), VAST_API_KEY: "  from-env \n" },
      async () => expect(findApiKey()).toBe("from-env"),
    );
  });

  it("then $XDG_CONFIG_HOME/vastai/vast_api_key, trimmed", async () => {
    const { dir, xdg } = home();
    mkdirSync(join(xdg, "vastai"), { recursive: true });
    writeFileSync(join(xdg, "vastai", "vast_api_key"), "  from-xdg \r\n");
    writeFileSync(join(dir, ".vast_api_key"), "legacy");
    await withEnv(env(dir, xdg), async () =>
      expect(findApiKey()).toBe("from-xdg"),
    );
  });

  it("falls back to ~/.config/vastai/vast_api_key when XDG_CONFIG_HOME is unset", async () => {
    const { dir } = home();
    mkdirSync(join(dir, ".config", "vastai"), { recursive: true });
    writeFileSync(join(dir, ".config", "vastai", "vast_api_key"), "from-dot");
    await withEnv(env(dir, undefined), async () =>
      expect(findApiKey()).toBe("from-dot"),
    );
  });

  it("then the legacy ~/.vast_api_key", async () => {
    const { dir, xdg } = home();
    writeFileSync(join(dir, ".vast_api_key"), "legacy\n");
    await withEnv(env(dir, xdg), async () =>
      expect(findApiKey()).toBe("legacy"),
    );
  });

  it("an empty key file counts as missing", async () => {
    const { dir, xdg } = home();
    mkdirSync(join(xdg, "vastai"), { recursive: true });
    writeFileSync(join(xdg, "vastai", "vast_api_key"), "  \n");
    await withEnv(env(dir, xdg), async () =>
      expect(findApiKey()).toBeUndefined(),
    );
  });
});

describe("scrubSecrets", () => {
  it("removes the key value, bearer tokens and long hex", () => {
    const key = "file-key-123";
    const text = `bad: ${key} / Authorization: Bearer abc.def / ${"a".repeat(48)}`;
    const out = scrubSecrets(text, key);
    expect(out).not.toContain(key);
    expect(out).not.toContain("abc.def");
    expect(out).not.toContain("a".repeat(48));
  });
});
