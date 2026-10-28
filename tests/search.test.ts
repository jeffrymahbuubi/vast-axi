import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildQuery, normalizeGpu } from "../src/search-query.js";
import { help as searchHelp } from "../src/commands/search.js";
import { median } from "../src/format.js";
import {
  newCallLog,
  readCallLog,
  runCli,
  type Env,
} from "./helpers/run-cli.js";

type Row = Record<string, unknown>;
interface SearchJson {
  offers: Row[];
  count: number;
  cheapest_id: number;
  min_dph: number;
  median_dph: number;
  help: string[];
}

/** The offers the fake serves by default, as upstream sends them. */
const fixture = (name: string): Row[] =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
  ) as Row[];

const TEN = fixture("offers.json");
const LONG = fixture("offers50.json");

const SEVEN = [
  "id",
  "gpu_name",
  "num_gpus",
  "gpu_ram_gb",
  "dph_total",
  "reliability2",
  "geolocation",
];

/** Run `search` with --json and parse the result. */
async function searchJson(
  args: string[],
  env: Env = {},
): Promise<SearchJson & { exitCode: number }> {
  const { stdout, exitCode } = await runCli(["search", ...args, "--json"], {
    env,
  });
  return { ...(JSON.parse(stdout) as SearchJson), exitCode };
}

/** The `search offers` query the command sent upstream. */
async function sentQuery(args: string[]): Promise<string> {
  const log = newCallLog();
  await runCli(["search", ...args], { env: { FAKE_VASTAI_LOG: log } });
  const calls = readCallLog(log);
  expect(calls).toHaveLength(1);
  return calls[0]!.tokens[2]!;
}

describe("search: default output", () => {
  it("returns the ten-offer fixture as 10 rows with exactly the 7 KTD4 fields, cheapest first", async () => {
    const out = await searchJson([]);
    expect(out.exitCode).toBe(0);
    expect(out.offers).toHaveLength(10);
    for (const row of out.offers) expect(Object.keys(row)).toEqual(SEVEN);
    const prices = out.offers.map((r) => r["dph_total"] as number);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
    expect(prices[0]).toBeLessThan(prices[9]!);
  });

  it("converts gpu_ram from MB to GB and rounds prices to three decimals", async () => {
    const out = await searchJson([]);
    const byId = new Map(out.offers.map((r) => [r["id"], r]));
    expect(byId.get(25814666)?.["gpu_ram_gb"]).toBe(24); // 24564 MB
    expect(byId.get(47093659)?.["gpu_ram_gb"]).toBe(48); // 49140 MB
    expect(byId.get(25814666)?.["dph_total"]).toBe(0.401);
    expect(byId.get(25814666)?.["reliability2"]).toBe(0.996);
  });

  it("adds count, cheapest id, min and median price over every match", async () => {
    const out = await searchJson([]);
    const prices = TEN.map((o) => o["dph_total"] as number).sort(
      (a, b) => a - b,
    );
    expect(out.count).toBe(10);
    expect(out.min_dph).toBe(Math.round(prices[0]! * 1000) / 1000);
    expect(out.median_dph).toBe(Math.round(median(prices) * 1000) / 1000);
    expect(prices[0]).toBe(
      TEN.find((o) => o["id"] === out.cheapest_id)!["dph_total"],
    );
  });

  it("suggests renting the cheapest offer and re-running with --full, keeping the filters", async () => {
    const out = await searchJson(["--max-dph", "0.9", "--limit", "5"]);
    expect(out.help[0]).toBe(
      `Rent the cheapest: \`vast-axi rent ${out.cheapest_id} --image <image>\``,
    );
    expect(out.help.join("\n")).toContain(
      "vast-axi search --max-dph 0.9 --limit 5 --full",
    );
  });

  it("prints a TOON table with a header naming the 7 fields", async () => {
    const { stdout } = await runCli(["search", "--limit", "3"]);
    expect(stdout).toContain(`offers[3]{${SEVEN.join(",")}}:`);
    expect(stdout).toContain("count: 10");
    expect(stdout).toContain("help[");
  });
});

describe("search --full", () => {
  it("yields all 95 upstream fields per offer, still cheapest first", async () => {
    const out = await searchJson(["--full", "--limit", "10"]);
    expect(out.offers).toHaveLength(10);
    for (const row of out.offers) expect(Object.keys(row)).toHaveLength(95);
    expect(out.offers[0]!["gpu_ram"]).toBeTypeOf("number"); // upstream MB kept
    const prices = out.offers.map((r) => r["dph_total"] as number);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
    expect(out.help.join("\n")).not.toContain("--full");
  });
});

