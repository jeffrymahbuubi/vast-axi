import { describe, expect, it } from "vitest";
import {
  decideSpend,
  type GuardDecision,
  type GuardInput,
  type GuardReason,
} from "../src/spend-guard.js";

/** Defaults: cap 1.00, ceiling 2.00, burn 0, no --confirm. */
const base: GuardInput = {
  offerPrice: 0.5,
  currentBurn: 0,
  maxDph: 1,
  maxBurn: 2,
  confirm: false,
};

const decide = (over: Partial<GuardInput>): GuardDecision =>
  decideSpend({ ...base, ...over });

function refused(d: GuardDecision) {
  if (d.allow) throw new Error("expected a refusal");
  return d;
}

function allowed(d: GuardDecision) {
  if (!d.allow) throw new Error(`expected allow, got ${d.reasons.join(",")}`);
  return d;
}

describe("decision table, price vs per-instance cap", () => {
  it("allows a price well under the cap", () => {
    expect(allowed(decide({ offerPrice: 0.5 })).overridden).toEqual([]);
  });

  it("E15: allows a price exactly at the cap (inclusive)", () => {
    expect(allowed(decide({ offerPrice: 1 })).overridden).toEqual([]);
  });

  it("E16: refuses cap + 0.0001, overridable", () => {
    const d = refused(decide({ offerPrice: 1.0001 }));
    expect(d.reason).toBe("OVER_CAP");
    expect(d.overridable).toBe(true);
  });

  it("refuses a price above the cap (AE2: 1.80 vs 1.00)", () => {
    expect(refused(decide({ offerPrice: 1.8 })).reasons).toEqual(["OVER_CAP"]);
  });

  it("honours a changed cap (R15: env or config value)", () => {
    expect(allowed(decide({ offerPrice: 1.8, maxDph: 2 })).overridden).toEqual(
      [],
    );
    expect(refused(decide({ offerPrice: 0.51, maxDph: 0.5 })).reason).toBe(
      "OVER_CAP",
    );
  });

  it("allows a free offer", () => {
    expect(allowed(decide({ offerPrice: 0 })).overridden).toEqual([]);
  });

  it("--confirm overrides the cap and reports what it overrode", () => {
    expect(
      allowed(decide({ offerPrice: 1.8, confirm: true })).overridden,
    ).toEqual(["OVER_CAP"]);
  });
});

describe("decision table, aggregate burn ceiling", () => {
  it("allows burn + price below the ceiling", () => {
    expect(
      allowed(decide({ currentBurn: 1, offerPrice: 0.5 })).overridden,
    ).toEqual([]);
  });

  it("allows burn + price exactly at the ceiling (inclusive)", () => {
    expect(
      allowed(decide({ currentBurn: 1.5, offerPrice: 0.5 })).overridden,
    ).toEqual([]);
  });

  it("does not refuse a sum that is equal only up to float noise (0.1 + 0.2 vs 0.3)", () => {
    expect(
      allowed(
        decide({ currentBurn: 0.1, offerPrice: 0.2, maxBurn: 0.3, maxDph: 1 }),
      ).overridden,
    ).toEqual([]);
  });

  it("E31: refuses burn + price over the ceiling by 0.0001, overridable", () => {
    const d = refused(decide({ currentBurn: 1.5001, offerPrice: 0.5 }));
    expect(d.reason).toBe("OVER_BURN");
    expect(d.reasons).toEqual(["OVER_BURN"]);
    expect(d.overridable).toBe(true);
  });

  it("E31: --confirm overrides the ceiling", () => {
    expect(
      allowed(decide({ currentBurn: 1.9, offerPrice: 0.5, confirm: true }))
        .overridden,
    ).toEqual(["OVER_BURN"]);
  });

  it("a price under the cap can still trip the ceiling alone", () => {
    const d = refused(decide({ currentBurn: 1.0082, offerPrice: 1 }));
    expect(d.reasons).toEqual(["OVER_BURN"]);
  });

  it("reports both soft reasons together, cap first", () => {
    const d = refused(decide({ currentBurn: 1.5, offerPrice: 1.8 }));
    expect(d.reasons).toEqual(["OVER_CAP", "OVER_BURN"]);
    expect(d.reason).toBe("OVER_CAP");
    expect(d.overridable).toBe(true);
  });

  it("--confirm overrides both soft reasons at once", () => {
    expect(
      allowed(decide({ currentBurn: 1.5, offerPrice: 1.8, confirm: true }))
        .overridden,
    ).toEqual(["OVER_CAP", "OVER_BURN"]);
  });

  it("honours a changed ceiling (VAST_AXI_MAX_BURN)", () => {
    expect(
      allowed(decide({ currentBurn: 2.5, offerPrice: 0.5, maxBurn: 3 }))
        .overridden,
    ).toEqual([]);
  });
});

