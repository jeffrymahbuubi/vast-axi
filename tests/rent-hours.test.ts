import { describe, expect, it } from "vitest";
import {
  newCallLog,
  readCallLog,
  runCli,
  type Env,
  type FakeCall,
} from "./helpers/run-cli.js";

/** A `show instances` body whose running instances burn exactly `burns` USD/hr in total. */
const instances = (...burns: number[]): string =>
  JSON.stringify(
    burns.map((dph, i) => ({
      id: 9000 + i,
      actual_status: "running",
      dph_total: dph,
      storage_cost: 0.1,
      disk_space: 20,
    })),
  );

const withBurn = (...burns: number[]): Env => ({
  FAKE_VASTAI_ROUTES: JSON.stringify({
    "show instances": { stdout: instances(...burns) },
  }),
});

interface Run {
  stdout: string;
  exitCode: number;
  calls: FakeCall[];
  created: FakeCall[];
  userCalls: FakeCall[];
}

async function rent(argv: string[], env: Env = {}): Promise<Run> {
  const log = newCallLog();
  const { stdout, exitCode } = await runCli(["rent", ...argv], {
    env: { FAKE_VASTAI_LOG: log, ...env },
  });
  const calls = readCallLog(log);
  return {
    stdout,
    exitCode,
    calls,
    created: calls.filter(
      (c) => c.tokens[0] === "create" && c.tokens[1] === "instance",
    ),
    userCalls: calls.filter((c) => c.tokens.join(" ") === "show user"),
  };
}

const IMG = ["--image", "vastai/base-image"];
// Offer 5001 costs 0.50 $/hr; the default balance (user.json) is 12.3456.
// U9_USER=low gives a 3.00 balance, zero gives 0, nobalance has no balance field.

describe("rent --hours: validation (E55)", () => {
  it.each([["0"], ["-1"], ["abc"], ["NaN"], ["721"], ["1e9"], ["Infinity"]])(
    "E55: --hours %s exits 2 and runs nothing",
    async (hours) => {
      const r = await rent(["5001", ...IMG, "--hours", hours]);
      expect(r.exitCode).toBe(2);
      expect(r.stdout).toContain("VALIDATION_ERROR");
      expect(r.stdout).toContain("--hours");
      expect(r.calls).toHaveLength(0);
    },
  );

  it("E55: --hours with no value exits 2 and runs nothing", async () => {
    const r = await rent(["5001", ...IMG, "--hours"]);
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain("--hours requires a value");
    expect(r.calls).toHaveLength(0);
  });

  it.each([["720"], ["1.5"], ["0.25"], ["1"]])(
    "E55: --hours %s is accepted",
    async (hours) => {
      // --confirm: 720 h of even a cheap offer exceeds the default balance.
      const r = await rent(
        ["5001", ...IMG, "--hours", hours, "--confirm"],
        withBurn(),
      );
      expect(r.exitCode).toBe(0);
    },
  );

  it("accepts --hours=N", async () => {
    const r = await rent(["5001", ...IMG, "--hours=2"], withBurn());
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("hours: 2");
  });

  it("documents --hours and OVER_BALANCE in --help", async () => {
    const { stdout } = await runCli(["rent", "--help"]);
    expect(stdout).toContain("--hours");
    expect(stdout).toContain("OVER_BALANCE");
  });
});

describe("rent --hours: allowed", () => {
  it("adds hours, est_cost, account_need and pct_balance; type stays right after instance_id", async () => {
    // burn 1.0 + offer 0.5 = 1.5 $/hr x 4 h = 6.00 needed, balance 12.3456
    const r = await rent(
      ["5001", ...IMG, "--hours", "4", "--json"],
      withBurn(1),
    );
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(out).toMatchObject({
      instance_id: 7835610,
      type: "on-demand",
      dph_total: 0.5,
      hours: 4,
      est_cost: 2,
      account_need: 6,
      pct_balance: 48.6,
    });
    expect(Object.keys(out).slice(0, 2)).toEqual(["instance_id", "type"]);
    expect(out).not.toHaveProperty("guard");
    expect(r.created).toHaveLength(1);
  });

  it("reads the balance exactly once, before the instance is created", async () => {
    const r = await rent(["5001", ...IMG, "--hours", "1"], withBurn());
    expect(r.userCalls).toHaveLength(1);
    const order = r.calls.map((c) => c.tokens.join(" "));
    expect(order.indexOf("show user")).toBeLessThan(
      order.indexOf("create instance 5001"),
    );
  });

  it("a need exactly at the balance is allowed", async () => {
    // 0.5 $/hr x 6 h = 3.00 = the 'low' balance
    const r = await rent(["5001", ...IMG, "--hours", "6"], {
      ...withBurn(),
      U9_USER: "low",
    });
    expect(r.exitCode).toBe(0);
    expect(r.created).toHaveLength(1);
    expect(r.stdout).toContain("pct_balance: 100");
  });

  it("prints the fields in TOON, in order", async () => {
    const r = await rent(["5001", ...IMG, "--hours", "2"], withBurn());
    expect(r.stdout).toMatch(
      /instance_id: 7835610\ntype: on-demand\ndph_total: 0\.5\npriced_for_disk_gb: 20\nhours: 2\nest_cost: 1\naccount_need: 1\npct_balance: 8\.1\n/,
    );
  });
});

