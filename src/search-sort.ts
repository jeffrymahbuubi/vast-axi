// `search --sort` and `--precision`: flag parsing, the upstream `-o` order and
// the client-side ranking. Pure helpers; the command wires them in.
import { AxiError } from "./errors.js";
import { round } from "./format.js";
import {
  GPU_PRECISION_DATE,
  PRECISIONS,
  peakTflops,
  type Precision,
} from "./gpu-precision.js";

export const SORTS = ["price", "value", "flops"] as const;
export type SortMode = (typeof SORTS)[number];

export interface SortPlan {
  sort: SortMode;
  /** Set only when ranking by a datasheet precision (sort is then `value`). */
  precision?: Precision;
}

type Offer = Record<string, unknown>;
type Extras = Record<string, number | null>;

export interface Ranking {
  /** Every offer, best first for the chosen sort. */
  ranked: Offer[];
  /** Extra row fields per offer; empty for `--sort price`. */
  extras: Map<Offer, Extras>;
  /** Distinct gpu_name values with no table number (precision sort only). */
  unknownGpus: string[];
}

/** Number or null: upstream fields can be missing on odd offers. */
function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function oneDecimal(value: number | null): number | null {
  return value === null ? null : round(value, 1);
}

/**
 * Validate `--sort` / `--precision` (E85). A precision implies `--sort value`;
 * combining it with an explicit `--sort price|flops` is refused.
 */
export function planSort(
  sortRaw: string | undefined,
  precisionRaw: string | undefined,
): SortPlan {
  let sort: SortMode | undefined;
  if (sortRaw !== undefined) {
    const lower = sortRaw.toLowerCase();
    if (!(SORTS as readonly string[]).includes(lower)) {
      throw new AxiError(
        `--sort must be one of ${SORTS.join(", ")}, got "${sortRaw}"`,
        "VALIDATION_ERROR",
        ["Example: --sort value (best deep-learning performance per $/hr)"],
      );
    }
    sort = lower as SortMode;
  }
  if (precisionRaw === undefined) return { sort: sort ?? "price" };
  const precision = precisionRaw.toLowerCase();
  if (!(PRECISIONS as readonly string[]).includes(precision)) {
    throw new AxiError(
      `--precision must be one of ${PRECISIONS.join(", ")}, got "${precisionRaw}"`,
      "VALIDATION_ERROR",
      ["Example: --precision fp16 (datasheet FP16 tensor TFLOPS per $/hr)"],
    );
  }
  if (sort !== undefined && sort !== "value") {
    throw new AxiError(
      `--precision ranks by value, so it cannot be combined with --sort ${sort}`,
      "VALIDATION_ERROR",
      [
        `Use \`--sort value --precision ${precision}\`, or drop --sort (--precision implies it)`,
      ],
    );
  }
  return { sort: "value", precision: precision as Precision };
}

/** The argument after `-o` for the upstream `search offers` call. */
export function upstreamOrder(plan: SortPlan): string {
  if (plan.precision !== undefined) return "dph_total"; // ranked client-side
  if (plan.sort === "value") return "dlperf_per_dphtotal-";
  if (plan.sort === "flops") return "flops_per_dphtotal-";
  return "dph_total";
}

/** One line telling the agent what the ranking number means; null for `price`. */
export function valueBasis(plan: SortPlan): string | null {
  if (plan.precision !== undefined) {
    return `${plan.precision} dense peak TFLOPS from vendor datasheets (static table, ${GPU_PRECISION_DATE}) per $/hr`;
  }
  if (plan.sort === "value") {
    return "vast.ai dlperf score per $/hr (dlperf_per_dphtotal, vast.ai's own deep-learning benchmark)";
  }
  if (plan.sort === "flops") {
    return "vast.ai total_flops (about FP32 TFLOPS) per $/hr (flops_per_dphtotal)";
  }
  return null;
}

/** Best (largest) key first; offers without a key go last. Stable. */
function byKeyDescending(
  offers: Offer[],
  key: (offer: Offer) => number | null,
): Offer[] {
  const keyed = offers.map((offer, index) => ({
    offer,
    index,
    key: key(offer),
  }));
  keyed.sort((a, b) => {
    if (a.key === null && b.key === null) return a.index - b.index;
    if (a.key === null) return 1;
    if (b.key === null) return -1;
    return b.key - a.key || a.index - b.index;
  });
  return keyed.map((k) => k.offer);
}

/** TFLOPS per $/hr for a datasheet precision: table value x num_gpus / dph_total. */
function precisionValue(offer: Offer, precision: Precision): number | null {
  const peak = peakTflops(offer["gpu_name"], precision);
  const gpus = num(offer["num_gpus"]);
  const dph = num(offer["dph_total"]);
  if (peak === null || gpus === null || dph === null || dph <= 0) return null;
  return (peak * gpus) / dph;
}

/**
 * Rank every matching offer (the caller cuts to `--limit` afterwards) and work
 * out the extra row fields. `byPrice` is the price-sorted offer list, which is
 * also the tie-break order for equal values.
 */
export function rankOffers(byPrice: Offer[], plan: SortPlan): Ranking {
  const extras = new Map<Offer, Extras>();
  if (plan.sort === "price") {
    return { ranked: byPrice, extras, unknownGpus: [] };
  }

  if (plan.precision !== undefined) {
    const precision = plan.precision;
    const field = `tflops_${precision}`;
    const values = new Map<Offer, number | null>();
    const unknown = new Set<string>();
    for (const offer of byPrice) {
      const value = precisionValue(offer, precision);
      values.set(offer, value);
      const peak = peakTflops(offer["gpu_name"], precision);
      if (peak === null) {
        const name = offer["gpu_name"];
        unknown.add(typeof name === "string" ? name : "unknown");
      }
      const gpus = num(offer["num_gpus"]);
      extras.set(offer, {
        [field]: peak === null || gpus === null ? null : round(peak * gpus, 1),
        value: oneDecimal(value),
      });
    }
    const ranked = byKeyDescending(byPrice, (o) => values.get(o) ?? null);
    return { ranked, extras, unknownGpus: [...unknown] };
  }

  if (plan.sort === "value") {
    for (const offer of byPrice) {
      extras.set(offer, {
        dlperf: oneDecimal(num(offer["dlperf"])),
        value: oneDecimal(num(offer["dlperf_per_dphtotal"])),
      });
    }
    const ranked = byKeyDescending(byPrice, (o) =>
      num(o["dlperf_per_dphtotal"]),
    );
    return { ranked, extras, unknownGpus: [] };
  }

  for (const offer of byPrice) {
    extras.set(offer, {
      tflops: oneDecimal(num(offer["total_flops"])),
      tflops_per_usd: oneDecimal(num(offer["flops_per_dphtotal"])),
    });
  }
  const ranked = byKeyDescending(byPrice, (o) => num(o["flops_per_dphtotal"]));
  return { ranked, extras, unknownGpus: [] };
}

/** The help line naming GPUs the table cannot rank (E83); null when there are none. */
export function unknownGpuHint(
  unknownGpus: string[],
  precision: Precision,
): string | null {
  if (unknownGpus.length === 0) return null;
  const names = unknownGpus.slice(0, 5).join(", ");
  const more =
    unknownGpus.length > 5 ? ` and ${unknownGpus.length - 5} more` : "";
  return `${names}${more} have no datasheet ${precision} number in vast-axi's table; their value is null and they sort last`;
}
