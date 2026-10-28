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

const showInstances = (stdout: string): Env => ({
  FAKE_VASTAI_ROUTES: JSON.stringify({ "show instances": { stdout } }),
});

interface Run {
  stdout: string;
  exitCode: number;
  calls: FakeCall[];
  /** The `create instance` calls only. */
  created: FakeCall[];
}

async function rent(argv: string[], env: Env = {}): Promise<Run> {
  const log = newCallLog();
  const { stdout, exitCode } = await runCli(["rent", ...argv], {
    env: { FAKE_VASTAI_LOG: log, ...env },
  });
  const calls = readCallLog(log);
  const created = calls.filter(
    (c) => c.tokens[0] === "create" && c.tokens[1] === "instance",
  );
  return { stdout, exitCode, calls, created };
}

const IMG = ["--image", "vastai/base-image"];
const EMPTY = showInstances("[]");

describe("flags and arguments (no money moves)", () => {
  it("E20: an unknown flag exits 2, lists the valid flags, and runs nothing", async () => {
    const r = await rent(["5001", ...IMG, "--bogus"]);
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain("VALIDATION_ERROR");
    expect(r.stdout).toContain("--bogus");
    expect(r.stdout).toContain("--confirm");
    expect(r.calls).toHaveLength(0);
  });

  it("exits 2 when both --image and --template are missing, and runs nothing", async () => {
    const r = await rent(["5001"]);
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain("--image or --template");
    expect(r.calls).toHaveLength(0);
  });

  it.each([["abc"], ["-5"], ["1.5"], ["0"]])(
    "exits 2 for the offer id %s and runs nothing",
    async (id) => {
      const r = await rent([id, ...IMG]);
      expect(r.exitCode).toBe(2);
      expect(r.calls).toHaveLength(0);
    },
  );

  it("exits 2 when the offer id is missing", async () => {
    const r = await rent([...IMG]);
    expect(r.exitCode).toBe(2);
    expect(r.calls).toHaveLength(0);
  });

  it("exits 2 for a second positional and runs nothing", async () => {
    const r = await rent(["5001", "5002", ...IMG]);
    expect(r.exitCode).toBe(2);
    expect(r.calls).toHaveLength(0);
  });

  it.each([["0"], ["-3"], ["abc"]])(
    "exits 2 for --disk %s and runs nothing",
    async (disk) => {
      const r = await rent(["5001", ...IMG, "--disk", disk]);
      expect(r.exitCode).toBe(2);
      expect(r.calls).toHaveLength(0);
    },
  );

  it("exits 1 with CONFIG_ERROR for a bad cap setting and runs nothing", async () => {
    const r = await rent(["5001", ...IMG], { VAST_AXI_MAX_DPH: "abc" });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("CONFIG_ERROR");
    expect(r.calls).toHaveLength(0);
  });

  it("prints help with --help and runs nothing", async () => {
    const log = newCallLog();
    const { stdout, exitCode } = await runCli(["rent", "--help"], {
      env: { FAKE_VASTAI_LOG: log },
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("usage: vast-axi rent");
    expect(stdout).toContain("--confirm");
    expect(readCallLog(log)).toHaveLength(0);
  });
});

describe("a rent that the guard allows", () => {
  it("looks the offer up with -n, prices the requested disk, then creates with the documented argv", async () => {
    const r = await rent(
      ["5001", ...IMG, "--disk", "40", "--label", "train run"],
      EMPTY,
    );
    expect(r.exitCode).toBe(0);
    const lookup = r.calls[0]!;
    expect(lookup.tokens).toEqual(["search", "offers", "ask_contract_id=5001"]);
    expect(lookup.argv).toContain("-n");
    expect(lookup.argv.slice(lookup.argv.indexOf("--storage"))).toEqual([
      "--storage",
      "40",
    ]);
    expect(r.created).toHaveLength(1);
    expect(r.created[0]!.argv.slice(3)).toEqual([
      "create",
      "instance",
      "5001",
      "--image",
      "vastai/base-image",
      "--ssh",
      "--direct",
      "--disk",
      "40",
      "--label",
      "train run",
      "--cancel-unavail",
    ]);
  });

  it("defaults the disk to 20 and omits --label when none is given", async () => {
    const r = await rent(["5001", ...IMG], EMPTY);
    const argv = r.created[0]!.argv;
    expect(
      argv.slice(argv.indexOf("--disk"), argv.indexOf("--disk") + 2),
    ).toEqual(["--disk", "20"]);
    expect(argv).not.toContain("--label");
    expect(argv).toContain("--cancel-unavail");
  });

  it("outputs instance_id, dph_total and the three help lines", async () => {
    const r = await rent(["5001", ...IMG], EMPTY);
    expect(r.stdout).toContain("instance_id: 7835610");
    expect(r.stdout).toContain("dph_total: 0.5");
    expect(r.stdout).not.toContain("hours:");
    expect(r.stdout).toContain("vast-axi status 7835610 --wait");
    expect(r.stdout).toContain("vast-axi ssh 7835610");
    expect(r.stdout).toContain("vast-axi destroy 7835610");
    expect(r.stdout).not.toContain("guard:");
  });

  it("shows type: on-demand right after instance_id", async () => {
    const r = await rent(["5001", ...IMG], EMPTY);
    expect(r.stdout).toMatch(/instance_id: 7835610\ntype: on-demand\n/);
    const json = await rent(["5001", ...IMG, "--json"], EMPTY);
    expect(Object.keys(JSON.parse(json.stdout)).slice(0, 2)).toEqual([
      "instance_id",
      "type",
    ]);
  });

  it("E61: create instance never carries --bid_price (default, --confirm, template)", async () => {
    for (const argv of [
      ["5001", ...IMG],
      ["5004", ...IMG, "--confirm"],
      ["5001", "--template", "abc123", "--disk", "40", "--label", "x"],
    ]) {
      const r = await rent(argv, EMPTY);
      expect(r.created).toHaveLength(1);
      expect(r.created[0]!.argv).not.toContain("--bid_price");
    }
  });

  it("makes no show user call without --hours (no balance read)", async () => {
    const r = await rent(["5001", ...IMG], EMPTY);
    expect(r.calls.some((c) => c.tokens.join(" ") === "show user")).toBe(false);
  });

  it("emits the same fields with --json", async () => {
    const r = await rent(["5001", ...IMG, "--json"], EMPTY);
    const out = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(out["instance_id"]).toBe(7835610);
    expect(out["dph_total"]).toBe(0.5);
  });

  it("passes --template as --template_hash and no --image", async () => {
    const r = await rent(["5001", "--template", "abc123"], EMPTY);
    expect(r.exitCode).toBe(0);
    const argv = r.created[0]!.argv;
    expect(argv).toContain("--template_hash");
    expect(argv[argv.indexOf("--template_hash") + 1]).toBe("abc123");
    expect(argv).not.toContain("--image");
  });

  it("prices and rents an unverified external offer (lookup uses -n)", async () => {
    const r = await rent(["5005", ...IMG], EMPTY);
    expect(r.exitCode).toBe(0);
    expect(r.calls[0]!.argv).toContain("-n");
    expect(r.created).toHaveLength(1);
  });
});

describe("R8/R15: per-instance cap", () => {
  it("AE2/E16: 1.80 vs cap 1.00 exits 2, names the cap and --confirm, and never creates", async () => {
    const r = await rent(["5004", ...IMG], EMPTY);
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain("VALIDATION_ERROR");
    expect(r.stdout).toContain("$1.8/hr");
    expect(r.stdout).toContain("$1/hr per-instance cap");
    expect(r.stdout).toContain("--confirm");
    expect(r.created).toHaveLength(0);
  });

  it("E16: cap + 0.0001 exits 2 and never creates", async () => {
    const r = await rent(["5003", ...IMG], EMPTY);
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain("--confirm");
    expect(r.created).toHaveLength(0);
  });

  it("E15: a price exactly at the cap is allowed without --confirm", async () => {
    const r = await rent(["5002", ...IMG], EMPTY);
    expect(r.exitCode).toBe(0);
    expect(r.created).toHaveLength(1);
    expect(r.stdout).toContain("instance_id: 7835610");
  });

  it("--confirm rents an over-cap offer and reports the override", async () => {
    const r = await rent(["5004", ...IMG, "--confirm"], EMPTY);
    expect(r.exitCode).toBe(0);
    expect(r.created).toHaveLength(1);
    expect(r.stdout).toContain("instance_id: 7835610");
    expect(r.stdout).toContain("dph_total: 1.8");
    expect(r.stdout).toContain("OVER_CAP");
  });

  it("R15: VAST_AXI_MAX_DPH raises the cap", async () => {
    const r = await rent(["5004", ...IMG], {
      ...EMPTY,
      VAST_AXI_MAX_DPH: "2",
      VAST_AXI_MAX_BURN: "4",
    });
    expect(r.exitCode).toBe(0);
    expect(r.created).toHaveLength(1);
  });

  it("R15: VAST_AXI_MAX_DPH can lower the cap below a cheap offer", async () => {
    const r = await rent(["5001", ...IMG], {
      ...EMPTY,
      VAST_AXI_MAX_DPH: "0.4",
    });
    expect(r.exitCode).toBe(2);
    expect(r.created).toHaveLength(0);
  });
});

describe("OQ12a: aggregate burn ceiling", () => {
  it("E31: burn 1.0082 (fixture) + 1.00 exceeds the 2.00 ceiling: exit 2, no create", async () => {
    const r = await rent(["5002", ...IMG]); // core instances.json
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain("burn ceiling");
    expect(r.stdout).toContain("--confirm");
    expect(r.created).toHaveLength(0);
  });

  it("E31: --confirm overrides the ceiling", async () => {
    const r = await rent(["5002", ...IMG, "--confirm"]);
    expect(r.exitCode).toBe(0);
    expect(r.created).toHaveLength(1);
    expect(r.stdout).toContain("OVER_BURN");
  });

  it("E31: burn + price exactly at the ceiling is allowed", async () => {
    const r = await rent(["5001", ...IMG], showInstances(instances(1.5)));
    expect(r.exitCode).toBe(0);
    expect(r.created).toHaveLength(1);
  });

  it("E31: burn + price over the ceiling by 0.0001 is refused", async () => {
    const r = await rent(["5001", ...IMG], showInstances(instances(1.5001)));
    expect(r.exitCode).toBe(2);
    expect(r.created).toHaveLength(0);
  });

  it("sums running instances at dph_total and stopped ones at storage only", async () => {
    // 1.0 running + 0.5 running + stopped (0.1 * 730 GB / 730 = 0.1) = 1.6; + 0.5 = 2.1 > 2
    const stdout = JSON.stringify([
      {
        id: 1,
        actual_status: "running",
        dph_total: 1,
        storage_cost: 0.1,
        disk_space: 20,
      },
      {
        id: 2,
        actual_status: "running",
        dph_total: 0.5,
        storage_cost: 0.1,
        disk_space: 20,
      },
      {
        id: 3,
        actual_status: "exited",
        dph_total: 9,
        storage_cost: 0.1,
        disk_space: 730,
      },
    ]);
    const r = await rent(["5001", ...IMG], showInstances(stdout));
    expect(r.exitCode).toBe(2);
    expect(r.created).toHaveLength(0);
  });

  it("R15: VAST_AXI_MAX_BURN raises the ceiling", async () => {
    const r = await rent(["5002", ...IMG], { VAST_AXI_MAX_BURN: "3" });
    expect(r.exitCode).toBe(0);
    expect(r.created).toHaveLength(1);
  });

  it("an over-cap offer and an over-ceiling burn are reported together", async () => {
    const r = await rent(["5004", ...IMG], showInstances(instances(1.5)));
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain("per-instance cap");
    expect(r.stdout).toContain("burn ceiling");
    expect(r.created).toHaveLength(0);
  });
});

describe("the guard fails closed", () => {
  it.each([
    [
      "a rate limit",
      { stderr: '{"error":true,"status_code":429,"msg":"slow"}\n' },
    ],
    ["a crash", { stderr: "Traceback: boom\n", exit: 1 }],
    ["garbage output", { stdout: '[{"id": 1, "dph' }],
    ["an unexpected shape", { stdout: '{"nope": true}' }],
  ])(
    "refuses when show instances fails with %s, even with --confirm, and never creates",
    async (_name, response) => {
      const env = {
        FAKE_VASTAI_ROUTES: JSON.stringify({ "show instances": response }),
      };
      for (const extra of [[], ["--confirm"]]) {
        const r = await rent(["5001", ...IMG, ...extra], env);
        expect(r.exitCode).toBe(1);
        expect(r.stdout).toContain("BURN_UNKNOWN");
        expect(r.created).toHaveLength(0);
      }
    },
  );

  it("refuses an offer with no price even with --confirm, and never creates", async () => {
    const r = await rent(["5010", ...IMG, "--confirm"], EMPTY);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("PRICE_UNKNOWN");
    expect(r.created).toHaveLength(0);
  });

  it("stops at an auth failure on the price lookup without creating", async () => {
    const r = await rent(["5001", ...IMG, "--confirm"], {
      FAKE_VASTAI_SCENARIO: "auth401",
    });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("AUTH_REQUIRED");
    expect(r.created).toHaveLength(0);
  });

  it("reports a create that returned no instance id and warns to check status first", async () => {
    const r = await rent(["5012", ...IMG], EMPTY);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("UPSTREAM_PARSE_ERROR");
    expect(r.stdout).toContain("vast-axi status");
  });

  it("does not retry a create that failed upstream", async () => {
    const r = await rent(["5014", ...IMG], EMPTY);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("UPSTREAM_ERROR");
    expect(r.created).toHaveLength(1);
  });
});

describe("E13: offer gone", () => {
  it.each([
    ["an empty price lookup", "5006"],
    ["a lookup that returns a different offer id", "5009"],
    ["an offer that is not rentable", "5011"],
    ["a create that answers no_such_ask", "5007"],
    ["a create that answers a plain not found", "5013"],
  ])("%s maps to OFFER_UNAVAILABLE with a search hint", async (_name, id) => {
    const r = await rent([id, ...IMG, "--confirm"], EMPTY);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("OFFER_UNAVAILABLE");
    expect(r.stdout).toContain("vast-axi search");
  });

  it("never creates when the price lookup finds nothing", async () => {
    const r = await rent(["5006", ...IMG, "--confirm"], EMPTY);
    expect(r.created).toHaveLength(0);
  });
});

describe("E14: insufficient credit", () => {
  it("maps the upstream message to INSUFFICIENT_CREDIT and shows the balance", async () => {
    const r = await rent(["5008", ...IMG], EMPTY);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("INSUFFICIENT_CREDIT");
    expect(r.stdout).toContain("balance $12.35");
    expect(r.stdout).toContain("$0.5/hr");
    expect(r.calls.some((c) => c.tokens.join(" ") === "show user")).toBe(true);
  });

  it("still reports INSUFFICIENT_CREDIT when the balance lookup fails", async () => {
    const r = await rent(["5008", ...IMG], {
      FAKE_VASTAI_ROUTES: JSON.stringify({
        "show instances": { stdout: "[]" },
        "show user": { stdout: "not json" },
      }),
    });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("INSUFFICIENT_CREDIT");
    expect(r.stdout).not.toContain("balance $");
  });
});
