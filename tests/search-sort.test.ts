import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { help as searchHelp } from "../src/commands/search.js";
import {
  GPU_PRECISION,
  GPU_PRECISION_DATE,
  PRECISIONS,
  peakTflops,
} from "../src/gpu-precision.js";
import {
  newCallLog,
  readCallLog,
  runCli,
  type Env,
} from "./helpers/run-cli.js";

type Row = Record<string, unknown>;

interface SortJson {
  offers: Row[];
  count: number;
  cheapest_id: number;
  min_dph: number;
  median_dph: number;
  sort?: string;
  value_basis?: string;
  hours?: number;
  help: string[];
}

const SEVEN = [
  "id",
  "gpu_name",
  "num_gpus",
  "gpu_ram_gb",
  "dph_total",
  "reliability2",
  "geolocation",
];

const OFFERS = JSON.parse(
  readFileSync(new URL("./fixtures/u14-offers.json", import.meta.url), "utf8"),
) as Row[];

/** Serve the u14 fixture for `search offers`. */
const U14: Env = {
  FAKE_VASTAI_ROUTES: JSON.stringify({
    "search offers": { fixture: "u14-offers.json" },
  }),
};

async function run(args: string[], env: Env = {}) {
  const log = newCallLog();
  const { stdout, exitCode } = await runCli(["search", ...args, "--json"], {
    env: { ...U14, FAKE_VASTAI_LOG: log, ...env },
  });
  return { stdout, exitCode, calls: readCallLog(log) };
}

async function runOk(args: string[], env: Env = {}) {
  const r = await run(args, env);
  expect(r.exitCode).toBe(0);
  return {
    out: JSON.parse(r.stdout) as SortJson,
    calls: r.calls,
    order: (JSON.parse(r.stdout) as SortJson).offers.map((o) => o["id"]),
  };
}

/** The value after `-o` in the first `search offers` call. */
function orderArg(calls: Awaited<ReturnType<typeof run>>["calls"]): string {
  const argv = calls[0]!.argv;
  return argv[argv.indexOf("-o") + 1]!;
}

describe("search --sort: price is the unchanged default", () => {
  it("sends -o dph_total and adds no sort fields", async () => {
    const { out, calls, order } = await runOk([]);
    expect(orderArg(calls)).toBe("dph_total");
    expect(order).toEqual([9007, 9005, 9003, 9001, 9006, 9002, 9004]);
    for (const row of out.offers) expect(Object.keys(row)).toEqual(SEVEN);
    expect(out).not.toHaveProperty("sort");
    expect(out).not.toHaveProperty("value_basis");
    expect(out.help[0]).toContain("Rent the cheapest: `vast-axi rent 9007 ");
  });

  it("--sort price is the same as no flag", async () => {
    const plain = await runOk([]);
    const explicit = await runOk(["--sort", "price"]);
    // Only the echoed command in the last hint differs.
    expect({ ...explicit.out, help: explicit.out.help.slice(0, -1) }).toEqual({
      ...plain.out,
      help: plain.out.help.slice(0, -1),
    });
    expect(orderArg(explicit.calls)).toBe("dph_total");
  });
});

describe("search --sort value", () => {
  it("asks vastai for -o dlperf_per_dphtotal- and ranks by value, best first", async () => {
    const { out, calls, order } = await runOk(["--sort", "value"]);
    expect(orderArg(calls)).toBe("dlperf_per_dphtotal-");
    expect(order).toEqual([9003, 9007, 9001, 9002, 9004, 9005, 9006]);
    expect(Object.keys(out.offers[0]!)).toEqual([...SEVEN, "dlperf", "value"]);
    expect(out.offers[0]!["dlperf"]).toBe(60);
    expect(out.offers[0]!["value"]).toBe(300);
    expect(out.sort).toBe("value");
    expect(out.value_basis).toContain("dlperf");
  });

  it("E82: an offer missing dlperf sorts last with null dlperf and value", async () => {
    const { out } = await runOk(["--sort", "value"]);
    const last = out.offers[out.offers.length - 1]!;
    expect(last["id"]).toBe(9006);
    expect(last["dlperf"]).toBeNull();
    expect(last["value"]).toBeNull();
  });

  it("keeps the aggregates price-based and hints the best value offer", async () => {
    const { out } = await runOk(["--sort", "value"]);
    expect(out.count).toBe(7);
    expect(out.cheapest_id).toBe(9007);
    expect(out.min_dph).toBe(0.08);
    expect(out.median_dph).toBe(0.4);
    expect(out.help[0]).toContain("Rent the best value: `vast-axi rent 9003 ");
  });

  it("--limit ranks over every match before cutting", async () => {
    const { order } = await runOk(["--sort", "value", "--limit", "2"]);
    expect(order).toEqual([9003, 9007]);
  });

  it("--full rows carry the new fields too", async () => {
    const { out } = await runOk(["--sort", "value", "--full", "--limit", "1"]);
    const row = out.offers[0]!;
    expect(row["dlperf_per_dphtotal"]).toBe(300);
    expect(row["dlperf"]).toBe(60);
    expect(row["value"]).toBe(300);
  });
});

