import { AxiError } from "./errors.js";

function requireValue(value: string | undefined, flag: string): string {
  if (value === undefined || value === "" || value.startsWith("--")) {
    throw new AxiError(`${flag} requires a value`, "VALIDATION_ERROR");
  }
  return value;
}

/** Get a flag's value from `--flag value` or `--flag=value` and remove it from args. */
export function takeFlag(args: string[], flag: string): string | undefined {
  const equalsPrefix = `${flag}=`;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === flag) {
      const value = requireValue(args[i + 1], flag);
      args.splice(i, 2);
      return value;
    }
    if (arg.startsWith(equalsPrefix)) {
      const value = requireValue(arg.slice(equalsPrefix.length), flag);
      args.splice(i, 1);
      return value;
    }
  }
  return undefined;
}

/** Check if a boolean flag is present and remove it from args. */
export function takeBoolFlag(args: string[], flag: string): boolean {
  const idx = args.indexOf(flag);
  if (idx === -1) return false;
  args.splice(idx, 1);
  return true;
}

/** Like takeFlag, but parses a finite number; anything else is a VALIDATION_ERROR. */
export function takeNumberFlag(
  args: string[],
  flag: string,
  opts: { min?: number; integer?: boolean } = {},
): number | undefined {
  const raw = takeFlag(args, flag);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (
    !Number.isFinite(n) ||
    (opts.integer && !Number.isInteger(n)) ||
    n < (opts.min ?? -Infinity)
  ) {
    const kind = opts.integer ? "an integer" : "a number";
    const lower = opts.min !== undefined ? ` >= ${opts.min}` : "";
    throw new AxiError(
      `${flag} must be ${kind}${lower}, got "${raw}"`,
      "VALIDATION_ERROR",
    );
  }
  return n;
}

/** Remove and return the first non-flag argument; call after all flags are taken. */
export function takePositional(
  args: string[],
  label: string,
  usage?: string,
): string {
  const idx = args.findIndex((a) => !a.startsWith("-"));
  if (idx === -1) {
    throw new AxiError(
      `Missing <${label}>`,
      "VALIDATION_ERROR",
      usage ? [usage] : [],
    );
  }
  return args.splice(idx, 1)[0]!;
}

/**
 * Reject flags in `args` that are not in `known` (AXI principle 6: never drop
 * an unknown flag silently). Positionals and `--help`/`-h` always pass; `--`
 * ends scanning. Call it on the full args, before taking flags. The
 * VALIDATION_ERROR (exit 2) lists the valid flags so one turn fixes it.
 */
export function assertKnownFlags(
  args: string[],
  known: string[],
  command?: string,
): void {
  const knownSet = new Set(known);
  const unknown: string[] = [];
  for (const tok of args) {
    if (tok === "--") break;
    if (!tok.startsWith("-")) continue;
    const name = tok.split("=", 1)[0]!;
    if (name === "--help" || name === "-h" || knownSet.has(name)) continue;
    if (!unknown.includes(name)) unknown.push(name);
  }
  if (unknown.length === 0) return;
  const where = command ? ` for \`${command}\`` : "";
  const valid = known.length > 0 ? known.join(", ") : "(none)";
  throw new AxiError(
    `unknown flag${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}${where}`,
    "VALIDATION_ERROR",
    [
      `valid flags${command ? ` for ${command}` : ""}: ${valid} (--help always allowed)`,
      ...(command ? [`vast-axi ${command} --help`] : []),
    ],
  );
}
