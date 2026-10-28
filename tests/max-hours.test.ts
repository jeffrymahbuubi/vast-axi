import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scheduleOk } from "./helpers/fake-rest.js";
import {
  IMG,
  INSTANCE,
  KEY,
  closeRest,
  created,
  emptyHome,
  offerWithContract,
  rent,
  routes,
  serve,
  withBurn,
  withTimer,
} from "./helpers/max-hours-world.js";
import { runCli } from "./helpers/run-cli.js";

// rent --max-hours: success, validation, key lookup, balance and contract checks.
// The clock is pinned to 2026-10-20T16:40:00Z (see helpers/max-hours-world.ts);
// N=12 therefore destroys at 04:00Z, so the read-back lists a DAILY job at hour 4.
afterEach(closeRest);

const env12 = { ...withTimer(4), VAST_API_KEY: KEY };
const unix = (iso: string): number => Date.parse(iso) / 1000;

describe("rent --max-hours: success", () => {
  it("E102: creates the instance, then POSTs a DAILY job at the destroy hour with integer timestamps", async () => {
    const fake = await serve(() => scheduleOk(5081));
    const r = await rent(
      ["5001", ...IMG, "--max-hours", "12", "--json"],
      env12,
    );
    expect(r.exitCode).toBe(0);
    expect(r.tokens.indexOf("create instance 5001")).toBeGreaterThan(-1);
    expect(fake.requests).toHaveLength(1);
    const req = fake.requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("/api/v0/commands/schedule_job/");
    expect(req.headers["authorization"]).toBe(`Bearer ${KEY}`);
    expect(req.headers["content-type"]).toBe("application/json");
    // now 16:40Z + 12 h = 04:40Z -> destroy at 04:00Z (1792555200), UTC hour 4
    expect(req.body).toEqual({
      start_time: 1792514400,
      end_time: 1792555200 + 86400 + 3600,
      api_endpoint: `/api/v0/instances/${INSTANCE}/`,
      request_method: "DELETE",
      request_body: {},
      day_of_the_week: null,
      hour_of_the_day: 4,
      frequency: "DAILY",
      instance_id: INSTANCE,
    });
    expect(req.raw).not.toMatch(/\d\.\d+[,}]/); // no float timestamps
    // then it reads the job back (OQ42)
    expect(r.tokens.filter((t) => t === "show scheduled-jobs")).toHaveLength(1);
    expect(r.tokens.indexOf("show scheduled-jobs")).toBeGreaterThan(
      r.tokens.indexOf("create instance 5001"),
    );
  });

  it("E102: --max-hours 14 at 05:20Z destroys at 19:00Z, job hour 19", async () => {
    const now = unix("2026-10-21T05:20:00Z");
    const fake = await serve();
    const r = await rent(["5001", ...IMG, "--max-hours", "14", "--json"], {
      ...withTimer(19),
      VAST_API_KEY: KEY,
      VAST_AXI_NOW: String(now),
    });
    expect(r.exitCode).toBe(0);
    expect(r.json).toMatchObject({
      max_hours: 14,
      destroy_at: "2026-10-21T19:00Z",
      runs_for_h: 13.7,
    });
    expect(fake.requests[0]!.body).toMatchObject({
      hour_of_the_day: 19,
      frequency: "DAILY",
      start_time: now,
      end_time: unix("2026-10-22T20:00:00Z"),
    });
  });

  it("adds max_hours, destroy_at, runs_for_h and destroy_timer after the estimate, before the help", async () => {
    await serve(() => scheduleOk(5081));
    const r = await rent(
      ["5001", ...IMG, "--max-hours", "12", "--json"],
      env12,
    );
    expect(r.json).toMatchObject({
      instance_id: INSTANCE,
      type: "on-demand",
      hours: 12,
      max_hours: 12,
      destroy_at: "2026-10-21T04:00Z",
      runs_for_h: 11.3,
      destroy_timer:
        "vast.ai scheduled job 5081 (daily at 04:00 UTC, verified; server-side; runs even if this machine is off)",
    });
    const keys = Object.keys(r.json);
    expect(keys.indexOf("account_need")).toBeLessThan(
      keys.indexOf("max_hours"),
    );
    expect(keys.indexOf("destroy_timer")).toBeLessThan(keys.indexOf("help"));
    expect((r.json["help"] as string[]).join("\n")).toContain(
      "`vast-axi destroy 7835610` earlier also removes the timer",
    );
  });

  it("text output carries the same fields", async () => {
    await serve();
    const r = await rent(["5001", ...IMG, "--max-hours", "12"], env12);
    expect(r.stdout).toContain("max_hours: 12");
    expect(r.stdout).toContain("2026-10-21T04:00Z");
    expect(r.stdout).toContain("runs_for_h: 11.3");
    expect(r.stdout).toContain("destroy_timer:");
    expect(r.stdout).not.toContain(KEY);
  });

  it("without --max-hours there is no REST call and no key is needed", async () => {
    const fake = await serve();
    const r = await rent(["5001", ...IMG], { ...withBurn, ...emptyHome() });
    expect(r.exitCode).toBe(0);
    expect(fake.requests).toHaveLength(0);
    expect(r.stdout).not.toContain("max_hours");
    expect(r.stdout).not.toContain("destroy_timer");
    expect(r.tokens).not.toContain("show scheduled-jobs");
  });

  it("reads the key from the XDG file when VAST_API_KEY is unset", async () => {
    const fake = await serve();
    const home = emptyHome();
    mkdirSync(join(home["XDG_CONFIG_HOME"]!, "vastai"), { recursive: true });
    writeFileSync(
      join(home["XDG_CONFIG_HOME"]!, "vastai", "vast_api_key"),
      `  ${KEY}\n`,
    );
    // 16:40Z + 3 h = 19:40Z -> destroy at 19:00Z
    const r = await rent(["5001", ...IMG, "--max-hours", "3"], {
      ...withTimer(19),
      ...home,
    });
    expect(r.exitCode).toBe(0);
    expect(fake.requests[0]!.headers["authorization"]).toBe(`Bearer ${KEY}`);
  });
});

