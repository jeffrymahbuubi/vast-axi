/** Round to `digits` decimals (returns a number so TOON prints it unquoted). */
export function round(n: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

/** USD amount as a number rounded to cents (pass `digits` for per-hour prices). */
export function money(n: number, digits = 2): number {
  return round(n, digits);
}

/** An hourly price at 4 decimals (vast.ai bills fractions of a cent per hour); null when upstream gave none. */
export function pricePerHr(n: number | null | undefined): number | null {
  return typeof n === "number" ? money(n, 4) : null;
}

/** vast.ai reports `gpu_ram` in MB; the user thinks in GB. */
export function gpuRamGb(mb: number): number {
  return Math.round(mb / 1024);
}

/**
 * Cut `text` to `max` characters and append `[+N chars]` so the agent knows
 * how much it is missing. Text within the limit is returned as is.
 */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}[+${text.length - max} chars]`;
}

/** Human size for hints: `512 B`, `3.4 KB`, `10.0 MB`. */
export function byteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Compact duration: `45s`, `12m`, `2h05m`, `3d04h`. */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${String(m % 60).padStart(2, "0")}m`;
  const d = Math.floor(h / 24);
  return `${d}d${String(h % 24).padStart(2, "0")}h`;
}

/** Age in hours (one decimal) of an upstream `start_date` (epoch seconds). */
export function ageHours(startDate: number, nowMs = Date.now()): number {
  return round((nowMs / 1000 - startDate) / 3600, 1);
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Project `item` onto `keys`, keeping key order and filling gaps with null. */
export function pickFields(
  item: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) out[key] = item[key] ?? null;
  return out;
}
