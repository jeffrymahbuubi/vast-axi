// The spend-guard refusal text for `rent` (moved out of commands/rent.ts, F10).
import type { Config } from "./config.js";
import { isoMinute } from "./destroy-timer.js";
import type { DestroyPlan } from "./destroy-timer.js";
import { AxiError } from "./errors.js";
import type { BalanceReading } from "./estimate.js";
import { money, round } from "./format.js";
import type { GuardDecision, GuardReason } from "./spend-guard.js";

export interface BurnReading {
  /** Current burn in USD/hr; null when it could not be read (the guard then fails closed). */
  burn: number | null;
  /** Why the reading failed, for the refusal message. */
  failure?: string;
}

export const usd = (n: number): string => `$${money(n, 4)}/hr`;

/** Turn a refusal into the AxiError the agent sees. Soft refusals are VALIDATION_ERROR (exit 2). */
export function refusal(
  refused: Extract<GuardDecision, { allow: false }>,
  ctx: {
    offerId: number;
    price: number | null;
    burn: BurnReading;
    config: Config;
    hours?: number | undefined;
    balance: BalanceReading;
    /** `--max-hours` plan and the offer's contract left, for CONTRACT_SHORT. */
    timer?: { maxHours: number; plan: DestroyPlan; leftSec: number | null };
  },
): AxiError {
  const { offerId, price, burn, config, hours, balance, timer } = ctx;
  const has = (r: GuardReason): boolean => refused.reasons.includes(r);
  const limitsHint = `Change the limits with VAST_AXI_MAX_DPH / VAST_AXI_MAX_BURN or ${config.path}`;

  if (has("PRICE_UNKNOWN")) {
    return new AxiError(
      `Offer ${offerId} has no usable price, so the spend guard cannot check it (--confirm does not override this)`,
      "PRICE_UNKNOWN",
      ["Run `vast-axi search --limit 10` and pick another offer"],
    );
  }
  if (has("BURN_UNKNOWN")) {
    return new AxiError(
      `Cannot read current burn (${burn.failure ?? "unknown"}), so the spend guard refuses to rent (--confirm does not override this)`,
      "BURN_UNKNOWN",
      [
        "Retry `vast-axi rent` once the account can be read",
        "Run `vast-axi` to check account and instance state",
      ],
    );
  }
  if (has("BALANCE_UNKNOWN")) {
    return new AxiError(
      `Cannot read the account balance (${balance.failure ?? "unknown"}), so --hours cannot be checked against it and the spend guard refuses to rent (--confirm does not override this)`,
      "BALANCE_UNKNOWN",
      [
        "Retry `vast-axi rent` once the account can be read",
        "Run `vast-axi` to check account and instance state",
        "Or rent without --hours to apply only the per-hour limits",
      ],
    );
  }
  if (has("LIMITS_INVALID")) {
    return new AxiError(
      "The spend limits are not positive numbers, so the spend guard refuses to rent",
      "CONFIG_ERROR",
      [limitsHint],
    );
  }

  const parts: string[] = [];
  if (has("OVER_CAP") && price !== null) {
    parts.push(
      `offer ${offerId} costs ${usd(price)}, above the ${usd(config.maxDph)} per-instance cap`,
    );
  }
  if (has("OVER_BURN") && price !== null && burn.burn !== null) {
    parts.push(
      `current burn ${usd(burn.burn)} + ${usd(price)} = ${usd(burn.burn + price)} would exceed the ${usd(config.maxBurn)} burn ceiling`,
    );
  }
  const overBalance =
    has("OVER_BALANCE") &&
    price !== null &&
    burn.burn !== null &&
    balance.balance !== null &&
    hours !== undefined;
  if (overBalance) {
    parts.push(
      `${hours} h x (burn ${usd(burn.burn!)} + offer ${usd(price)}) = $${money((burn.burn! + price) * hours, 2)}, above the $${money(balance.balance!, 2)} balance`,
    );
  }
  const contractShort =
    has("CONTRACT_SHORT") && timer !== undefined && timer.leftSec !== null;
  if (contractShort) {
    parts.push(
      `offer ${offerId}'s rental contract has ${round(timer.leftSec! / 3600, 1)} h left, but --max-hours ${timer.maxHours} destroys at ${isoMinute(timer.plan.destroyAt)} (${timer.plan.runsForH} h from now); vast.ai stops the instance when the contract ends`,
    );
  }
  const suggestions = [
    `Rerun with --confirm to rent anyway: vast-axi rent ${offerId} ... --confirm`,
  ];
  if (contractShort) {
    suggestions.push(
      "Lower --max-hours, or pick an offer with a longer contract: `vast-axi search --hours <n>` hides offers whose contract ends sooner",
    );
  }
  if (overBalance) {
    suggestions.push(
      "Lower --hours, or stop instances you no longer need (`vast-axi status`)",
      "Or add credit to the vast.ai account",
    );
  }
  if (has("OVER_CAP") || has("OVER_BURN")) {
    suggestions.push(
      "Or pick a cheaper offer: `vast-axi search --max-dph " +
        `${config.maxDph}\``,
      limitsHint,
    );
  }
  return new AxiError(
    `Spend guard refused: ${parts.join("; ")}`,
    "VALIDATION_ERROR",
    suggestions,
  );
}
