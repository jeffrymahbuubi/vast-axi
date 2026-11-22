import {
  assertKnownFlags,
  takeBoolFlag,
  takeFlag,
  takeNumberFlag,
} from "../args.js";
import { AxiError } from "../errors.js";
import {
  DEFAULT_DISK_GB,
  costFor,
  pctOfBalance,
  readBalance,
  takeHoursFlag,
} from "../estimate.js";
import { gpuRamGb, median, money, pickFields, round } from "../format.js";
import { buildHelp } from "../help.js";
import {
  buildQuery,
  checkDriverQuery,
  durationDays,
  effectiveCap,
  mentions,
  mentionsCuda,
  normalizeCuda,
  normalizeDriver,
  setsDuration,
  upstreamQueryError,
  type SearchFilters,
} from "../search-query.js";
import {
  planSort,
  rankOffers,
  unknownGpuHint,
  upstreamOrder,
  valueBasis,
} from "../search-sort.js";
import { emptyState } from "../toon.js";
import { spawnRunner, vastJson, type VastRunner } from "../vastai.js";
import type { VastCommand } from "./types.js";

const FLAGS = [
  "--disk",
  "--min-driver",
  "--min-cuda",
  "--gpu",
  "--min-vram",
  "--max-dph",
  "--num-gpus",
  "--limit",
  "--query",
  "--full",
  "--hours",
  "--sort",
  "--precision",
];

/** Rows shown when `--limit` is not given. */
const DEFAULT_LIMIT = 10;

/** KTD4: the default row schema, in output order. */
const ROW_FIELDS = [
  "id",
  "gpu_name",
  "num_gpus",
  "gpu_ram_gb",
  "dph_total",
  "reliability2",
  "geolocation",
];

type Offer = Record<string, unknown>;

export const help = buildHelp({
  usage: "vast-axi search [flags]",
  summary:
    "Find rentable GPU offers, cheapest first (or by --sort), with count and price aggregates.",
  flags: [
    "--gpu <name>      GPU model, for example RTX_4090 (spaces become _)",
    "--min-vram <gb>   minimum memory per GPU in GB",
    "--max-dph <usd>   maximum price in USD per hour",
    "--num-gpus <n>    exact GPU count",
    `--limit <n>       rows to show (default ${DEFAULT_LIMIT}); aggregates always cover every match`,
    `--disk <gb>       price offers for this disk size in GB (default ${DEFAULT_DISK_GB}, the same as rent); offers above --max-dph at that size are dropped`,
    "--min-driver <v>  minimum NVIDIA driver, for example 555 or 535.86 (padded to X.X.X); adds a driver column",
    "--min-cuda <v>    minimum CUDA version the host supports, for example 12.5 (cuda_max_good); adds a cuda column",
    "--query <q>       raw vastai query, appended verbatim (for example 'cuda_max_good>=12.4'); driver_version needs X.X.X",
    "--full            all upstream fields per offer (large)",
    "--hours <n>       estimate the cost of n hours (> 0, at most 720): adds max_h, est_cost and pct_balance per offer; hides offers whose contract ends sooner",
    "--sort <s>        price (default, cheapest first) | value (vast.ai dlperf per $/hr) | flops (vast.ai total_flops per $/hr); ranks every match, then --limit cuts",
    "--precision <p>   fp32 | tf32 | fp16: rank by datasheet peak TFLOPS (x num_gpus) per $/hr from a static vendor table; implies --sort value",
  ],
  notes: [
    "upper price bounds in --query (dph_total<X, dph<=X) are re-checked after repricing for --disk, like --max-dph; the tightest applies",
    "default filter: rentable=true verified=true; a --query that sets either field replaces that default",
    "gpu_ram_gb is GB; dph_total is USD per hour, priced for priced_for_disk_gb (storage is part of the price, so it matches what `rent --disk` charges)",
    "with --hours: est_cost = dph_total x n (USD), pct_balance = est_cost as a percent of your balance (one extra `show user` call)",
    "with --hours N, offers whose rental contract ends within N hours are hidden (vast.ai stops an instance at contract end); max_h = hours of contract left",
    "if the balance cannot be read, pct_balance is null and the rows still carry est_cost; search never refuses on cost",
    "--sort value adds dlperf and value; --sort flops adds tflops and tflops_per_usd; offers missing the field sort last with null; count, min_dph and median_dph stay price-based",
    "--precision adds tflops_<p> (table value x num_gpus) and value (TFLOPS per $/hr). The table holds dense peak vendor numbers, not measurements; a GPU not in it, or without that precision, gets value null and sorts last",
    "--precision cannot be combined with --sort price or --sort flops (exit 2)",
  ],
  examples: [
    "vast-axi search --gpu RTX_4090 --max-dph 0.5 --limit 5",
    "vast-axi search --min-vram 48 --num-gpus 2",
    "vast-axi search --query 'verified=false dph_total<0.3'",
    "vast-axi search --gpu RTX_4090 --hours 8",
    "vast-axi search --disk 50 --min-driver 555 --min-cuda 12.5",
    "vast-axi search --sort value --limit 5",
    "vast-axi search --precision fp16 --max-dph 2 --limit 5",
  ],
});

