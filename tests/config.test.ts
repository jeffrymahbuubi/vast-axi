import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configPath, DEFAULTS, loadConfig } from "../src/config.js";
import { AxiError } from "../src/errors.js";

/** A temp home with an optional ~/.config/vast-axi/config.json. */
function homeWith(content?: string): string {
  const home = mkdtempSync(join(tmpdir(), "vast-axi-config-"));
  if (content !== undefined) {
    mkdirSync(join(home, ".config", "vast-axi"), { recursive: true });
    writeFileSync(join(home, ".config", "vast-axi", "config.json"), content);
  }
  return home;
}

describe("loadConfig", () => {
  it("falls back to the defaults when there is no file or env var", () => {
    const cfg = loadConfig({ env: {}, homeDir: homeWith() });
    expect(cfg.maxDph).toBe(1);
    expect(cfg.maxBurn).toBe(2);
    expect(cfg.idleMinutes).toBe(DEFAULTS.idleMinutes);
    expect(cfg.sources).toEqual({
      maxDph: "default",
      maxBurn: "default",
      idleMinutes: "default",
      metricLagMinutes: "default",
    });
    expect(cfg.metricLagMinutes).toBe(15);
  });

  it("file overrides the default, and maxBurn follows a file maxDph", () => {
    const cfg = loadConfig({
      env: {},
      homeDir: homeWith(
        '{"maxDph": 0.5, "idleMinutes": 10, "defaultImage": "ignored"}',
      ),
    });
    expect(cfg.maxDph).toBe(0.5);
    expect(cfg.maxBurn).toBe(1);
    expect(cfg.idleMinutes).toBe(10);
    expect(cfg.sources.maxDph).toBe("file");
  });

  it("env var overrides the file", () => {
    const cfg = loadConfig({
      env: { VAST_AXI_MAX_DPH: "0.25", VAST_AXI_MAX_BURN: "3" },
      homeDir: homeWith('{"maxDph": 0.5, "maxBurn": 9}'),
    });
    expect(cfg.maxDph).toBe(0.25);
    expect(cfg.maxBurn).toBe(3);
    expect(cfg.sources).toMatchObject({ maxDph: "env", maxBurn: "env" });
  });

  it("malformed JSON is CONFIG_ERROR naming the file", () => {
    const home = homeWith("{ not json");
    try {
      loadConfig({ env: {}, homeDir: home });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AxiError);
      expect((error as AxiError).code).toBe("CONFIG_ERROR");
      expect((error as AxiError).message).toContain("config.json");
    }
  });

  it("rejects a non-object file and non-positive or non-numeric values", () => {
    for (const body of [
      "[]",
      '{"maxDph": "cheap"}',
      '{"maxDph": 0}',
      '{"maxDph": -1}',
    ]) {
      expect(() => loadConfig({ env: {}, homeDir: homeWith(body) })).toThrow(
        /CONFIG|must be|JSON/,
      );
    }
    expect(() =>
      loadConfig({ env: { VAST_AXI_MAX_DPH: "abc" }, homeDir: homeWith() }),
    ).toThrow(/VAST_AXI_MAX_DPH must be a positive number/);
  });

  it("metricLagMinutes reads VAST_AXI_METRIC_LAG_MINUTES, then the file, then 15", () => {
    const home = homeWith('{"metricLagMinutes": 20}');
    expect(loadConfig({ env: {}, homeDir: home }).metricLagMinutes).toBe(20);
    const cfg = loadConfig({
      env: { VAST_AXI_METRIC_LAG_MINUTES: "0" },
      homeDir: home,
    });
    expect(cfg.metricLagMinutes).toBe(0);
    expect(cfg.sources.metricLagMinutes).toBe("env");
    expect(() =>
      loadConfig({
        env: { VAST_AXI_METRIC_LAG_MINUTES: "-1" },
        homeDir: home,
      }),
    ).toThrow(/non-negative/);
  });

  it("allows idleMinutes of zero", () => {
    expect(
      loadConfig({ env: { VAST_AXI_IDLE_MINUTES: "0" }, homeDir: homeWith() })
        .idleMinutes,
    ).toBe(0);
  });

  it("VAST_AXI_CONFIG points at another file", () => {
    const home = homeWith('{"maxDph": 7}');
    const other = join(home, "other.json");
    writeFileSync(other, '{"maxDph": 3}');
    expect(configPath({ env: { VAST_AXI_CONFIG: other }, homeDir: home })).toBe(
      other,
    );
    expect(
      loadConfig({ env: { VAST_AXI_CONFIG: other }, homeDir: home }).maxDph,
    ).toBe(3);
  });
});