describe("search: query building", () => {
  it("--gpu RTX_4090 --max-dph 0.5 sends gpu_name=RTX_4090 dph_total<=0.5 rentable=true verified=true", async () => {
    const q = await sentQuery(["--gpu", "RTX_4090", "--max-dph", "0.5"]);
    expect(q).toBe(
      "gpu_name=RTX_4090 dph_total<=0.5 rentable=true verified=true",
    );
  });

  it("orders gpu, num-gpus, min-vram, max-dph, then the defaults", () => {
    expect(
      buildQuery({ gpu: "H100", numGpus: 2, minVram: 40, maxDph: 3 }),
    ).toBe(
      "gpu_name=H100 num_gpus=2 gpu_ram>=40 dph_total<=3 rentable=true verified=true",
    );
  });

  it("sends only the safe defaults when no flag is given", async () => {
    expect(await sentQuery([])).toBe("rentable=true verified=true");
  });

  it("asks upstream to order by dph_total and keeps the query as one argument", async () => {
    const log = newCallLog();
    await runCli(["search", "--gpu", "RTX 4090"], {
      env: { FAKE_VASTAI_LOG: log },
    });
    const argv = readCallLog(log)[0]!.argv;
    expect(argv.slice(3)).toEqual([
      "search",
      "offers",
      "gpu_name=RTX_4090 rentable=true verified=true",
      "-o",
      "dph_total",
    ]);
  });

  it("appends --query verbatim and lets it replace a default it sets itself", async () => {
    expect(await sentQuery(["--query", "cuda_max_good>=12.4"])).toBe(
      "rentable=true verified=true cuda_max_good>=12.4",
    );
    expect(await sentQuery(["--query", "verified=false dph_total<0.3"])).toBe(
      "rentable=true verified=false dph_total<0.3",
    );
  });

  it("normalises GPU names and rejects ones that would corrupt the query", () => {
    expect(normalizeGpu("RTX 4090")).toBe("RTX_4090");
    expect(normalizeGpu("A100_SXM4")).toBe("A100_SXM4");
    expect(() => normalizeGpu("RTX_4090 dph_total<0")).toThrow(
      /GPU model name/,
    );
  });
});