describe("decision table, fail closed", () => {
  it.each([null, undefined])(
    "refuses an unknown burn (%s) and --confirm does not override it",
    (currentBurn) => {
      const d = refused(decide({ currentBurn }));
      expect(d.reason).toBe("BURN_UNKNOWN");
      expect(d.overridable).toBe(false);
      const withConfirm = refused(decide({ currentBurn, confirm: true }));
      expect(withConfirm.reason).toBe("BURN_UNKNOWN");
    },
  );

  it("does not let --confirm override an unknown burn on an over-cap offer either", () => {
    const d = refused(
      decide({ currentBurn: null, offerPrice: 1.8, confirm: true }),
    );
    expect(d.reasons).toEqual(["BURN_UNKNOWN", "OVER_CAP"]);
    expect(d.overridable).toBe(false);
  });

  it.each([null, undefined, Number.NaN, Infinity, -0.01])(
    "refuses an unusable price (%s) even with --confirm",
    (offerPrice) => {
      const d = refused(decide({ offerPrice, confirm: true }));
      expect(d.reason).toBe("PRICE_UNKNOWN");
      expect(d.overridable).toBe(false);
    },
  );

  it.each([Number.NaN, -1])("refuses an unusable burn (%s)", (currentBurn) => {
    expect(refused(decide({ currentBurn, confirm: true })).reason).toBe(
      "BURN_UNKNOWN",
    );
  });

  it.each<Partial<GuardInput>>([
    { maxDph: Number.NaN },
    { maxDph: 0 },
    { maxDph: -1 },
    { maxDph: Infinity },
    { maxBurn: Number.NaN },
    { maxBurn: 0 },
    { maxBurn: Infinity },
  ])("refuses unusable limits %o even with --confirm", (over) => {
    const d = refused(decide({ ...over, confirm: true }));
    expect(d.reasons).toContain("LIMITS_INVALID");
    expect(d.overridable).toBe(false);
  });

  it("never allows when a NaN limit would make every comparison false", () => {
    expect(decide({ maxDph: Number.NaN, offerPrice: 50 }).allow).toBe(false);
    expect(decide({ maxBurn: Number.NaN, currentBurn: 50 }).allow).toBe(false);
  });

  it("lists every hard reason before the soft ones", () => {
    const d = refused(decide({ offerPrice: null, currentBurn: null }));
    const order: GuardReason[] = ["PRICE_UNKNOWN", "BURN_UNKNOWN"];
    expect(d.reasons).toEqual(order);
  });
});

describe("decision table, plain allow", () => {
  it("--confirm on a clean rent changes nothing", () => {
    expect(allowed(decide({ confirm: true })).overridden).toEqual([]);
  });
});

