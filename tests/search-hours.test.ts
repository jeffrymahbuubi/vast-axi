import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { help as searchHelp } from "../src/commands/search.js";
import {
  newCallLog,
  readCallLog,
  runCli,
  type Env,
} from "./helpers/run-cli.js";

type Row = Record<string, unknown>;

interface HoursJson {
  offers: Row[];
  count: number;
  hours?: number;
  balance?: number | null;
  help: string[];
}

const TEN = JSON.parse(
  readFileSync(new URL("./fixtures/offers.json", import.meta.url), "utf8"),
) as Row[];

const SEVEN = [
  "id",
  "gpu_name",
  "num_gpus",
  "gpu_ram_gb",
  "dph_total",
  "reliability2",
  "geolocation",
];

/** The default row with --hours: max_h sits right after dph_total, then the estimate fields. */
const WITH_HOURS = [
  "id",
  "gpu_name",
  "num_gpus",
  "gpu_ram_gb",
  "dph_total",
  "max_h",
  "reliability2",
  "geolocation",
  "est_cost",
  "pct_balance",
];

/** Rows come back cheapest first. */
const dph0 = Math.min(...TEN.map((o) => o["dph_total"] as number));
const BALANCE = 12.3456; // tests/fixtures/user.json

async function run(args: string[], env: Env = {}) {
  const log = newCallLog();
  const { stdout, exitCode } = await runCli(["search", ...args, "--json"], {
    env: { FAKE_VASTAI_LOG: log, ...env },
  });
  return {
    out: JSON.parse(stdout) as HoursJson,
    exitCode,
    calls: readCallLog(log),
  };
}