/** Quote an argument for the echoed `help[]` command lines. */
function shellArg(arg: string): string {
  return /^[\w.,:=/+@%-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`;
}

/** Number or null: upstream fields can be missing on odd offers. */
function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The `--hours` fields for one offer: est_cost in USD and its share of the balance. */
function estimateFields(
  offer: Offer,
  hours: number,
  balance: number | null,
): { est_cost: number | null; pct_balance: number | null } {
  const dph = num(offer["dph_total"]);
  if (dph === null) return { est_cost: null, pct_balance: null };
  return {
    est_cost: costFor(dph, hours),
    pct_balance: pctOfBalance(dph * hours, balance),
  };
}

/** Hours of rental contract left (upstream `duration` is in seconds), 1 decimal; null when missing. */
function maxHours(offer: Offer): number | null {
  const seconds = num(offer["duration"]);
  return seconds === null ? null : round(seconds / 3600, 1);
}

/** Insert `max_h` right after `dph_total` in a default row. */
function withMaxH(
  row: Record<string, unknown>,
  maxH: number | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = value;
    if (key === "dph_total") out["max_h"] = maxH;
  }
  return out;
}

/** Extra columns that only appear when the search filters on driver or CUDA (E153). */
interface Columns {
  driver: boolean;
  cuda: boolean;
}

function toRow(offer: Offer, columns: Columns): Record<string, unknown> {
  const row = pickFields(offer, ROW_FIELDS);
  if (columns.driver) row["driver"] = offer["driver_version"] ?? null;
  if (columns.cuda) row["cuda"] = offer["cuda_max_good"] ?? null;
  const ram = num(offer["gpu_ram"]);
  row["gpu_ram_gb"] = ram === null ? null : gpuRamGb(ram);
  const dph = num(offer["dph_total"]);
  row["dph_total"] = dph === null ? null : money(dph, 3);
  const reliability = num(offer["reliability2"]);
  row["reliability2"] = reliability === null ? null : round(reliability, 3);
  return row;
}

/** Ways to loosen a search that matched nothing, based on the filters that were set. */
function relaxHints(filters: SearchFilters): string[] {
  const hints: string[] = [];
  if (filters.minHours !== undefined && !setsDuration(filters.query)) {
    hints.push(
      `Offers whose contract ends within ${filters.minHours} h are hidden; lower --hours or drop it`,
    );
  }
  if (filters.maxDph !== undefined) {
    hints.push(`Raise --max-dph (now ${filters.maxDph})`);
  }
  if (filters.minVram !== undefined) {
    hints.push(`Lower --min-vram (now ${filters.minVram})`);
  }
  if (filters.numGpus !== undefined) {
    hints.push(`Try a different --num-gpus (now ${filters.numGpus})`);
  }
  if (filters.gpu !== undefined) {
    hints.push(
      "Try another --gpu name (underscores, e.g. RTX_4090) or drop it",
    );
  }
  if (filters.query !== undefined) hints.push("Loosen or drop --query");
  if (!/verified/.test(filters.query ?? "")) {
    hints.push(
      "Include unverified hosts with --query verified=false (default filter is verified=true)",
    );
  }
  hints.push("Run `vast-axi search` with no filters to see what is listed");
  return hints;
}

export const command: VastCommand = async (args) => {
  assertKnownFlags(args, FLAGS, "search");
  const echoed = [...args];
  const rest = [...args];
  const full = takeBoolFlag(rest, "--full");
  const filters: SearchFilters = {};
  const gpu = takeFlag(rest, "--gpu");
  if (gpu !== undefined) filters.gpu = gpu;
  const minVram = takeNumberFlag(rest, "--min-vram", { min: 0 });
  if (minVram !== undefined) filters.minVram = minVram;
  const maxDph = takeNumberFlag(rest, "--max-dph", { min: 0 });
  if (maxDph !== undefined) filters.maxDph = maxDph;
  const numGpus = takeNumberFlag(rest, "--num-gpus", {
    min: 1,
    integer: true,
  });
  if (numGpus !== undefined) filters.numGpus = numGpus;
  const limit =
    takeNumberFlag(rest, "--limit", { min: 1, integer: true }) ?? DEFAULT_LIMIT;
  const query = takeFlag(rest, "--query");
  if (query !== undefined) filters.query = query;
  const hours = takeHoursFlag(rest, "--hours");
  if (hours !== undefined) filters.minHours = hours;
  const diskFlag = takeNumberFlag(rest, "--disk", { min: 1 });
  const disk = diskFlag ?? DEFAULT_DISK_GB;
  const minDriver = takeFlag(rest, "--min-driver");
  if (minDriver !== undefined) {
    filters.minDriver = normalizeDriver(minDriver);
    if (mentions(query, "driver_version")) {
      throw new AxiError(
        "--min-driver and a driver_version term in --query set the same field",
        "VALIDATION_ERROR",
        ["Use one of them"],
      );
    }
  }
  const minCuda = takeFlag(rest, "--min-cuda");
  if (minCuda !== undefined) {
    filters.minCuda = normalizeCuda(minCuda);
    if (mentions(query, "cuda_max_good")) {
      throw new AxiError(
        "--min-cuda and a cuda_max_good term in --query set the same field",
        "VALIDATION_ERROR",
        ["Use one of them"],
      );
    }
  }
  checkDriverQuery(query);
  const columns: Columns = {
    driver: minDriver !== undefined || mentions(query, "driver_version"),
    cuda: minCuda !== undefined || mentionsCuda(query),
  };
  const plan = planSort(
    takeFlag(rest, "--sort"),
    takeFlag(rest, "--precision"),
  );
  if (rest.length > 0) {
    throw new AxiError(
      `unexpected argument${rest.length > 1 ? "s" : ""} ${rest.join(" ")} for \`search\``,
      "VALIDATION_ERROR",
      ["Filter with flags, for example `vast-axi search --gpu RTX_4090`"],
    );
  }

  const built = buildQuery(filters);
  // Keep what vastai printed: its query errors arrive as text on stdout (E154).
  let printed = "";
  const capture: VastRunner = async (argv, opts) => {
    const result = await spawnRunner(argv, opts);
    if (argv.includes("offers")) printed = result.stdout;
    return result;
  };
  let body: unknown;
  try {
    body = await vastJson<unknown>(
      [
        "search",
        "offers",
        built,
        "-o",
        upstreamOrder(plan),
        "--storage",
        String(disk),
      ],
      { runner: capture },
    );
  } catch (error) {
    const line = upstreamQueryError(printed);
    if (line === undefined) throw error;
    throw new AxiError(
      `vastai could not parse the query: ${line}`,
      "VALIDATION_ERROR",
      [
        `The query was: ${built}`,
        "Quote --query as one argument, and write driver_version as X.X.X",
      ],
    );
  }
  if (!Array.isArray(body)) {
    throw new AxiError(
      "Unexpected `search offers` output: expected a JSON array of offers",
      "UPSTREAM_PARSE_ERROR",
      ["Run `vast-axi raw search offers` to inspect the unparsed output"],
    );
  }
  // --storage reprices dph_total after the server filtered on the base price (V7).
  const listed = body as Offer[];
  const cap = effectiveCap(maxDph, query);
  const offers =
    cap === undefined
      ? listed
      : listed.filter((o) => {
          const dph = num(o["dph_total"]);
          return dph === null || (cap.strict ? dph < cap.max : dph <= cap.max);
        });

  if (offers.length === 0) {
    const dropped = listed.length > 0;
    return {
      ...emptyState(
        "offers",
        "0 matching offers",
        dropped
          ? [
              cap?.fromQuery
                ? `Every match is above the --query price cap (dph_total${cap.strict ? "<" : "<="}${cap.max}) once priced for ${disk} GB; raise the cap in --query or lower --disk`
                : `Every match is above --max-dph once priced for ${disk} GB; raise --max-dph (now ${maxDph}) or lower --disk`,
              ...relaxHints(filters),
            ]
          : relaxHints(filters),
      ),
      priced_for_disk_gb: disk,
      query: built,
    };
  }

  // Cheapest first; the sort is stable, so equal prices keep upstream order.
  const byPrice = (offers as Offer[])
    .slice()
    .sort(
      (a, b) =>
        (num(a["dph_total"]) ?? Infinity) - (num(b["dph_total"]) ?? Infinity),
    );
  const prices = byPrice
    .map((o) => num(o["dph_total"]))
    .filter((p): p is number => p !== null);
  const cheapest = byPrice[0]!;
  // --sort value|flops and --precision rank every match, then --limit cuts.
  const { ranked, extras, unknownGpus } = rankOffers(byPrice, plan);
  const sorted = ranked;
  const shown = sorted.slice(0, limit);
  const best = sorted[0]!;

  // One extra call, only with --hours; a failed read leaves pct_balance null.
  const reading = hours !== undefined ? await readBalance() : undefined;
  const balance =
    reading?.balance !== undefined &&
    reading.balance !== null &&
    reading.balance > 0
      ? reading.balance
      : null;
  // The estimate uses the raw upstream price, not the rounded one shown in the row.
  const toOutput = (offer: Offer): Offer => {
    const extra = extras.get(offer) ?? {};
    if (hours === undefined) {
      return { ...(full ? offer : toRow(offer, columns)), ...extra };
    }
    const maxH = maxHours(offer);
    const row = full
      ? { ...offer, max_h: maxH }
      : withMaxH(toRow(offer, columns), maxH);
    return { ...row, ...extra, ...estimateFields(offer, hours, balance) };
  };

  const basis = valueBasis(plan);
  const rentTarget = plan.sort === "price" ? cheapest : best;
  const hints = [
    `Rent the ${plan.sort === "price" ? "cheapest" : "best value"}: \`vast-axi rent ${String(rentTarget["id"])} --image <image>${diskFlag !== undefined ? ` --disk ${diskFlag}` : ""}${hours !== undefined ? ` --hours ${hours}` : ""}\``,
  ];
  const unknownHint =
    plan.precision !== undefined
      ? unknownGpuHint(unknownGpus, plan.precision)
      : null;
  if (unknownHint !== null) hints.push(unknownHint);
  if (hours !== undefined) {
    hints.push(
      setsDuration(filters.query)
        ? "Your --query sets duration, so --hours did not add its contract-length filter; max_h still shows the contract left"
        : `Offers whose rental contract ends within ${hours} h are hidden (duration>=${durationDays(hours)} days); max_h = hours of contract left`,
    );
  }
  if (hours !== undefined && balance === null) {
    hints.push(
      "The account balance could not be read as a positive number, so pct_balance is null; run `vast-axi` to check the account",
    );
  }
  if (shown.length < sorted.length) {
    hints.push(
      `Showing ${shown.length} of ${sorted.length} matching offers; raise --limit to see more`,
    );
  }
  if (!full) {
    hints.push(
      `All upstream fields: \`vast-axi search ${[...echoed, "--full"].map(shellArg).join(" ")}\``,
    );
  }

  return {
    offers: shown.map(toOutput),
    priced_for_disk_gb: disk,
    ...(basis !== null ? { sort: plan.sort, value_basis: basis } : {}),
    ...(hours !== undefined
      ? {
          hours,
          balance:
            reading?.balance === null || reading?.balance === undefined
              ? null
              : money(reading.balance, 2),
        }
      : {}),
    count: sorted.length,
    cheapest_id: cheapest["id"] ?? null,
    min_dph: prices.length > 0 ? money(Math.min(...prices), 3) : null,
    median_dph: prices.length > 0 ? money(median(prices), 3) : null,
    help: hints,
  };
};
