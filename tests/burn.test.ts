import { describe, expect, it } from "vitest";
import {
  instanceBurnPerHr,
  projection24h,
  storagePerHr,
  totalBurnPerHr,
} from "../src/burn.js";
import instances from "./fixtures/instances.json" with { type: "json" };

describe("burn", () => {
  it("counts running instances at dph_total", () => {
    expect(
      instanceBurnPerHr({ actual_status: "running", dph_total: 0.4 }),
    ).toBe(0.4);
  });

  it("counts booting and terminal states at dph_total (conservative)", () => {
    expect(
      instanceBurnPerHr({ actual_status: "loading", dph_total: 0.5 }),
    ).toBe(0.5);
    expect(instanceBurnPerHr({ actual_status: null, dph_total: 0.5 })).toBe(
      0.5,
    );
    expect(
      instanceBurnPerHr({ actual_status: "offline", dph_total: 0.5 }),
    ).toBe(0.5);
  });

  it("bills stopped instances for storage only (OQ14a)", () => {
    // 0.12 $/GB/month * 50 GB / 730 h
    expect(storagePerHr({ storage_cost: 0.12, disk_space: 50 })).toBe(0.0082);
    expect(
      instanceBurnPerHr({
        actual_status: "exited",
        dph_total: 0.35,
        storage_cost: 0.12,
        disk_space: 50,
      }),
    ).toBe(0.0082);
  });

  it("treats missing fields as zero", () => {
    expect(instanceBurnPerHr({})).toBe(0);
    expect(totalBurnPerHr([])).toBe(0);
  });

  it("sums the fixture account and projects 24h", () => {
    const burn = totalBurnPerHr(instances as never);
    expect(burn).toBe(1.0082);
    expect(projection24h(burn)).toBe(24.2);
  });
});