describe("search --sort flops", () => {
  it("asks for -o flops_per_dphtotal- and adds tflops and tflops_per_usd", async () => {
    const { out, calls, order } = await runOk(["--sort", "flops"]);
    expect(orderArg(calls)).toBe("flops_per_dphtotal-");
    expect(order).toEqual([9001, 9002, 9003, 9007, 9005, 9004, 9006]);
    expect(Object.keys(out.offers[0]!)).toEqual([
      ...SEVEN,
      "tflops",
      "tflops_per_usd",
    ]);
    expect(out.offers[0]!["tflops"]).toBe(81.4);
    expect(out.offers[0]!["tflops_per_usd"]).toBe(202.8);
    const last = out.offers[6]!;
    expect(last["tflops"]).toBeNull();
    expect(last["tflops_per_usd"]).toBeNull();
    expect(out.sort).toBe("flops");
    expect(out.help[0]).toContain("Rent the best value:");
  });
});

describe("search --precision", () => {
  it("implies --sort value and ranks table x num_gpus per dollar", async () => {
    const { out, calls, order } = await runOk(["--precision", "fp16"]);
    expect(orderArg(calls)).toBe("dph_total");
    // H100 989.5/2, RTX 5090 209.5/0.5, 4090 165.2/0.4, 2x4090 330.4/0.9, 3090 71/0.2
    expect(order).toEqual([9004, 9006, 9001, 9002, 9003, 9007, 9005]);
    expect(Object.keys(out.offers[0]!)).toEqual([
      ...SEVEN,
      "tflops_fp16",
      "value",
    ]);
    const byId = new Map(out.offers.map((r) => [r["id"], r]));
    expect(byId.get(9004)).toMatchObject({ tflops_fp16: 989.5, value: 494.8 });
    expect(byId.get(9002)).toMatchObject({ tflops_fp16: 330.4, value: 367.1 });
    expect(byId.get(9001)).toMatchObject({ tflops_fp16: 165.2, value: 413 });
    expect(out.sort).toBe("value");
  });

  it("says the numbers come from a static datasheet table", async () => {
    const { out } = await runOk(["--precision", "tf32"]);
    expect(out.value_basis).toBe(
      `tf32 dense peak TFLOPS from vendor datasheets (static table, ${GPU_PRECISION_DATE}) per $/hr`,
    );
    expect(GPU_PRECISION_DATE).toBe("2026-10-20");
  });

  it("E83: a GPU not in the table, or without that precision, gets value null, sorts last and is named in a hint", async () => {
    const { out } = await runOk(["--precision", "fp16"]);
    const tail = out.offers.slice(-2);
    // Both null rows keep price order: GTX 1080 Ti (no tensor cores) then the unknown GPU.
    expect(tail.map((r) => r["id"])).toEqual([9007, 9005]);
    for (const row of tail) {
      expect(row["value"]).toBeNull();
      expect(row["tflops_fp16"]).toBeNull();
    }
    const hint = out.help.find((h) => h.includes("no datasheet fp16"));
    expect(hint).toContain("Mystery GPU 9000");
    expect(hint).toContain("GTX 1080 Ti");
    expect(hint).toContain("have no datasheet fp16 number in vast-axi's table");
  });

  it("E83: fp32 ranks the card that has no tensor cores", async () => {
    const { out } = await runOk(["--precision", "fp32"]);
    const row = out.offers.find((r) => r["id"] === 9007)!;
    expect(row["tflops_fp32"]).toBe(11.3);
    expect(row["value"]).toBe(141.3); // 11.3 / 0.08
    const hint = out.help.find((h) => h.includes("no datasheet fp32"));
    expect(hint).toContain("Mystery GPU 9000");
    expect(hint).not.toContain("GTX 1080 Ti");
  });

  it("names at most five GPUs in the hint", async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      ...OFFERS[0]!,
      id: 7000 + i,
      gpu_name: `Unknown ${i}`,
    }));
    const env: Env = {
      FAKE_VASTAI_ROUTES: JSON.stringify({
        "search offers": { stdout: JSON.stringify(many) },
      }),
    };
    const { out } = await runOk(["--precision", "fp16"], env);
    const hint = out.help.find((h) => h.includes("no datasheet fp16"))!;
    expect(hint.match(/Unknown \d/g)).toHaveLength(5);
    expect(hint).toContain("and 3 more");
  });

  it("E85: refuses --precision with --sort price or --sort flops (exit 2, nothing run)", async () => {
    for (const sort of ["price", "flops"]) {
      const r = await run(["--precision", "fp16", "--sort", sort]);
      expect(r.exitCode).toBe(2);
      expect(r.stdout).toContain("VALIDATION_ERROR");
      expect(r.stdout).toContain("--precision");
      expect(r.calls).toHaveLength(0);
    }
  });

  it("accepts --precision with an explicit --sort value", async () => {
    const { out } = await runOk(["--sort", "value", "--precision", "fp16"]);
    expect(out.offers[0]!["id"]).toBe(9004);
  });

  it("rejects an unknown precision or sort with exit 2 listing the allowed values", async () => {
    const badPrecision = await run(["--precision", "bf16"]);
    expect(badPrecision.exitCode).toBe(2);
    expect(badPrecision.stdout).toContain("VALIDATION_ERROR");
    expect(badPrecision.stdout).toContain("fp32, tf32, fp16");
    expect(badPrecision.calls).toHaveLength(0);
    const badSort = await run(["--sort", "cheap"]);
    expect(badSort.exitCode).toBe(2);
    expect(badSort.stdout).toContain("price, value, flops");
    expect(badSort.calls).toHaveLength(0);
  });

  it("E86: --precision with --hours and --limit ranks over all offers, then cuts", async () => {
    const { out, calls, order } = await runOk([
      "--precision",
      "fp16",
      "--hours",
      "4",
      "--limit",
      "2",
    ]);
    // The cheapest offers (9007, 9005) are not in the top two by value.
    expect(order).toEqual([9004, 9006]);
    expect(out.count).toBe(7);
    expect(out.cheapest_id).toBe(9007);
    expect(out.hours).toBe(4);
    expect(Object.keys(out.offers[0]!)).toEqual([
      "id",
      "gpu_name",
      "num_gpus",
      "gpu_ram_gb",
      "dph_total",
      "max_h",
      "reliability2",
      "geolocation",
      "tflops_fp16",
      "value",
      "est_cost",
      "pct_balance",
    ]);
    expect(out.offers[0]!["est_cost"]).toBe(8); // 2.0 $/hr x 4 h
    expect(out.offers[0]!["max_h"]).toBeTypeOf("number");
    expect(out.help.some((h) => h.includes("Showing 2 of 7"))).toBe(true);
    expect(out.help[0]).toContain("Rent the best value: `vast-axi rent 9004 ");
    expect(out.help[0]).toContain("--hours 4");
    const search = calls.find((c) => c.tokens[0] === "search")!;
    expect(search.argv.join(" ")).toContain("duration>=");
    expect(orderArg(calls)).toBe("dph_total");
  });

  it("works with --max-dph and --full", async () => {
    const { out, calls } = await runOk([
      "--precision",
      "fp16",
      "--max-dph",
      "1",
      "--full",
      "--limit",
      "1",
    ]);
    expect(calls[0]!.argv.some((a) => a.includes("dph_total<=1"))).toBe(true);
    const row = out.offers[0]!;
    expect(row["tflops_fp16"]).toBeTypeOf("number");
    expect(row["value"]).toBeTypeOf("number");
    expect(row["gpu_ram"]).toBeTypeOf("number"); // still upstream MB
  });
});