describe("E103: --max-hours validation (2 to 23)", () => {
  it.each([["2"], ["23"], ["2.5"]])(
    "E103: --max-hours %s is accepted",
    async (v) => {
      await serve();
      const n = Number(v);
      const hour = new Date((1792514400 + n * 3600) * 1000).getUTCHours();
      const r = await rent(["5001", ...IMG, "--max-hours", v], {
        ...withTimer(hour),
        VAST_API_KEY: KEY,
      });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain(`max_hours: ${v}`);
    },
  );

  it.each([["24"], ["24.5"], ["720"], ["721"], ["1e9"]])(
    "E103: --max-hours %s exits 2, explains the 23 h cap and runs nothing",
    async (v) => {
      const fake = await serve();
      const r = await rent(["5001", ...IMG, "--max-hours", v], env12);
      expect(r.exitCode).toBe(2);
      expect(r.stdout).toContain("VALIDATION_ERROR");
      expect(r.stdout).toContain("--max-hours must be a number from 2 to 23");
      expect(r.stdout).toContain("23 h");
      expect(r.stdout).toContain(
        "vast-axi finish <id> --wait --fetch <remote>:<local> --destroy",
      );
      expect(r.stdout).not.toContain("MAX_HOURS_DISABLED");
      expect(r.calls).toHaveLength(0);
      expect(fake.requests).toHaveLength(0);
    },
  );

  it.each([["1.5"], ["1.9"], ["1"], ["0"], ["abc"], ["Infinity"]])(
    "E103: --max-hours %s exits 2 and runs nothing",
    async (v) => {
      const fake = await serve();
      const r = await rent(["5001", ...IMG, "--max-hours", v], env12);
      expect(r.exitCode).toBe(2);
      expect(r.stdout).toContain("--max-hours must be a number from 2 to 23");
      expect(r.calls).toHaveLength(0);
      expect(fake.requests).toHaveLength(0);
    },
  );

  it("E70: a negative value exits 2", async () => {
    const r = await rent(["5001", ...IMG, "--max-hours=-5"], withBurn);
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain("--max-hours must be a number from 2 to 23");
    expect(r.calls).toHaveLength(0);
  });

  it("E70: --max-hours with no value exits 2", async () => {
    const r = await rent(["5001", ...IMG, "--max-hours"]);
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain("--max-hours requires a value");
    expect(r.calls).toHaveLength(0);
  });

  it("E103: --help documents the 2 to 23 range, the DAILY job and the retry", async () => {
    const { stdout } = await runCli(["rent", "--help"]);
    expect(stdout).toContain(
      "--max-hours <n>     destroy the instance on vast.ai's servers after at most n hours (2 to 23)",
    );
    expect(stdout).toContain("DAILY scheduled job at the destroy hour (UTC)");
    expect(stdout).toContain("once more 24 h later");
    expect(stdout).toContain("CONTRACT_SHORT");
    expect(stdout).toContain("SCHEDULE_FAILED");
    expect(stdout).not.toContain("MAX_HOURS_DISABLED");
  });
});

describe("E68: no API key", () => {
  it("refuses before any vastai call, naming the three locations", async () => {
    const fake = await serve();
    const r = await rent(["5001", ...IMG, "--max-hours", "12"], {
      ...withBurn,
      ...emptyHome(),
    });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("CONFIG_ERROR");
    expect(r.stdout).toContain("VAST_API_KEY");
    expect(r.stdout).toContain("vast_api_key");
    expect(r.stdout).toContain(".vast_api_key");
    // Nothing ran at all: no lookup, no create (nothing billed).
    expect(r.calls).toHaveLength(0);
    expect(created(r)).toHaveLength(0);
    expect(fake.requests).toHaveLength(0);
  });
});

