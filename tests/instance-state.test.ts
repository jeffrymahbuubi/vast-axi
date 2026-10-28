import { describe, expect, it } from "vitest";
import { idleState } from "../src/idle.js";
import {
  SLOW_BOOT_SECONDS,
  asInstanceList,
  classifyInstance,
  gpuLabel,
  instanceAgeHours,
  nextSteps,
} from "../src/instance-state.js";

const NOW_MS = 1_800_000_000_000;
const NOW_S = NOW_MS / 1000;

describe("classifyInstance (KTD5 table)", () => {
  it("running is the only way to reach running", () => {
    expect(classifyInstance({ actual_status: "running" }, NOW_MS)).toEqual({
      class: "running",
    });
    for (const status of ["exited", "offline", "unknown", "loading", null]) {
      expect(
        classifyInstance({ actual_status: status }, NOW_MS).class,
      ).not.toBe("running");
    }
  });

  it("loading, creating and null are booting; an unlisted status is booting too", () => {
    for (const status of ["loading", "creating", null, "created", "weird"]) {
      expect(
        classifyInstance(
          { actual_status: status, start_date: NOW_S - 30 },
          NOW_MS,
        ),
      ).toEqual({ class: "booting" });
    }
    expect(classifyInstance({}, NOW_MS)).toEqual({ class: "booting" });
  });

  it("E12: booting past 10 minutes stays booting with reason slow", () => {
    const at = (age: number) =>
      classifyInstance(
        { actual_status: "loading", start_date: NOW_S - age },
        NOW_MS,
      );
    expect(at(SLOW_BOOT_SECONDS)).toEqual({ class: "booting" });
    expect(at(SLOW_BOOT_SECONDS + 1)).toEqual({
      class: "booting",
      reason: "slow",
    });
  });

  it("E11: exited with intended stopped is a user stop", () => {
    expect(
      classifyInstance(
        { actual_status: "exited", intended_status: "stopped" },
        NOW_MS,
      ),
    ).toEqual({ class: "stopped" });
  });

  it("E17: exited with intended running is host_stopped", () => {
    expect(
      classifyInstance(
        { actual_status: "exited", intended_status: "running" },
        NOW_MS,
      ),
    ).toEqual({ class: "stopped", reason: "host_stopped" });
  });

  it("E11: offline and unknown are terminal", () => {
    expect(classifyInstance({ actual_status: "offline" }, NOW_MS)).toEqual({
      class: "terminal",
      reason: "offline",
    });
    expect(classifyInstance({ actual_status: "unknown" }, NOW_MS)).toEqual({
      class: "terminal",
      reason: "unknown",
    });
  });
});

describe("nextSteps", () => {
  const text = (cls: Parameters<typeof nextSteps>[1]) =>
    nextSteps(7, cls).join("\n");

  it("terminal suggests destroy and search, never waiting", () => {
    const t = text({ class: "terminal", reason: "offline" });
    expect(t).toContain("vast-axi destroy 7");
    expect(t).toContain("vast-axi search");
    expect(t).not.toMatch(/wait/i);
  });

  it("stopped never suggests destroy", () => {
    expect(text({ class: "stopped" })).not.toContain("destroy");
    expect(text({ class: "stopped", reason: "host_stopped" })).not.toContain(
      "destroy",
    );
    expect(text({ class: "stopped", reason: "host_stopped" })).toContain(
      "vast-axi raw",
    );
  });

  it("booting never suggests destroy; fresh boot offers --wait, slow boot offers status", () => {
    expect(text({ class: "booting" })).toContain("status 7 --wait");
    expect(text({ class: "booting" })).not.toContain("destroy");
    expect(text({ class: "booting", reason: "slow" })).toContain(
      "vast-axi status 7",
    );
    expect(text({ class: "booting", reason: "slow" })).not.toContain("destroy");
  });

  it("running suggests ssh and stop", () => {
    expect(text({ class: "running" })).toContain("vast-axi ssh 7");
    expect(text({ class: "running" })).toContain("vast-axi stop 7");
  });
});

