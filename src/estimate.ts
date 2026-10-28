// Shared cost-estimate helpers for `search --hours` and `rent --hours` (Phase 2).
// `--hours` is parsed once here, so a later `--max-hours` flag can feed the
// same value into the same code paths.
import { takeFlag } from "./args.js";
import { AxiError } from "./errors.js";
import { money, round } from "./format.js";
import { vastJson } from "./vastai.js";

/** Longest estimate window: 30 days. */
export const MAX_HOURS = 720;

/**
 * Take `<flag> N` (default `--hours`): a number > 0 and <= 720 (fractions are
 * fine). Anything else, including a missing value, is a VALIDATION_ERROR (E55).
 * With `opts.min` the range is `min <= N <= 720` instead (`--max-hours`, E70).
 */
export function takeHoursFlag(
  args: string[],
  flag = "--hours",
  opts: { min?: number } = {},
): number | undefined {
  const raw = takeFlag(args, flag);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  const min = opts.min;
  const tooLow = min === undefined ? n <= 0 : n < min;
  if (!Number.isFinite(n) || tooLow || n > MAX_HOURS) {
    const range =
      min === undefined
        ? `greater than 0 and at most ${MAX_HOURS}`
        : `from ${min} to ${MAX_HOURS}`;
    throw new AxiError(
      `${flag} must be a number ${range}, got "${raw}"`,
      "VALIDATION_ERROR",
      [
        min === undefined
          ? `Example: ${flag} 4 (an estimate for 4 hours of rental)`
          : `Example: ${flag} 12 (destroy the instance after at most 12 hours)`,
      ],
    );
  }
  return n;
}

export interface BalanceReading {
  /** Account balance in USD; null when it could not be read as a finite number. */
  balance: number | null;
  /** Why the reading failed, for messages. */
  failure?: string;
}

/** One `show user` call. Never throws: a failed read is `balance: null`. */
export async function readBalance(): Promise<BalanceReading> {
  try {
    const user = await vastJson<unknown>(["show", "user"]);
    const row =
      typeof user === "object" && user !== null && !Array.isArray(user)
        ? (user as Record<string, unknown>)
        : undefined;
    // Same source as the dashboard: credit, else balance.
    const raw = row ? (row["credit"] ?? row["balance"]) : undefined;
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      return { balance: null, failure: "no numeric balance in show user" };
    }
    return { balance: raw };
  } catch (error) {
    const failure =
      error instanceof AxiError
        ? `${error.code}: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
    return { balance: null, failure };
  }
}

/** USD for `hours` at `perHour`, rounded to cents. */
export function costFor(perHour: number, hours: number): number {
  return money(perHour * hours, 2);
}

/** `amount` as a percentage of `balance`, 1 decimal; null unless the balance is a positive number. */
export function pctOfBalance(
  amount: number,
  balance: number | null | undefined,
): number | null {
  if (
    typeof balance !== "number" ||
    !Number.isFinite(balance) ||
    balance <= 0
  ) {
    return null;
  }
  return round((amount / balance) * 100, 1);
}
