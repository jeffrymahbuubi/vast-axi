import { decode } from "@toon-format/toon";
import { describe, expect, it } from "vitest";
import {
  ageHours,
  byteSize,
  formatDuration,
  gpuRamGb,
  median,
  money,
  pickFields,
  pricePerHr,
  round,
  truncate,
} from "../src/format.js";
import {
  emptyState,
  renderBlocks,
  renderError,
  renderHelp,
  renderOutput,
} from "../src/toon.js";

describe("format", () => {
  it("pricePerHr rounds to 4 decimals and passes missing prices as null", () => {
    expect(pricePerHr(0.04891851851851852)).toBe(0.0489);
    expect(pricePerHr(0.4)).toBe(0.4);
    expect(pricePerHr(null)).toBeNull();
    expect(pricePerHr(undefined)).toBeNull();
  });

  it("gpuRamGb converts MB to GB", () => {
    expect(gpuRamGb(24564)).toBe(24);
    expect(gpuRamGb(8192)).toBe(8);
  });

  it("truncate leaves short text and appends [+N chars] to long text", () => {
    expect(truncate("short", 400)).toBe("short");
    const long = "x".repeat(1634);
    const out = truncate(long, 400);
    expect(out).toBe(`${"x".repeat(400)}[+1234 chars]`);
  });

  it("byteSize picks a readable unit", () => {
    expect(byteSize(512)).toBe("512 B");
    expect(byteSize(3.4 * 1024)).toBe("3.4 KB");
    expect(byteSize(10 * 1024 * 1024)).toBe("10.0 MB");
  });

  it("formatDuration is compact", () => {
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(12 * 60)).toBe("12m");
    expect(formatDuration(2 * 3600 + 5 * 60)).toBe("2h05m");
    expect(formatDuration(3 * 86400 + 4 * 3600)).toBe("3d04h");
  });

  it("ageHours measures from an epoch-seconds start_date", () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    expect(ageHours(now / 1000 - 5400, now)).toBe(1.5);
  });

  it("money and round return numbers", () => {
    expect(money(0.40138888)).toBe(0.4);
    expect(money(0.40138888, 3)).toBe(0.401);
    expect(round(1.005, 1)).toBe(1);
  });

  it("median handles odd, even and empty lists", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });

  it("pickFields keeps order and fills missing keys with null", () => {
    expect(pickFields({ b: 2, a: 1, c: 3 }, ["a", "x", "b"])).toEqual({
      a: 1,
      x: null,
      b: 2,
    });
    expect(Object.keys(pickFields({ b: 2, a: 1 }, ["a", "b"]))).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("toon rendering", () => {
  it("renders an object as TOON followed by a multi-line help block", () => {
    const out = renderOutput({
      count: 2,
      help: [
        "Run `vast-axi rent <id> --image <image>`",
        "Run `vast-axi search --full`",
      ],
    });
    expect(out).toBe(
      "count: 2\nhelp[2]:\n  Run `vast-axi rent <id> --image <image>`\n  Run `vast-axi search --full`",
    );
  });

  it("renders uniform arrays as a TOON table", () => {
    const out = renderOutput({
      offers: [
        { id: 1, gpu: "RTX 4090" },
        { id: 2, gpu: "A100" },
      ],
    });
    expect(out).toContain("offers[2]{id,gpu}:");
  });

  it("--json prints the same structure as compact JSON, help included", () => {
    const output = { count: 1, help: ["next"] };
    expect(JSON.parse(renderOutput(output, { json: true }))).toEqual(output);
  });

  it("passes strings through, wrapping them as {output} under --json", () => {
    expect(renderOutput("plain text")).toBe("plain text");
    expect(JSON.parse(renderOutput("plain text", { json: true }))).toEqual({
      output: "plain text",
    });
  });

  it("emptyState is an explicit zero with optional help (R3)", () => {
    expect(
      renderOutput(
        emptyState("offers", "0 matching offers", ["Relax --max-dph"]),
      ),
    ).toBe("offers: 0 matching offers\nhelp[1]:\n  Relax --max-dph");
    expect(emptyState("instances", "0 running instances")).toEqual({
      instances: "0 running instances",
    });
  });

  it("renderHelp and renderBlocks skip empty input", () => {
    expect(renderHelp([])).toBe("");
    expect(renderBlocks(["a", "", false, undefined, "b"])).toBe("a\nb");
  });

  it("renderError prints error, code and help", () => {
    expect(renderError("boom", "UPSTREAM_ERROR", ["try again"])).toBe(
      "error: boom\ncode: UPSTREAM_ERROR\nhelp[1]:\n  try again",
    );
  });

  it("E27: unicode survives TOON and JSON round trips", () => {
    const rows = [{ id: 1, label: "训练-ünï", geolocation: "Zürich, CH" }];
    const toon = renderOutput({ instances: rows });
    expect(toon).toContain("训练-ünï");
    expect(decode(toon)).toEqual({ instances: rows });
    expect(
      JSON.parse(renderOutput({ instances: rows }, { json: true })),
    ).toEqual({
      instances: rows,
    });
  });
});