describe("helpers", () => {
  it("asInstanceList accepts a list or {instances: []} and nothing else", () => {
    expect(asInstanceList([{ id: 1 }])).toEqual([{ id: 1 }]);
    expect(asInstanceList({ instances: [{ id: 2 }] })).toEqual([{ id: 2 }]);
    expect(asInstanceList({ error: true })).toEqual([]);
    expect(asInstanceList(null)).toEqual([]);
  });

  it("gpuLabel prefixes the count for multi-GPU instances", () => {
    expect(gpuLabel({ gpu_name: "RTX 4090", num_gpus: 1 })).toBe("RTX 4090");
    expect(gpuLabel({ gpu_name: "RTX 4090", num_gpus: 4 })).toBe("4x RTX 4090");
    expect(gpuLabel({})).toBeNull();
  });

  it("instanceAgeHours is null without a start_date", () => {
    expect(instanceAgeHours({}, NOW_MS)).toBeNull();
    expect(instanceAgeHours({ start_date: NOW_S - 7200 }, NOW_MS)).toBe(2);
  });
});

describe("idleState (OQ13a, E32)", () => {
  const running = (age_min: number, gpu_util: number | null) => ({
    actual_status: "running",
    start_date: NOW_S - age_min * 60,
    gpu_util,
  });

  it("E32: likely only when running, past max(idleMinutes, grace), and util under 5%", () => {
    expect(idleState(running(40, 0), 30, NOW_MS)).toBe("likely");
    expect(idleState(running(120, 4.9), 30, NOW_MS)).toBe("likely");
    expect(idleState(running(30, 0), 30, NOW_MS)).toBe("likely");
  });

  it("E32: a young instance reading 0 is unknown, since the metric lags", () => {
    expect(idleState(running(6, 0), 30, NOW_MS)).toBe("unknown");
    expect(idleState(running(14.9, 0), 30, NOW_MS)).toBe("unknown");
    expect(idleState(running(5, 0), 0, NOW_MS)).toBe("unknown");
  });

  it("E32: between the grace window and idleMinutes with low util is no", () => {
    expect(idleState(running(20, 0), 30, NOW_MS)).toBe("no");
    expect(idleState(running(29.9, 0), 30, NOW_MS)).toBe("no");
  });

  it("E32: the grace window is the floor when idleMinutes is smaller", () => {
    expect(idleState(running(10, 0), 5, NOW_MS)).toBe("unknown");
    expect(idleState(running(15, 0), 5, NOW_MS)).toBe("likely");
    expect(idleState(running(20, 0), 30, NOW_MS, 5)).toBe("no");
    expect(idleState(running(10, 0), 5, NOW_MS, 5)).toBe("likely");
  });

  it("is no for a busy instance at any age, including util at the 5% boundary", () => {
    expect(idleState(running(120, 87), 30, NOW_MS)).toBe("no");
    expect(idleState(running(120, 99.99), 30, NOW_MS)).toBe("no");
    expect(idleState(running(120, 5), 30, NOW_MS)).toBe("no");
    expect(idleState(running(2, 80), 30, NOW_MS)).toBe("no");
  });

  it("E32: missing or negative utilisation, or a missing start_date, is unknown", () => {
    expect(idleState(running(120, null), 30, NOW_MS)).toBe("unknown");
    expect(idleState(running(120, -1), 30, NOW_MS)).toBe("unknown");
    expect(
      idleState({ actual_status: "running", gpu_util: 0 }, 30, NOW_MS),
    ).toBe("unknown");
    expect(
      idleState(
        { actual_status: "running" } as { actual_status: string },
        30,
        NOW_MS,
      ),
    ).toBe("unknown");
  });

  it("is no for a non-running instance", () => {
    expect(
      idleState({ ...running(120, 0), actual_status: "exited" }, 30, NOW_MS),
    ).toBe("no");
  });
});
