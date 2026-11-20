import { AxiError } from "./errors.js";

/** Filters `search` accepts; each maps to one term of the vastai query string. */
export interface SearchFilters {
  /** GPU model, for example `RTX_4090` (spaces become underscores). */
  gpu?: string;
  /** Minimum per-GPU memory in GB (vastai queries `gpu_ram` in GB). */
  minVram?: number;
  maxDph?: number;
  numGpus?: number;
  /** Raw vastai query, appended verbatim after the generated terms. */
  query?: string;
  /**
   * Hide offers whose rental contract ends within this many hours. Becomes a
   * `duration>=` term (vastai queries `duration` in days); ignored when the
   * raw query sets `duration` itself.
   */
  minHours?: number;
  /** Minimum NVIDIA driver, already normalised to X.X.X (`--min-driver`). */
  minDriver?: string;
  /** Minimum CUDA version the host supports (`--min-cuda`). */
  minCuda?: string;
}

/** Safe defaults (R7): only offers that can be rented now, on verified hosts. */
const DEFAULT_TERMS: Array<[field: string, term: string]> = [
  ["rentable", "rentable=true"],
  ["verified", "verified=true"],
];

/** Model names are words, digits and a few separators; anything else would corrupt the query. */
const GPU_NAME = /^[\w.+-]+$/;

/** Normalise a `--gpu` value (`RTX 4090` -> `RTX_4090`) or reject it. */
export function normalizeGpu(value: string): string {
  const name = value.trim().replace(/\s+/g, "_");
  if (!GPU_NAME.test(name)) {
    throw new AxiError(
      `--gpu must be a GPU model name such as RTX_4090, got "${value}"`,
      "VALIDATION_ERROR",
      [
        "Use --query for anything more complex, for example --query 'gpu_name=RTX_4090'",
      ],
    );
  }
  return name;
}

/** Does a raw vastai query already constrain `field`? Then the default for it is dropped. */
function constrains(query: string, field: string): boolean {
  return new RegExp(`(^|\\s)${field}\\s*(=|!=|<|>|in\\b|notin\\b)`).test(query);
}

/** Does a raw vastai query already constrain the offer's remaining contract length? */
export function setsDuration(query: string | undefined): boolean {
  return constrains(query ?? "", "duration");
}

/**
 * Hours as the day value of a `duration>=` query term, rounded UP to 6
 * decimals (so no offer shorter than `hours` slips through) and without float
 * noise: 12 -> "0.5", 1 -> "0.041667". The tiny epsilon keeps values like
 * 7.2h/24 = 0.3 from rounding up to 0.300001.
 */
export function durationDays(hours: number): string {
  const micro = Math.ceil((hours / 24) * 1e6 - 1e-6);
  return String(Number((Math.max(micro, 1) / 1e6).toFixed(6)));
}

/**
 * Build the positional `search offers` query from flags, for example
 * `gpu_name=RTX_4090 dph_total<=0.5 rentable=true verified=true`. A raw
 * `--query` goes last and verbatim; it replaces a default it sets itself
 * (`--query verified=false` drops `verified=true`) instead of contradicting it.
 */
export function buildQuery(filters: SearchFilters): string {
  const raw = filters.query?.trim() ?? "";
  const terms: string[] = [];
  if (filters.gpu !== undefined) {
    terms.push(`gpu_name=${normalizeGpu(filters.gpu)}`);
  }
  if (filters.numGpus !== undefined) terms.push(`num_gpus=${filters.numGpus}`);
  if (filters.minVram !== undefined) terms.push(`gpu_ram>=${filters.minVram}`);
  if (filters.maxDph !== undefined) terms.push(`dph_total<=${filters.maxDph}`);
  if (filters.minHours !== undefined && !setsDuration(raw)) {
    terms.push(`duration>=${durationDays(filters.minHours)}`);
  }
  for (const [field, term] of DEFAULT_TERMS) {
    if (!constrains(raw, field)) terms.push(term);
  }
  if (filters.minDriver !== undefined) {
    terms.push(`driver_version>=${filters.minDriver}`);
  }
  if (filters.minCuda !== undefined) {
    terms.push(`cuda_max_good>=${filters.minCuda}`);
  }
  if (raw) terms.push(raw);
  return terms.join(" ");
}

/** `--min-driver 555` / `535.86` / `535.86.05` -> `555.0.0` / `535.86.0` / `535.86.05` (vastai needs X.X.X). */
export function normalizeDriver(value: string): string {
  const v = value.trim();
  if (!/^\d{1,3}(\.\d{1,3}){0,2}$/.test(v)) {
    throw new AxiError(
      `--min-driver must be 1 to 3 dot-separated numbers of up to 3 digits, such as 555 or 535.86.05, got "${value}"`,
      "VALIDATION_ERROR",
      ["Example: --min-driver 555 (the query gets driver_version>=555.0.0)"],
    );
  }
  const parts = v.split(".");
  while (parts.length < 3) parts.push("0");
  return parts.join(".");
}

/** Validate `--min-cuda` (`12` or `12.5`). */
export function normalizeCuda(value: string): string {
  const v = value.trim();
  if (!/^\d+(\.\d+)?$/.test(v)) {
    throw new AxiError(
      `--min-cuda must be a number such as 12.5, got "${value}"`,
      "VALIDATION_ERROR",
      ["Example: --min-cuda 12.5 (the query gets cuda_max_good>=12.5)"],
    );
  }
  return v;
}

/** Does the raw query mention `field` with an operator? */
export function mentions(query: string | undefined, field: string): boolean {
  return constrains(query ?? "", field);
}

/** Does the raw query constrain the CUDA version (`cuda_max_good` or `cuda_vers`)? */
export function mentionsCuda(query: string | undefined): boolean {
  return mentions(query, "cuda_max_good") || mentions(query, "cuda_vers");
}

const DRIVER_TERM = /(^|\s)driver_version\s*(>=|<=|!=|=|<|>)\s*(\S+)/g;

/**
 * Refuse a raw `driver_version` term vastai would mangle (V8): a value with a
 * dot needs three parts, and one without a dot is an upstream HTTP 400.
 */
export function checkDriverQuery(query: string | undefined): void {
  for (const m of (query ?? "").matchAll(DRIVER_TERM)) {
    const value = (m[3] ?? "").replace(/^['"]|['"]$/g, "");
    if (!/^\d+\.\d+\.\d+$/.test(value)) {
      throw new AxiError(
        `driver_version needs X.X.X, for example driver_version>=555.0.0; or use --min-driver 555 (got "${m[2]}${value}")`,
        "VALIDATION_ERROR",
        [
          "Use --min-driver 555 instead of a raw driver_version term",
          "Or write the value with three parts: --query 'driver_version>=555.0.0'",
        ],
      );
    }
  }
}

/** The error line vastai prints on stdout for a query it cannot parse, or undefined. */
export function upstreamQueryError(output: string): string | undefined {
  const known =
    /Did you forget to quote your query|Unconsumed text|Unknown operator|Invalid version string/;
  const line = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => known.test(l));
  return line?.replace(/^Error:\s*/, "");
}