describe("rent --hours: OVER_BALANCE", () => {
  it("refuses with exit 2, names the numbers and the way out, and never creates", async () => {
    // (burn 1.0 + 0.5) x 4 = 6.00 > balance 3.00
    const r = await rent(["5001", ...IMG, "--hours", "4"], {
      ...withBurn(1),
      U9_USER: "low",
    });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain("VALIDATION_ERROR");
    expect(r.stdout).toContain(
      "4 h x (burn $1/hr + offer $0.5/hr) = $6, above the $3 balance",
    );
    expect(r.stdout).toContain("--confirm");
    expect(r.stdout).toContain("Lower --hours");
    expect(r.stdout).toContain("add credit");
    expect(r.created).toHaveLength(0);
  });

  it("counts other running instances: the offer alone would fit", async () => {
    // offer alone: 0.5 x 4 = 2.00 <= 3.00, but with burn 1.0 the account needs 6.00
    const alone = await rent(["5001", ...IMG, "--hours", "4"], {
      ...withBurn(),
      U9_USER: "low",
    });
    expect(alone.exitCode).toBe(0);
    const loaded = await rent(["5001", ...IMG, "--hours", "4"], {
      ...withBurn(1),
      U9_USER: "low",
    });
    expect(loaded.exitCode).toBe(2);
  });

  it("--confirm overrides it, rents, and reports the override with the estimate", async () => {
    const r = await rent(["5001", ...IMG, "--hours", "4", "--confirm"], {
      ...withBurn(1),
      U9_USER: "low",
    });
    expect(r.exitCode).toBe(0);
    expect(r.created).toHaveLength(1);
    expect(r.stdout).toContain("OVER_BALANCE");
    expect(r.stdout).toContain("account_need: 6");
    expect(r.stdout).toContain("pct_balance: 200");
  });

  it("E60: a zero balance refuses, and --confirm rents with pct_balance null", async () => {
    const env = { ...withBurn(), U9_USER: "zero" };
    const refused = await rent(["5001", ...IMG, "--hours", "1"], env);
    expect(refused.exitCode).toBe(2);
    expect(refused.stdout).toContain("above the $0 balance");
    expect(refused.created).toHaveLength(0);
    const forced = await rent(
      ["5001", ...IMG, "--hours", "1", "--confirm", "--json"],
      env,
    );
    expect(forced.exitCode).toBe(0);
    expect(JSON.parse(forced.stdout)).toMatchObject({ pct_balance: null });
  });

  it("--confirm overrides OVER_BALANCE together with OVER_CAP", async () => {
    // offer 5004 costs 1.80 (cap 1.00) and 1.8 x 2 h = 3.60 > balance 3.00
    const env = { ...withBurn(), U9_USER: "low" };
    const refused = await rent(["5004", ...IMG, "--hours", "2"], env);
    expect(refused.exitCode).toBe(2);
    expect(refused.stdout).toContain("per-instance cap");
    expect(refused.stdout).toContain("above the $3 balance");
    const forced = await rent(
      ["5004", ...IMG, "--hours", "2", "--confirm"],
      env,
    );
    expect(forced.exitCode).toBe(0);
    expect(forced.stdout).toContain("OVER_CAP, OVER_BALANCE");
  });

  it("does not suggest a cheaper offer when only the balance is over", async () => {
    const r = await rent(["5001", ...IMG, "--hours", "40"], {
      ...withBurn(),
      U9_USER: "low",
    });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).not.toContain("cheaper offer");
  });
});

describe("rent --hours: BALANCE_UNKNOWN (E59)", () => {
  it.each([
    ["a user record without a balance", { U9_USER: "nobalance" }],
    [
      "a garbage show user reply",
      { FAKE_VASTAI_ROUTES: JSON.stringify({ "show user": { stdout: "{" } }) },
    ],
    [
      "a failing show user",
      {
        FAKE_VASTAI_ROUTES: JSON.stringify({
          "show user": { stderr: "Traceback: boom\n", exit: 1 },
        }),
      },
    ],
  ])(
    "E59: %s refuses with BALANCE_UNKNOWN, even with --confirm, and never creates",
    async (_name, env) => {
      for (const extra of [[], ["--confirm"]]) {
        const r = await rent(["5001", ...IMG, "--hours", "1", ...extra], env);
        expect(r.exitCode).toBe(1);
        expect(r.stdout).toContain("BALANCE_UNKNOWN");
        expect(r.stdout).toContain("does not override");
        expect(r.created).toHaveLength(0);
      }
    },
  );

  it("without --hours the same unreadable balance is irrelevant: rents, no show user call", async () => {
    const r = await rent(["5001", ...IMG], {
      ...withBurn(),
      U9_USER: "nobalance",
    });
    expect(r.exitCode).toBe(0);
    expect(r.userCalls).toHaveLength(0);
    expect(r.stdout).not.toContain("pct_balance");
  });
});

describe("E61: rent is on-demand only", () => {
  it("create instance never carries --bid_price, with --hours, --confirm or both", async () => {
    for (const extra of [
      ["--hours", "1"],
      ["--hours", "4", "--confirm"],
      ["--confirm"],
    ]) {
      const r = await rent(["5001", ...IMG, ...extra], {
        ...withBurn(1),
        U9_USER: "low",
      });
      expect(r.created).toHaveLength(1);
      expect(r.created[0]!.argv).not.toContain("--bid_price");
      expect(r.stdout).toContain("type: on-demand");
    }
  });

  it("offers no interruptible or bid flag", async () => {
    for (const flag of ["--bid", "--bid-price", "--interruptible"]) {
      const r = await rent(["5001", ...IMG, flag, "0.1"]);
      expect(r.exitCode).toBe(2);
      expect(r.calls).toHaveLength(0);
    }
  });
});