describe("E71: --max-hours implies --hours", () => {
  it("reads the balance and applies OVER_BALANCE", async () => {
    await serve();
    // 0.5 $/hr x 12 h = 6.00 > the 'low' balance of 3.00
    const r = await rent(["5001", ...IMG, "--max-hours", "12"], {
      ...env12,
      U9_USER: "low",
    });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain("Spend guard refused");
    expect(r.tokens).toContain("show user");
    expect(created(r)).toHaveLength(0);
  });

  it("--confirm overrides OVER_BALANCE and the timer is still set", async () => {
    const fake = await serve();
    const r = await rent(["5001", ...IMG, "--max-hours", "12", "--confirm"], {
      ...env12,
      U9_USER: "low",
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("OVER_BALANCE");
    expect(fake.requests).toHaveLength(1);
  });

  it("an explicit --hours is used for the estimate instead", async () => {
    await serve();
    // 0.5 x 2 h = 1.00 <= 3.00, although --max-hours 12 alone would be refused
    const r = await rent(
      ["5001", ...IMG, "--max-hours", "12", "--hours", "2", "--json"],
      { ...env12, U9_USER: "low" },
    );
    expect(r.exitCode).toBe(0);
    expect(r.json).toMatchObject({ hours: 2, est_cost: 1, max_hours: 12 });
  });

  it("the implied hours show up in the output", async () => {
    await serve();
    // 16:40Z + 4 h = 20:40Z -> hour 20
    const r = await rent(["5001", ...IMG, "--max-hours", "4", "--json"], {
      ...withTimer(20),
      VAST_API_KEY: KEY,
    });
    expect(r.json).toMatchObject({ hours: 4, est_cost: 2, account_need: 2 });
  });
});

describe("E56: contract shorter than the destroy time", () => {
  // destroy_at is 11 h 20 min = 40800 s after the test clock.
  const withContract = (seconds: number) => ({
    ...routes(offerWithContract(seconds), withTimer(4)),
    VAST_API_KEY: KEY,
  });

  it("refuses with CONTRACT_SHORT (exit 2) before creating anything", async () => {
    const fake = await serve();
    const r = await rent(
      ["5001", ...IMG, "--max-hours", "12"],
      withContract(5 * 3600),
    );
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain("Spend guard refused");
    expect(r.stdout).toContain("5 h left");
    expect(r.stdout).toContain("2026-10-21T04:00Z");
    expect(created(r)).toHaveLength(0);
    expect(fake.requests).toHaveLength(0);
  });

  it("--confirm overrides it and reports the override", async () => {
    const fake = await serve();
    const r = await rent(
      ["5001", ...IMG, "--max-hours", "12", "--confirm"],
      withContract(5 * 3600),
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("overridden with --confirm (CONTRACT_SHORT)");
    expect(created(r)).toHaveLength(1);
    expect(fake.requests).toHaveLength(1);
  });

  it("a contract exactly as long as the run is fine; one second less is not", async () => {
    await serve();
    const exact = await rent(
      ["5001", ...IMG, "--max-hours", "12"],
      withContract(40800),
    );
    expect(exact.exitCode).toBe(0);
    const short = await rent(
      ["5001", ...IMG, "--max-hours", "12"],
      withContract(40799),
    );
    expect(short.exitCode).toBe(2);
  });

  it("an unknown contract length raises nothing", async () => {
    await serve();
    const r = await rent(["5001", ...IMG, "--max-hours", "12"], env12);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain("CONTRACT_SHORT");
  });

  it("without --max-hours the contract is not checked", async () => {
    const r = await rent(["5001", ...IMG], withContract(60));
    expect(r.exitCode).toBe(0);
  });
});

describe("E95: priced_for_disk_gb", () => {
  it("E95: --disk 30 shows priced_for_disk_gb 30 right after dph_total", async () => {
    await serve();
    const r = await rent(["5001", ...IMG, "--disk", "30", "--json"], withBurn);
    expect(r.exitCode).toBe(0);
    expect(r.json["priced_for_disk_gb"]).toBe(30);
    const keys = Object.keys(r.json);
    expect(keys.indexOf("priced_for_disk_gb")).toBe(
      keys.indexOf("dph_total") + 1,
    );
    const lookup = r.calls.find((c) => c.tokens[0] === "search");
    expect(lookup?.argv.join(" ")).toContain("--storage 30");
  });

  it("E95: the default disk shows 20 in text output", async () => {
    await serve();
    const r = await rent(["5001", ...IMG], withBurn);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("priced_for_disk_gb: 20");
  });

  it("E95: with --hours the estimate fields follow priced_for_disk_gb", async () => {
    await serve();
    const r = await rent(["5001", ...IMG, "--hours", "4", "--json"], withBurn);
    const keys = Object.keys(r.json);
    expect(keys.indexOf("priced_for_disk_gb")).toBeLessThan(
      keys.indexOf("hours"),
    );
    expect(r.json).toMatchObject({ hours: 4, est_cost: 2 });
  });
});