describe("search --hours", () => {
  it("adds est_cost and pct_balance to every row, plus hours and balance at the top", async () => {
    const { out, exitCode } = await run(["--hours", "4"]);
    expect(exitCode).toBe(0);
    expect(out.hours).toBe(4);
    expect(out.balance).toBe(12.35);
    for (const row of out.offers) {
      expect(Object.keys(row)).toEqual(WITH_HOURS);
    }
    const first = out.offers[0]!;
    expect(first["est_cost"]).toBe(Math.round(dph0 * 4 * 100) / 100);
    expect(first["pct_balance"]).toBe(
      Math.round(((dph0 * 4) / BALANCE) * 1000) / 10,
    );
  });

  it("makes exactly one extra show user call, and none without --hours", async () => {
    const withHours = await run(["--hours", "2"]);
    expect(
      withHours.calls.filter((c) => c.tokens.join(" ") === "show user"),
    ).toHaveLength(1);
    expect(withHours.calls).toHaveLength(2);
    const without = await run([]);
    expect(without.calls).toHaveLength(1);
    expect(without.out).not.toHaveProperty("hours");
    expect(without.out).not.toHaveProperty("balance");
    expect(without.out.offers[0]).not.toHaveProperty("est_cost");
  });

  it("accepts fractional hours and hints the rent command with --hours", async () => {
    const { out } = await run(["--hours", "1.5"]);
    expect(out.hours).toBe(1.5);
    expect(out.offers[0]!["est_cost"]).toBe(Math.round(dph0 * 1.5 * 100) / 100);
    expect(out.help[0]).toContain("--image <image> --hours 1.5");
  });

  it("E63: --full rows carry est_cost and pct_balance too", async () => {
    const { out } = await run(["--hours", "4", "--full", "--limit", "3"]);
    expect(out.offers).toHaveLength(3);
    for (const row of out.offers) {
      expect(Object.keys(row)).toHaveLength(98); // 97 upstream + max_h
      expect(row["max_h"]).toBeTypeOf("number");
      expect(row["est_cost"]).toBeTypeOf("number");
      expect(row["pct_balance"]).toBeTypeOf("number");
      expect(row["gpu_ram"]).toBeTypeOf("number"); // still upstream MB
    }
  });

  it("prints est_cost and pct_balance in the TOON table header", async () => {
    const { stdout } = await runCli(["search", "--limit", "2", "--hours", "4"]);
    expect(stdout).toContain(`offers[2]{${WITH_HOURS.join(",")}}:`);
    expect(stdout).toContain("hours: 4");
    expect(stdout).toContain("balance: 12.35");
  });

  it.each([
    ["a user record without a balance", { U9_USER: "nobalance" }],
    ["a zero balance", { U9_USER: "zero" }],
    [
      "a failing show user",
      {
        FAKE_VASTAI_ROUTES: JSON.stringify({
          "show user": { stderr: "Traceback: boom\n", exit: 1 },
        }),
      },
    ],
    [
      "garbage show user output",
      { FAKE_VASTAI_ROUTES: JSON.stringify({ "show user": { stdout: "{" } }) },
    ],
  ])(
    "%s: rows keep est_cost, pct_balance is null, a hint says the balance could not be read, exit 0",
    async (_name, env) => {
      const { out, exitCode } = await run(["--hours", "4"], env);
      expect(exitCode).toBe(0);
      expect(out.offers).toHaveLength(10);
      for (const row of out.offers) {
        expect(row["est_cost"]).toBeTypeOf("number");
        expect(row["pct_balance"]).toBeNull();
      }
      expect(out.help.join("\n")).toContain("balance could not be read");
    },
  );

  it("never refuses on cost: a huge estimate over a small balance still lists offers", async () => {
    const { out, exitCode } = await run(["--hours", "720"], {
      U9_USER: "low",
    });
    expect(exitCode).toBe(0);
    expect(out.balance).toBe(3);
    expect(out.offers[0]!["pct_balance"]).toBeGreaterThan(100);
  });

  it("E55: bad --hours exits 2 and runs nothing", async () => {
    for (const bad of ["0", "-2", "abc", "721", "NaN"]) {
      const log = newCallLog();
      const { stdout, exitCode } = await runCli(["search", "--hours", bad], {
        env: { FAKE_VASTAI_LOG: log },
      });
      expect(exitCode).toBe(2);
      expect(stdout).toContain("VALIDATION_ERROR");
      expect(readCallLog(log)).toHaveLength(0);
    }
    const missing = await runCli(["search", "--hours"]);
    expect(missing.exitCode).toBe(2);
  });

  it("zero matches with --hours still reports no offers and exits 0", async () => {
    const { stdout, exitCode } = await runCli(["search", "--hours", "4"], {
      env: {
        FAKE_VASTAI_ROUTES: JSON.stringify({
          "search offers": { stdout: "[]" },
        }),
      },
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("0 matching offers");
  });

  it("documents --hours in --help", () => {
    expect(searchHelp).toContain("--hours");
    expect(searchHelp).toContain("pct_balance");
    expect(searchHelp).toContain(
      "with --hours N, offers whose rental contract ends within N hours are hidden (vast.ai stops an instance at contract end); max_h = hours of contract left",
    );
  });
});

/** The positional query the fake received for `search offers`. */
function queryOf(calls: Array<{ tokens: string[] }>): string {
  const call = calls.find(
    (c) => c.tokens[0] === "search" && c.tokens[1] === "offers",
  );
  return call!.tokens[2]!;
}

/** Offers with the given `duration` seconds values (undefined = field missing). */
function durationsRoute(durations: Array<number | undefined>) {
  const offers = durations.map((d, i) => ({
    id: 100 + i,
    gpu_name: "RTX 4090",
    num_gpus: 1,
    gpu_ram: 24564,
    dph_total: 0.4 + i / 100,
    reliability2: 0.99,
    geolocation: "Ireland, IE",
    ...(d === undefined ? {} : { duration: d }),
  }));
  return {
    FAKE_VASTAI_ROUTES: JSON.stringify({
      "search offers": { stdout: JSON.stringify(offers) },
    }),
  };
}

describe("search --hours: contract-length filter and max_h", () => {
  it.each([
    ["12", "duration>=0.5"],
    ["1", "duration>=0.041667"],
    ["24", "duration>=1"],
    ["7.2", "duration>=0.3"],
    ["720", "duration>=30"],
    ["0.5", "duration>=0.020834"],
  ])(
    "E64: search --hours %s adds %s (days, rounded up) before the defaults",
    async (hours, term) => {
      const { calls, exitCode } = await run(["--hours", hours]);
      expect(exitCode).toBe(0);
      expect(queryOf(calls)).toBe(`${term} rentable=true verified=true`);
    },
  );

  it("E64: --hours combines with the other filters and a --query that does not set duration", async () => {
    const { calls } = await run([
      "--gpu",
      "RTX_4090",
      "--max-dph",
      "0.5",
      "--hours",
      "12",
      "--query",
      "cuda_max_good>=12.4",
    ]);
    expect(queryOf(calls)).toBe(
      "gpu_name=RTX_4090 dph_total<=0.5 duration>=0.5 rentable=true verified=true cuda_max_good>=12.4",
    );
  });

  it("E65: a user --query with duration wins; no second duration term, and a hint says so", async () => {
    for (const q of ["duration>=2", "duration<=1 verified=false"]) {
      const { calls, out } = await run(["--hours", "12", "--query", q]);
      const sent = queryOf(calls);
      expect(sent.match(/duration/g)).toHaveLength(1);
      expect(sent.endsWith(q)).toBe(true);
      expect(sent).not.toContain("duration>=0.5");
      expect(out.help.join("\n")).toContain("Your --query sets duration");
      expect(out.offers[0]).toHaveProperty("max_h"); // the column stays
    }
  });

  it("E66: max_h is duration seconds / 3600 to 1 decimal, null when duration is missing, after dph_total", async () => {
    const { out } = await run(
      ["--hours", "1"],
      durationsRoute([10656, 7023.9, undefined, 5400]),
    );
    const byId = new Map(out.offers.map((r) => [r["id"], r]));
    expect(byId.get(100)!["max_h"]).toBe(3);
    expect(byId.get(101)!["max_h"]).toBe(2);
    expect(byId.get(102)!["max_h"]).toBeNull();
    expect(byId.get(103)!["max_h"]).toBe(1.5);
    for (const row of out.offers) {
      expect(Object.keys(row)).toEqual(WITH_HOURS);
    }
  });

  it("E66: max_h matches the fixture durations on the real ten-offer fixture", async () => {
    const { out } = await run(["--hours", "1"]);
    for (const row of out.offers) {
      const src = TEN.find((o) => o["id"] === row["id"])!;
      expect(row["max_h"]).toBe(
        Math.round(((src["duration"] as number) / 3600) * 10) / 10,
      );
    }
  });

  it("prints max_h in the TOON header and mentions the hidden offers in a hint", async () => {
    const { stdout } = await runCli(["search", "--limit", "2", "--hours", "4"]);
    expect(stdout).toContain("dph_total,max_h,reliability2");
    expect(stdout).toContain("contract ends within 4 h are hidden");
  });

  it("an empty result with --hours echoes the added filter and says contract-short offers are hidden", async () => {
    const { stdout } = await runCli(["search", "--hours", "12", "--json"], {
      env: {
        FAKE_VASTAI_ROUTES: JSON.stringify({
          "search offers": { stdout: "[]" },
        }),
      },
    });
    const out = JSON.parse(stdout) as { query: string; help: string[] };
    expect(out.query).toBe("duration>=0.5 rentable=true verified=true");
    expect(out.help.join("\n")).toContain("contract ends within 12 h");
  });

  it("without --hours: no duration filter, no max_h column", async () => {
    const { out, calls } = await run([]);
    expect(queryOf(calls)).toBe("rentable=true verified=true");
    for (const row of out.offers) {
      expect(Object.keys(row)).toEqual(SEVEN);
      expect(row).not.toHaveProperty("max_h");
    }
    const full = await run(["--full", "--limit", "2"]);
    expect(full.out.offers[0]).not.toHaveProperty("max_h");
    expect(queryOf(full.calls)).not.toContain("duration");
  });
});
