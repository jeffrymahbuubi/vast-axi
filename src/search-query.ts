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
  if (raw) terms.push(raw);
  return terms.join(" ");
}
