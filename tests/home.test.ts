import { getEncoding } from "js-tiktoken";
import { describe, expect, it } from "vitest";
import { REGISTRY } from "../src/commands/index.js";
import {
  fakeEnv,
  newCallLog,
  readCallLog,
  runCli,
  withEnv,
} from "./helpers/run-cli.js";

const nowS = () => Date.now() / 1000;

/** A running instance; `ageMin` is relative to now so idle tests are clock-proof. */
function inst(over: Record<string, unknown> = {}): Record<string, unknown> {
  const { ageMin = 120, ...rest } = over;
  return {
    id: 5001,
    label: "job",
    gpu_name: "RTX 4090",
    num_gpus: 1,
    disk_space: 40,
    dph_total: 0.4,
    storage_cost: 0.1,
    actual_status: "running",
    intended_status: "running",
    status_msg: "",
    start_date: nowS() - (ageMin as number) * 60,
    gpu_util: 80,
    ...rest,
  };
}

/** Env that makes `show instances` return exactly `list`. */
function withInstances(list: unknown[]): Record<string, string> {
  return {
    FAKE_VASTAI_ROUTES: JSON.stringify({
      "show instances": { stdout: JSON.stringify(list) },
    }),
  };
}

const dash = async (env: Record<string, string> = {}) => runCli([], { env });