describe("decision table, balance over --hours", () => {
  /** burn 1.0 + price 0.5 = 1.5 $/hr; over 4 h the account needs 6.00. */
  const hours4: Partial<GuardInput> = {
    currentBurn: 1,
    offerPrice: 0.5,
    hours: 4,
  };

  it("without hours the balance is ignored: no balance reason, whatever it is", () => {
    for (const balance of [undefined, null, 0, -5, Number.NaN, 0.01]) {
      expect(
        allowed(decide({ currentBurn: 1, offerPrice: 0.5, balance }))
          .overridden,
      ).toEqual([]);
    }
  });

  it("allows when the need is below the balance", () => {
    expect(allowed(decide({ ...hours4, balance: 10 })).overridden).toEqual([]);
  });

  it("allows a need exactly at the balance (inclusive)", () => {
    expect(allowed(decide({ ...hours4, balance: 6 })).overridden).toEqual([]);
  });

  it("does not refuse a need equal to the balance only up to float noise", () => {
    // (0.1 + 0.2) x 3 = 0.9000000000000001 in floating point
    expect(
      allowed(
        decide({ currentBurn: 0.1, offerPrice: 0.2, hours: 3, balance: 0.9 }),
      ).overridden,
    ).toEqual([]);
  });

  it("refuses a need above the balance by 0.01 with OVER_BALANCE, overridable", () => {
    const d = refused(decide({ ...hours4, balance: 5.99 }));
    expect(d.reason).toBe("OVER_BALANCE");
    expect(d.reasons).toEqual(["OVER_BALANCE"]);
    expect(d.overridable).toBe(true);
  });

  it("counts the current burn, not just the offer (offer alone 2.00 fits, account 6.00 does not)", () => {
    expect(
      allowed(decide({ ...hours4, currentBurn: 0, balance: 3 })).allow,
    ).toBe(true);
    expect(refused(decide({ ...hours4, balance: 3 })).reason).toBe(
      "OVER_BALANCE",
    );
  });

  it("accepts fractional hours", () => {
    expect(
      allowed(decide({ ...hours4, hours: 1.5, balance: 2.25 })).allow,
    ).toBe(true);
    expect(
      refused(decide({ ...hours4, hours: 1.5, balance: 2.24 })).reason,
    ).toBe("OVER_BALANCE");
  });

  it("E60: a zero or negative balance with a positive need trips OVER_BALANCE", () => {
    for (const balance of [0, -1.5]) {
      const d = refused(decide({ ...hours4, balance }));
      expect(d.reasons).toEqual(["OVER_BALANCE"]);
      expect(d.overridable).toBe(true);
    }
  });

  it("E60: --confirm overrides OVER_BALANCE and reports it", () => {
    expect(
      allowed(decide({ ...hours4, balance: 0, confirm: true })).overridden,
    ).toEqual(["OVER_BALANCE"]);
  });

  it("a free offer on an idle account needs 0 and fits a zero balance", () => {
    expect(
      allowed(decide({ currentBurn: 0, offerPrice: 0, hours: 4, balance: 0 }))
        .overridden,
    ).toEqual([]);
  });

  it("lists OVER_CAP, OVER_BURN and OVER_BALANCE together in that order", () => {
    const d = refused(
      decide({ currentBurn: 1.5, offerPrice: 1.8, hours: 2, balance: 1 }),
    );
    expect(d.reasons).toEqual(["OVER_CAP", "OVER_BURN", "OVER_BALANCE"]);
    expect(d.reason).toBe("OVER_CAP");
    expect(d.overridable).toBe(true);
  });

  it("--confirm overrides OVER_BALANCE and OVER_CAP together", () => {
    expect(
      allowed(
        decide({
          currentBurn: 0,
          offerPrice: 1.8,
          hours: 2,
          balance: 1,
          confirm: true,
        }),
      ).overridden,
    ).toEqual(["OVER_CAP", "OVER_BALANCE"]);
  });
});