describe("search --sort: help", () => {
  it("documents the new flags and the notes", () => {
    expect(searchHelp).toContain("--sort <s>");
    expect(searchHelp).toContain("--precision <p>");
    expect(searchHelp).toContain("fp32 | tf32 | fp16");
    expect(searchHelp).toContain("not measurements");
    expect(searchHelp).toContain("--sort value");
  });
});

describe("gpu-precision table", () => {
  const entries = Object.entries(GPU_PRECISION);

  it("has a vendor https source for every entry", () => {
    expect(entries.length).toBeGreaterThan(50);
    for (const [name, peak] of entries) {
      expect(peak.source, name).toMatch(/^https:\/\//);
    }
  });

  it("has a number for every GPU in at least fp32, and positive numbers only", () => {
    for (const [name, peak] of entries) {
      expect(peak.fp32, name).toBeTypeOf("number");
      for (const p of PRECISIONS) {
        const v = peak[p];
        if (v !== null) expect(v, `${name} ${p}`).toBeGreaterThan(0);
      }
    }
  });

  it("keeps the orderings that hold on every vendor sheet", () => {
    for (const [name, peak] of entries) {
      // Tensor-core FP16 (FP32 accumulate) beats non-tensor FP32 and TF32 on each listed GPU.
      if (peak.fp16 !== null) {
        expect(peak.fp16, `${name} fp16 > fp32`).toBeGreaterThan(peak.fp32!);
        if (peak.tf32 !== null) {
          expect(peak.fp16, `${name} fp16 > tf32`).toBeGreaterThan(peak.tf32);
        }
      }
      // TF32 tensor is never below the non-tensor FP32 rate (equal on GeForce Ada/Blackwell and L40).
      if (peak.tf32 !== null) {
        expect(peak.tf32, `${name} tf32 >= fp32`).toBeGreaterThanOrEqual(
          peak.fp32!,
        );
      }
    }
  });

  it("does not claim TF32 on pre-Ampere GPUs", () => {
    for (const name of [
      "RTX 2080 Ti",
      "Tesla V100",
      "Tesla T4",
      "Titan RTX",
      "Q RTX 6000",
      "Titan Xp",
      "GTX 1080",
    ]) {
      expect(peakTflops(name, "tf32"), name).toBeNull();
    }
  });

  it("looks a name up with underscores like --gpu spells it", () => {
    expect(peakTflops("RTX_4090", "fp16")).toBe(165.2);
    expect(peakTflops("No Such GPU", "fp16")).toBeNull();
    expect(peakTflops(undefined, "fp32")).toBeNull();
  });
});
