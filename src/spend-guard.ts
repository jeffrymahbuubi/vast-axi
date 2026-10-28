/**
 * The rent spend guard (R8, R15, OQ3a, OQ12a): a pure decision function, no
 * I/O, so the whole decision table can be tested row by row.
 *
 * Reasons come in two classes:
 *   - hard: the guard cannot judge the spend (unknown price, unknown burn,
 *     unknown balance, unusable limits). Nothing overrides these, `--confirm`
 *     included, because "confirm" means "I accept the number I was shown" and
 *     there is no number.
 *   - soft: a limit was exceeded (per-instance cap, aggregate burn ceiling,
 *     account balance over the requested hours). `--confirm` overrides these.
 *
 * Decision table (all applicable reasons are listed, in this precedence order):
 *
 *   price missing / not finite / negative      refuse  PRICE_UNKNOWN    (hard)
 *   burn lookup failed (burn === null)         refuse  BURN_UNKNOWN     (hard)
 *   hours given, balance not a finite number   refuse  BALANCE_UNKNOWN  (hard)
 *   maxDph or maxBurn not a positive number    refuse  LIMITS_INVALID   (hard)
 *   hours given but not a positive number      refuse  LIMITS_INVALID   (hard)
 *   price > maxDph                             refuse  OVER_CAP         (soft)
 *   burn + price > maxBurn                     refuse  OVER_BURN        (soft)
 *   hours given, (burn + price) x hours
 *     > balance                                refuse  OVER_BALANCE     (soft)
 *   contract given, offer contract left
 *     < time until the destroy hour            refuse  CONTRACT_SHORT   (soft)
 *   any soft reason and --confirm              allow   (reasons reported as overridden)
 *   no reason                                  allow
 *
 * CONTRACT_SHORT only applies to `rent --max-hours` (the caller passes `contract`):
 * vast.ai stops the instance when the offer's rental contract ends, so a contract
 * shorter than the planned run defeats the destroy timer. An unknown contract
 * length (`leftSec` null) raises nothing.
 *
 * Without `hours` the balance is ignored entirely: no balance reason can
 * arise and the caller need not read the balance. All limits are inclusive: a
 * price exactly at the cap, a sum exactly at the ceiling, or a need exactly at
 * the balance is allowed.
 */

export type GuardReason =
  | "PRICE_UNKNOWN"
  | "BURN_UNKNOWN"
  | "BALANCE_UNKNOWN"
  | "LIMITS_INVALID"
  | "OVER_CAP"
  | "OVER_BURN"
  | "OVER_BALANCE"
  | "CONTRACT_SHORT";

const HARD_REASONS: readonly GuardReason[] = [
  "PRICE_UNKNOWN",
  "BURN_UNKNOWN",
  "BALANCE_UNKNOWN",
  "LIMITS_INVALID",
];

/** Float noise allowance for the burn sum only (0.1 + 0.2 must not refuse a sum meant to equal 0.3). */
const SUM_EPSILON = 1e-9;

export interface GuardInput {
  /** `dph_total` of the offer in USD/hr; null/undefined when the lookup gave none. */
  offerPrice: number | null | undefined;
  /** Current account burn in USD/hr; null when the `show instances` lookup failed (fails closed). */
  currentBurn: number | null | undefined;
  /** Per-instance cap in USD/hr (inclusive). */
  maxDph: number;
  /** Aggregate burn ceiling in USD/hr (inclusive). */
  maxBurn: number;
  /** `--confirm` was passed. */
  confirm: boolean;
  /** Rental window in hours (`--hours`); when set, the balance is checked too. */
  hours?: number | undefined;
  /** Account balance in USD; null/undefined when it could not be read. Only used with `hours`. */
  balance?: number | null | undefined;
  /** `rent --max-hours` only: seconds of contract left on the offer vs seconds until the destroy hour. */
  contract?:
    { leftSec: number | null | undefined; neededSec: number } | undefined;
}

export type GuardDecision =
  | {
      allow: true;
      /** Soft reasons that `--confirm` overrode; empty when nothing tripped. */
      overridden: GuardReason[];
    }
  | {
      allow: false;
      /** First reason by precedence (hard before soft, cap before burn before balance). */
      reason: GuardReason;
      /** Every reason that applied, so one message can name all of them. */
      reasons: GuardReason[];
      /** True when `--confirm` could have overridden every reason (soft only). */
      overridable: boolean;
    };

function isMoney(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

function isFiniteNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function isLimit(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/** Decide whether `rent` may create the instance. Pure; never throws. */
export function decideSpend(input: GuardInput): GuardDecision {
  const {
    offerPrice,
    currentBurn,
    maxDph,
    maxBurn,
    confirm,
    hours,
    balance,
    contract,
  } = input;
  const checkBalance = hours !== undefined;
  const reasons: GuardReason[] = [];

  if (!isMoney(offerPrice)) reasons.push("PRICE_UNKNOWN");
  if (!isMoney(currentBurn)) reasons.push("BURN_UNKNOWN");
  if (checkBalance && !isFiniteNumber(balance)) {
    reasons.push("BALANCE_UNKNOWN");
  }
  if (
    !isLimit(maxDph) ||
    !isLimit(maxBurn) ||
    (checkBalance && !isLimit(hours))
  ) {
    reasons.push("LIMITS_INVALID");
  }

  // Soft limits are only evaluated on numbers we trust.
  if (isMoney(offerPrice) && isLimit(maxDph) && offerPrice > maxDph) {
    reasons.push("OVER_CAP");
  }
  if (
    isMoney(offerPrice) &&
    isMoney(currentBurn) &&
    isLimit(maxBurn) &&
    currentBurn + offerPrice > maxBurn + SUM_EPSILON
  ) {
    reasons.push("OVER_BURN");
  }
  // A balance of 0 or less with a positive need trips this naturally (E60).
  if (
    checkBalance &&
    isLimit(hours) &&
    isFiniteNumber(balance) &&
    isMoney(offerPrice) &&
    isMoney(currentBurn) &&
    (currentBurn + offerPrice) * hours > balance + SUM_EPSILON
  ) {
    reasons.push("OVER_BALANCE");
  }
  if (
    contract &&
    isFiniteNumber(contract.leftSec) &&
    isFiniteNumber(contract.neededSec) &&
    contract.leftSec < contract.neededSec
  ) {
    reasons.push("CONTRACT_SHORT");
  }

  if (reasons.length === 0) return { allow: true, overridden: [] };

  const overridable = reasons.every((r) => !HARD_REASONS.includes(r));
  if (overridable && confirm) return { allow: true, overridden: reasons };
  return { allow: false, reason: reasons[0]!, reasons, overridable };
}