describe("decision table, balance unknown with --hours (E59)", () => {
  const hours4: Partial<GuardInput> = { hours: 4 };

  it.each([null, undefined, Number.NaN, Infinity, -Infinity])(
    "E59: refuses an unreadable balance (%s) with BALANCE_UNKNOWN, not overridable",
    (balance) => {
      const d = refused(decide({ ...hours4, balance }));
      expect(d.reason).toBe("BALANCE_UNKNOWN");
      expect(d.reasons).toEqual(["BALANCE_UNKNOWN"]);
      expect(d.overridable).toBe(false);
    },
  );

  it("E59: --confirm does not override BALANCE_UNKNOWN", () => {
    const d = refused(decide({ ...hours4, balance: null, confirm: true }));
    expect(d.reason).toBe("BALANCE_UNKNOWN");
    expect(d.overridable).toBe(false);
  });

  it("E59: BALANCE_UNKNOWN beats the soft reasons and keeps them listed after it", () => {
    const d = refused(
      decide({
        ...hours4,
        balance: null,
        currentBurn: 1.5,
        offerPrice: 1.8,
        confirm: true,
      }),
    );
    expect(d.reasons).toEqual(["BALANCE_UNKNOWN", "OVER_CAP", "OVER_BURN"]);
    expect(d.reason).toBe("BALANCE_UNKNOWN");
    expect(d.overridable).toBe(false);
  });

  it("orders the hard reasons price, burn, balance, limits", () => {
    const d = refused(
      decide({
        ...hours4,
        offerPrice: null,
        currentBurn: null,
        balance: null,
        maxDph: 0,
      }),
    );
    expect(d.reasons).toEqual([
      "PRICE_UNKNOWN",
      "BURN_UNKNOWN",
      "BALANCE_UNKNOWN",
      "LIMITS_INVALID",
    ]);
  });

  it("never reports OVER_BALANCE on numbers it cannot trust", () => {
    const d = refused(decide({ ...hours4, balance: 0, currentBurn: null }));
    expect(d.reasons).toEqual(["BURN_UNKNOWN"]);
  });

  it.each([0, -1, Number.NaN, Infinity])(
    "fails closed on unusable hours (%s)",
    (hours) => {
      const d = refused(decide({ hours, balance: 100, confirm: true }));
      expect(d.reasons).toContain("LIMITS_INVALID");
      expect(d.overridable).toBe(false);
    },
  );
});

describe("decision table, CONTRACT_SHORT (rent --max-hours)", () => {
  const needs = 40_800;
  const contract = (leftSec: number | null | undefined) => ({
    contract: { leftSec, neededSec: needs },
  });

  it("E56: refuses a contract shorter than the run, overridable", () => {
    const d = refused(decide(contract(needs - 1)));
    expect(d.reasons).toEqual(["CONTRACT_SHORT"]);
    expect(d.overridable).toBe(true);
  });

  it("allows a contract exactly as long as the run (inclusive)", () => {
    expect(allowed(decide(contract(needs))).overridden).toEqual([]);
  });

  it.each([null, undefined, Number.NaN])(
    "an unknown contract length (%s) raises nothing",
    (left) => {
      expect(allowed(decide(contract(left))).overridden).toEqual([]);
    },
  );

  it("--confirm overrides it and reports it", () => {
    const d = allowed(decide({ ...contract(60), confirm: true }));
    expect(d.overridden).toEqual(["CONTRACT_SHORT"]);
  });

  it("is listed after the balance reason and stays soft next to hard reasons", () => {
    const soft = refused(
      decide({ ...contract(60), hours: 100, balance: 1, offerPrice: 0.5 }),
    );
    expect(soft.reasons).toEqual(["OVER_BALANCE", "CONTRACT_SHORT"]);
    const hard = refused(
      decide({ ...contract(60), offerPrice: null, confirm: true }),
    );
    expect(hard.reasons).toEqual(["PRICE_UNKNOWN", "CONTRACT_SHORT"]);
    expect(hard.overridable).toBe(false);
  });

  it("without a contract input the guard behaves as before", () => {
    expect(allowed(decide({})).overridden).toEqual([]);
  });
});
