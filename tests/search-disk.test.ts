import { describe, expect, it } from "vitest";
import {
  newCallLog,
  readCallLog,
  runCli,
  type Env,
} from "./helpers/run-cli.js";

type Row = Record<string, unknown>;

interface Json {
  offers: Row[] | string;
  priced_for_disk_gb?: number;
  count?: number;
  min_dph?: number;
  median_dph?: number;
  help?: string[];
}

/** Errors print as text, not JSON. */
function parseJson(text: string): Json {
  try {
    return JSON.parse(text) as Json;
  } catch {
    return { offers: [] };
  }
}

async function search(args: string[], env: Env = {}) {
  const log = newCallLog();
  const { stdout, exitCode } = await runCli(["search", ...args, "--json"], {
    env: { FAKE_VASTAI_LOG: log, ...env },
  });
  const calls = readCallLog(log).filter((c) => c.tokens[0] === "search");
  return { stdout, exitCode, calls, json: parseJson(stdout) };
}

/** Four offers already priced for 30 GB: 0.45, 0.62, 0.71, 0.90. */
const REPRICED: Env = {
  FAKE_VASTAI_ROUTES: JSON.stringify({
    "search offers": { fixture: "fr5-repriced.json" },
  }),
};

describe("search --disk (#4)", () => {
  it("E147: the call carries --storage 20 by default and priced_for_disk_gb 20", async () => {
    const r = await search([]);
    const argv = r.calls[0]!.argv;
    expect(argv.slice(argv.indexOf("--storage"))).toEqual(["--storage", "20"]);
    expect(r.json.priced_for_disk_gb).toBe(20);
  });

  it("E147: --disk 30 sends --storage 30 and reports it", async () => {
    const r = await search(["--disk", "30"]);
    const argv = r.calls[0]!.argv;
    expect(argv[argv.indexOf("--storage") + 1]).toBe("30");
    expect(r.json.priced_for_disk_gb).toBe(30);
  });

  it("E147: the rent hint carries --disk only when the flag was given", async () => {
    const plain = await search([]);
    expect(plain.json.help?.[0]).not.toContain("--disk");
    const withDisk = await search(["--disk", "30"]);
    expect(withDisk.json.help?.[0]).toMatch(/--image <image> --disk 30`/);
  });

  it("E148: rows above --max-dph after repricing are dropped and the aggregates follow", async () => {
    const r = await search(["--disk", "30", "--max-dph", "0.7"], REPRICED);
    const rows = r.json.offers as Row[];
    expect(rows.map((o) => o["dph_total"])).toEqual([0.45, 0.62]);
    expect(r.json.count).toBe(2);
    expect(r.json.min_dph).toBe(0.45);
    expect(r.json.median_dph).toBe(0.535);
  });

  it("E148: without --max-dph nothing is dropped", async () => {
    const r = await search(["--disk", "30"], REPRICED);
    expect(r.json.count).toBe(4);
  });

  it("E148: when every row is dropped the empty state explains it", async () => {
    const r = await search(["--disk", "30", "--max-dph", "0.1"], REPRICED);
    expect(r.exitCode).toBe(0);
    expect(r.json.offers).toBe("0 matching offers");
    expect(r.json.help?.[0]).toMatch(
      /every match is above --max-dph once priced for 30 GB/i,
    );
    expect(r.json.priced_for_disk_gb).toBe(30);
  });

  it("E179: --query dph_total<X drops repriced rows above the cap; aggregates follow", async () => {
    const r = await search(
      ["--disk", "30", "--query", "dph_total<0.7"],
      REPRICED,
    );
    const rows = r.json.offers as Row[];
    expect(rows.map((o) => o["dph_total"])).toEqual([0.45, 0.62]);
    expect(r.json.count).toBe(2);
    expect(r.json.min_dph).toBe(0.45);
    expect(r.json.median_dph).toBe(0.535);
  });

  it("E179: < is strict and <= is not (a row priced exactly at the cap)", async () => {
    const strict = await search(["--query", "dph_total<0.71"], REPRICED);
    expect(strict.json.count).toBe(2);
    const loose = await search(["--query", "dph<=0.71"], REPRICED);
    expect(loose.json.count).toBe(3);
  });

  it("E180: the tighter of --max-dph and the query cap applies", async () => {
    const q = await search(
      ["--query", "dph<=0.7", "--max-dph", "0.8"],
      REPRICED,
    );
    expect(q.json.count).toBe(2);
    const m = await search(
      ["--query", "dph_total<=0.8", "--max-dph", "0.65"],
      REPRICED,
    );
    expect(m.json.count).toBe(2);
  });

  it("E180: a lower bound in --query is not re-checked", async () => {
    const r = await search(["--query", "dph_total>0.2"], REPRICED);
    expect(r.json.count).toBe(4);
  });

  it("E181: every row above the query cap gives an empty state naming the --query cap", async () => {
    const r = await search(["--query", "dph_total<0.1"], REPRICED);
    expect(r.exitCode).toBe(0);
    expect(r.json.offers).toBe("0 matching offers");
    expect(r.json.help?.[0]).toMatch(/--query price cap \(dph_total<0\.1\)/);
    expect(r.json.help?.[0]).not.toContain("--max-dph");
  });

  it.each(["0", "abc"])(
    "E149: --disk %s exits 2 before any call and names the flag",
    async (value) => {
      const r = await search(["--disk", value]);
      expect(r.exitCode).toBe(2);
      expect(r.stdout).toContain("--disk");
      expect(r.calls).toHaveLength(0);
    },
  );
});