describe("search: flag validation", () => {
  it("E20: rejects the unknown flag --vram with exit 2 and the valid flags, without calling vastai", async () => {
    const log = newCallLog();
    const { stdout, exitCode } = await runCli(["search", "--vram", "24"], {
      env: { FAKE_VASTAI_LOG: log },
    });
    expect(exitCode).toBe(2);
    expect(stdout).toContain("VALIDATION_ERROR");
    expect(stdout).toContain("unknown flag --vram");
    for (const flag of [
      "--gpu",
      "--min-vram",
      "--max-dph",
      "--num-gpus",
      "--limit",
      "--query",
      "--full",
    ]) {
      expect(stdout).toContain(flag);
    }
    expect(readCallLog(log)).toHaveLength(0);
  });

  it("E20: a stray positional is rejected with a --gpu hint", async () => {
    const { stdout, exitCode } = await runCli(["search", "RTX_4090"]);
    expect(exitCode).toBe(2);
    expect(stdout).toContain("unexpected argument RTX_4090");
    expect(stdout).toContain("--gpu");
  });

  it("E20: bad numbers are VALIDATION_ERROR, exit 2", async () => {
    for (const args of [
      ["--limit", "0"],
      ["--limit", "2.5"],
      ["--max-dph", "cheap"],
      ["--num-gpus", "0"],
      ["--min-vram", "-1"],
    ]) {
      const { stdout, exitCode } = await runCli(["search", ...args]);
      expect(exitCode, args.join(" ")).toBe(2);
      expect(stdout).toContain("VALIDATION_ERROR");
    }
  });

  it("a flag without a value is VALIDATION_ERROR, exit 2", async () => {
    const { stdout, exitCode } = await runCli(["search", "--gpu"]);
    expect(exitCode).toBe(2);
    expect(stdout).toContain("--gpu requires a value");
  });

  it("serves its own --help with every flag", async () => {
    const { stdout, exitCode } = await runCli(["search", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toBe(searchHelp);
    for (const flag of ["--gpu", "--min-vram", "--max-dph", "--num-gpus"]) {
      expect(stdout).toContain(flag);
    }
    expect(stdout).toContain("--limit");
    expect(stdout).toContain("--query");
    expect(stdout).toContain("--full");
  });
});

describe("search: edge cases", () => {
  it("E4: an empty result is an explicit zero state with relax hints, exit 0", async () => {
    const { stdout, exitCode } = await runCli([
      "search",
      "--gpu",
      "NO_SUCH_GPU",
      "--max-dph",
      "0.2",
      "--min-vram",
      "80",
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("offers: 0 matching offers");
    expect(stdout).toContain("query:");
    expect(stdout).toContain("Raise --max-dph (now 0.2)");
    expect(stdout).toContain("Lower --min-vram (now 80)");
    expect(stdout).toContain("another --gpu");
    expect(stdout).toContain("--query verified=false");
    expect(stdout).not.toContain("offers[");
  });

  it("E4: the zero state in JSON has no rows and still carries help", async () => {
    const { stdout } = await runCli([
      "search",
      "--gpu",
      "NO_SUCH_GPU",
      "--json",
    ]);
    const out = JSON.parse(stdout) as { offers: string; help: string[] };
    expect(out.offers).toBe("0 matching offers");
    expect(out.help.length).toBeGreaterThan(0);
  });

  it("E4: no hint offers verified=false when the query already decides it", async () => {
    const { stdout } = await runCli([
      "search",
      "--gpu",
      "NO_SUCH_GPU",
      "--query",
      "verified=false",
    ]);
    expect(stdout).toContain("Loosen or drop --query");
    expect(stdout).not.toContain("Include unverified hosts");
  });

  it("E27: unicode geolocations survive in TOON and JSON", async () => {
    const toon = await runCli(["search", "--gpu", "UNICODE_GPU"]);
    for (const place of ["Zürich", "東京", "São Paulo"]) {
      expect(toon.stdout).toContain(place);
    }
    expect(toon.stdout).not.toContain("�");
    const json = await searchJson(["--gpu", "UNICODE_GPU"]);
    expect(json.offers.map((r) => r["geolocation"])).toEqual([
      "Zürich, CH", // 0.38
      "東京, JP", // 0.51
      "São Paulo, BR", // 0.62
    ]);
    expect(json.cheapest_id).toBe(910001);
  });

  it("E30: --limit 3 on the 41-offer fixture prints 3 rows and a help line with the real total", async () => {
    expect(LONG).toHaveLength(41);
    const { stdout } = await runCli([
      "search",
      "--gpu",
      "LONG_LIST",
      "--limit",
      "3",
    ]);
    expect(stdout).toContain(`offers[3]{${SEVEN.join(",")}}:`);
    expect(stdout).toContain("count: 41");
    expect(stdout).toContain("Showing 3 of 41 matching offers");
  });

  it("E30: aggregates cover all 41 matches, not just the rows shown", async () => {
    const out = await searchJson(["--gpu", "LONG_LIST", "--limit", "3"]);
    const prices = LONG.map((o) => o["dph_total"] as number).sort(
      (a, b) => a - b,
    );
    expect(out.offers).toHaveLength(3);
    expect(out.count).toBe(41);
    expect(out.median_dph).toBe(Math.round(median(prices) * 1000) / 1000);
    const shown = out.offers.map((r) => r["dph_total"] as number);
    expect(shown).toEqual([...shown].sort((a, b) => a - b));
    expect(shown[0]).toBe(Math.round(prices[0]! * 1000) / 1000);
  });

  it("E30: no total-count line when every match is shown", async () => {
    const { stdout } = await runCli(["search", "--limit", "10"]);
    expect(stdout).not.toContain("Showing");
  });

  it("the default limit is 10 rows", async () => {
    const out = await searchJson(["--gpu", "LONG_LIST"]);
    expect(out.offers).toHaveLength(10);
    expect(out.count).toBe(41);
  });

  it("upstream auth errors surface as AUTH_REQUIRED, exit 1", async () => {
    const { stdout, exitCode } = await runCli(["search"], {
      env: { FAKE_VASTAI_SCENARIO: "auth401" },
    });
    expect(exitCode).toBe(1);
    expect(stdout).toContain("AUTH_REQUIRED");
  });

  it("a non-array upstream body is UPSTREAM_PARSE_ERROR with a raw hint, exit 1", async () => {
    const { stdout, exitCode } = await runCli(["search"], {
      env: {
        FAKE_VASTAI_ROUTES: JSON.stringify({
          "search offers": { stdout: '{"offers": 3}' },
        }),
      },
    });
    expect(exitCode).toBe(1);
    expect(stdout).toContain("UPSTREAM_PARSE_ERROR");
    expect(stdout).toContain("vast-axi raw");
  });
});