describe("dashboard (R4)", () => {
  it("prints balance, instances, burn and 24h projection from the shared fixtures", async () => {
    const { stdout, exitCode } = await dash();
    expect(exitCode).toBe(0);
    expect(stdout).toContain("balance: 12.35");
    expect(stdout).toContain(
      "instances[2]{id,label,gpu,status,dph_total,age_h,gpu_util,idle}:",
    );
    expect(stdout).toContain("1000001,train-run,RTX 4090,running,0.4,");
    expect(stdout).toContain("stopped[1]{id,label,gpu,storage_per_hr}:");
    expect(stdout).toContain("burn_per_hr:");
    expect(stdout).toContain("projection_24h:");
  });

  it("makes exactly three upstream calls: show user, show instances (KTD6) and show scheduled-jobs", async () => {
    const log = newCallLog();
    await dash({ FAKE_VASTAI_LOG: log });
    const calls = readCallLog(log).map((c) => c.tokens.join(" "));
    expect(calls.sort()).toEqual([
      "show instances",
      "show scheduled-jobs",
      "show user",
    ]);
  });

  it("two running instances at 0.40 and 0.60 give burn 1.00 and projection 24.00", async () => {
    const { stdout } = await dash(
      withInstances([
        inst({ id: 1, dph_total: 0.4 }),
        inst({ id: 2, dph_total: 0.6 }),
      ]),
    );
    expect(stdout).toContain("burn_per_hr: 1\n");
    expect(stdout).toContain("projection_24h: 24\n");
    expect(stdout).not.toContain("warning");
  });

  it("folds a stopped instance's storage into burn (OQ14a)", async () => {
    const stopped = inst({
      id: 3,
      actual_status: "exited",
      intended_status: "stopped",
      dph_total: 5,
      storage_cost: 73,
      disk_space: 10,
    });
    const { stdout } = await dash(
      withInstances([inst({ dph_total: 0.5 }), stopped]),
    );
    // 73 $/GB/month * 10 GB / 730 h = 1.00 $/hr of storage, not the 5 $/hr GPU rate
    expect(stdout).toContain("3,job,RTX 4090,1\n");
    expect(stdout).toContain("burn_per_hr: 1.5\n");
  });

  it("rounds dph_total to 4 decimals instead of printing float noise", async () => {
    const { stdout } = await dash(
      withInstances([inst({ dph_total: 0.04891851851851852 })]),
    );
    expect(stdout).toContain(",0.0489,");
    expect(stdout).not.toContain("0.048918");
  });

  it("burn_per_hr keeps 4 decimals so a stopped instance never shows 0 beside a non-zero projection", async () => {
    // 0.1333 $/GB/month * 10 GB / 730 h = 0.0018 $/hr of storage
    const stopped = inst({
      id: 4,
      actual_status: "exited",
      intended_status: "stopped",
      storage_cost: 0.1333333333333333,
      disk_space: 10,
    });
    const { stdout } = await dash(withInstances([stopped]));
    expect(stdout).toContain("burn_per_hr: 0.0018\n");
    expect(stdout).toContain("projection_24h: 0.04\n");
  });

  describe("runway_h", () => {
    const burning = [
      inst({ id: 1, dph_total: 0.4 }),
      inst({ id: 2, dph_total: 0.6 }),
    ];
    /** Dashboard with burn 1.00 $/hr and `show user` replaced by `user`. */
    const withUser = (user: unknown, list: unknown[] = burning) =>
      dash({
        FAKE_VASTAI_ROUTES: JSON.stringify({
          "show user": { stdout: JSON.stringify(user) },
          "show instances": { stdout: JSON.stringify(list) },
        }),
      });

    it("is balance / burn_per_hr in hours at one decimal, right after burn_per_hr", async () => {
      const { stdout } = await dash(withInstances(burning));
      // fixture balance 12.3456 / burn 1.00
      expect(stdout).toContain(
        "burn_per_hr: 1\nrunway_h: 12.3\nprojection_24h:",
      );
      const odd = await withUser({ credit: 10 }, [inst({ dph_total: 0.3 })]);
      expect(odd.stdout).toContain("runway_h: 33.3\n");
    });

    it("is left out when nothing is burning", async () => {
      const { stdout } = await dash(withInstances([]));
      expect(stdout).toContain("burn_per_hr: 0");
      expect(stdout).not.toContain("runway_h");
    });

    it("is left out when the balance is unknown", async () => {
      const { stdout, exitCode } = await withUser({});
      expect(exitCode).toBe(0);
      expect(stdout).toContain("balance: null");
      expect(stdout).not.toContain("runway_h");
    });

    it("is 0 for a zero or negative balance instead of a negative number", async () => {
      const zero = await withUser({ credit: 0 });
      expect(zero.stdout).toContain("runway_h: 0\n");
      const negative = await withUser({ credit: -3.5 });
      expect(negative.stdout).toContain("balance: -3.5");
      expect(negative.stdout).toContain("runway_h: 0\n");
      expect(negative.stdout).not.toContain("runway_h: -");
    });

    it("is explained in the dashboard help", () => {
      expect(REGISTRY.home.help).toContain("runway_h = balance / burn_per_hr");
    });
  });

  it("zero instances prints the empty state and a search suggestion", async () => {
    const { stdout, exitCode } = await dash(withInstances([]));
    expect(exitCode).toBe(0);
    expect(stdout).toContain("instances: 0 running instances");
    expect(stdout).toContain("burn_per_hr: 0");
    expect(stdout).toContain("vast-axi search");
  });

  it("E32: idle is a tri-state and a likely row points at --live, never at stop", async () => {
    const { stdout } = await dash(
      withInstances([
        inst({ id: 11, label: "busy", gpu_util: 99.99, ageMin: 300 }),
        inst({ id: 12, label: "empty", gpu_util: 0, ageMin: 40 }),
        inst({ id: 13, label: "young", gpu_util: 0, ageMin: 6 }),
        inst({ id: 14, label: "blank", gpu_util: null, ageMin: 300 }),
        inst({ id: 15, label: "mid", gpu_util: 0, ageMin: 20 }),
      ]),
    );
    expect(stdout).toMatch(/11,busy,RTX 4090,running,0[.]4,[0-9.]+,100,no/);
    expect(stdout).toMatch(/12,empty,RTX 4090,running,0[.]4,[0-9.]+,0,likely/);
    expect(stdout).toMatch(/13,young,RTX 4090,running,0[.]4,[0-9.]+,0,unknown/);
    expect(stdout).toMatch(
      /14,blank,RTX 4090,running,0[.]4,[0-9.]+,null,unknown/,
    );
    expect(stdout).toMatch(/15,mid,RTX 4090,running,0[.]4,[0-9.]+,0,no/);
    expect(stdout).not.toMatch(/,(true|false)$/m);
    expect(stdout).toContain(
      "#12 looks idle per vast.ai's delayed gpu_util; confirm with `vast-axi status 12 --live` before stopping",
    );
    expect(stdout).not.toContain("#13 looks idle");
    expect(stdout).not.toContain("vast-axi stop");
    expect(stdout).not.toContain("destroy");
    expect(stdout).toContain(
      "note: gpu_util comes from vast.ai and lags real usage by minutes; no timestamp is provided",
    );
  });

  it("E32: the note appears for an unknown row alone, and not when every row is no", async () => {
    const unknown = await dash(
      withInstances([inst({ id: 16, gpu_util: 0, ageMin: 6 })]),
    );
    expect(unknown.stdout).toContain("note: gpu_util comes from vast.ai");
    expect(unknown.stdout).not.toContain("looks idle");
    const busy = await dash(withInstances([inst({ id: 17, gpu_util: 90 })]));
    expect(busy.stdout).not.toContain("note:");
  });

  it("idleMinutes comes from VAST_AXI_IDLE_MINUTES (OQ13a)", async () => {
    const list = withInstances([inst({ id: 14, gpu_util: 0, ageMin: 45 })]);
    expect((await dash(list)).stdout).toContain(",0,likely");
    const strict = await dash({ ...list, VAST_AXI_IDLE_MINUTES: "60" });
    expect(strict.stdout).toContain(",0,no");
  });

  it("metricLagMinutes comes from VAST_AXI_METRIC_LAG_MINUTES", async () => {
    const list = withInstances([inst({ id: 18, gpu_util: 0, ageMin: 20 })]);
    const wide = await dash({ ...list, VAST_AXI_IDLE_MINUTES: "5" });
    expect(wide.stdout).toContain(",0,likely");
    const lagged = await dash({
      ...list,
      VAST_AXI_IDLE_MINUTES: "5",
      VAST_AXI_METRIC_LAG_MINUTES: "30",
    });
    expect(lagged.stdout).toContain(",0,unknown");
  });

  it("adds a warning when burn exceeds maxBurn, default 2x the cap (R15)", async () => {
    const over = await dash({ U4_FIXTURE: "u4-burn.json" });
    expect(over.stdout).toContain(
      "warning: burn $2.5/hr exceeds maxBurn $2/hr",
    );
    const raised = await dash({
      U4_FIXTURE: "u4-burn.json",
      VAST_AXI_MAX_BURN: "3",
    });
    expect(raised.stdout).not.toContain("warning");
    const capped = await dash({
      U4_FIXTURE: "u4-burn.json",
      VAST_AXI_MAX_DPH: "2",
    });
    expect(capped.stdout).not.toContain("warning");
  });

  it("does not warn when burn equals maxBurn", async () => {
    const { stdout } = await dash({
      U4_FIXTURE: "u4-burn.json",
      VAST_AXI_MAX_BURN: "2.5",
    });
    expect(stdout).not.toContain("warning");
  });

  it("E11/E17: exited, offline, unknown and booting instances never read as running", async () => {
    const { stdout } = await dash({ U4_FIXTURE: "u4-states.json" });
    expect(stdout).not.toContain("running,");
    expect(stdout).toContain("2001,null,RTX 4090,booting (slow)");
    expect(stdout).toContain("2002,null,RTX 4090,terminal");
    expect(stdout).toContain("2003,null,RTX 4090,terminal");
    expect(stdout).toContain("stopped[2]");
  });

  it("E27: a unicode label is preserved in TOON and JSON", async () => {
    const toon = await dash();
    expect(toon.stdout).toContain("训练-ünï");
    const direct = await withEnv(fakeEnv(), () => REGISTRY.home.command([]));
    expect(JSON.stringify(direct)).toContain("训练-ünï");
  });

  it("E20: an unknown flag is a VALIDATION_ERROR", async () => {
    await expect(
      withEnv(fakeEnv(), async () => REGISTRY.home.command(["--bogus"])),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("stays under 300 o200k tokens for two instances", async () => {
    const { stdout } = await dash(
      withInstances([
        inst({ id: 6001, label: "train-run", gpu_util: 88 }),
        inst({ id: 6002, label: "idle-box", gpu_util: 0, dph_total: 0.6 }),
      ]),
    );
    // Count the whole output, SDK header included, with the bin path normalised.
    const text = `bin: vast-axi\n${stdout.slice(stdout.indexOf("description:"))}`;
    const tokens = getEncoding("o200k_base").encode(text).length;
    expect(tokens).toBeLessThan(300);
  });
});
