import {
  assertKnownFlags,
  takeBoolFlag,
  takeFlag,
  takeNumberFlag,
  takePositional,
} from "../args.js";
import { totalBurnPerHr, type BurnInstance } from "../burn.js";
import { loadConfig } from "../config.js";
import { AxiError, mapVastError, parseError } from "../errors.js";
import {
  DEFAULT_DISK_GB,
  costFor,
  pctOfBalance,
  readBalance,
  takeHoursFlag,
  type BalanceReading,
} from "../estimate.js";
import { nowSec, planDestroy } from "../destroy-timer.js";
import { money } from "../format.js";
import { buildHelp } from "../help.js";
import {
  ONSTART_FLAGS,
  onstartResult,
  prepareOnstart,
  takeOnstartFlags,
} from "../rent-onstart.js";
import { refusal, usd, type BurnReading } from "../rent-refusal.js";
import { armDestroyTimer, takeMaxHoursFlag } from "../rent-timer.js";
import { decideSpend } from "../spend-guard.js";
import { requireApiKey } from "../vast-rest.js";
import { vastJson } from "../vastai.js";
import type { VastCommand } from "./types.js";

const USAGE = "vast-axi rent <offer-id> --image <image> [flags]";

export const help = buildHelp({
  usage: `${USAGE}\n       vast-axi rent <offer-id> --template <hash> [flags]`,
  summary:
    "Rent an on-demand instance (ssh, direct) from an offer id shown by `search`.",
  flags: [
    "--image <image>      docker image to launch (this or --template is required)",
    "--template <hash>    template hash to launch (this or --image is required)",
    `--disk <gb>          local disk in GB (default ${DEFAULT_DISK_GB})`,
    "--label <text>       label to set on the instance",
    "--hours <n>          rental window in hours (> 0, at most 720): also checks (burn + offer price) x n against the balance",
    "--max-hours <n>     destroy the instance on vast.ai's servers after at most n hours (2 to 23); also the --hours estimate unless --hours is given",
    "--onstart <file>     run this bash script on the instance at every start, as the detached job `onstart` (up to about 1.7 KB; 1.5 KB with --pip)",
    '--pip "<pkgs>"       pip install these packages first (plain specs like "numpy==1.26.4 pandas"); with --onstart, pip runs first',
    "--allow-secrets      rent even if the --onstart script or --pip text looks like it holds a credential",
    "--confirm            rent even when the spend guard refuses (cap, burn ceiling, balance or contract length)",
  ],
  notes: [
    "spend guard: refuses (exit 2) when the offer costs more than VAST_AXI_MAX_DPH (default 1.00 $/hr, inclusive)",
    "or when current burn + offer price exceeds VAST_AXI_MAX_BURN (default 2x the cap); --confirm overrides both",
    "with --hours N it also refuses (OVER_BALANCE) when N x (current burn + offer price) is above the account balance; --confirm overrides it",
    "if the current burn cannot be read, or --hours is given and the balance cannot be read, the guard refuses and --confirm does not override that",
    "with --hours the output adds hours, est_cost (offer only), account_need (all running instances plus this one) and pct_balance",
    "--max-hours N sets a vast.ai DAILY scheduled job at the destroy hour (UTC): the last full UTC hour within N hours of now (rounded down, never later than N h); it runs on vast.ai's servers, even if this machine is off",
    "the job fires at that hour and, if the destroy fails, once more 24 h later; it is read back and verified after creation",
    "the timer needs the API key (VAST_API_KEY, ~/.config/vastai/vast_api_key or ~/.vast_api_key); if it cannot be set or verified, the new instance is destroyed again at once (SCHEDULE_FAILED, exit 1)",
    "with --max-hours the guard also refuses (CONTRACT_SHORT; --confirm overrides) when the offer's rental contract ends before the destroy time",
    "N above 23 is refused (exit 2): for a longer run end it with `vast-axi finish <id> --wait --fetch <remote>:<local> --destroy`",
    "--onstart/--pip are checked before anything is looked up or billed; the job is read with `vast-axi job <id> --name onstart` and `status <id> --wait` waits for it (failure exits 1, instance kept)",
    "vast.ai stores the onstart text on the instance record (host and account readers can see it) and re-runs it on every container start; credential-shaped strings are refused unless --allow-secrets",
    "the whole onstart text may be at most 4048 characters: for a longer script use `vast-axi copy` then `vast-axi run`",
    "rent always creates an on-demand instance (output type: on-demand); there is no interruptible option",
    `the price is checked for the requested --disk size just before the instance is created; the output shows it as priced_for_disk_gb; \`search --disk <gb>\` prices offers for the same disk size (both default to ${DEFAULT_DISK_GB} GB)`,
  ],
  examples: [
    "vast-axi rent 12345 --image vastai/base-image",
    "vast-axi rent 12345 --image pytorch/pytorch --disk 40 --label train",
    "vast-axi rent 12345 --image pytorch/pytorch --hours 8",
    "vast-axi rent 12345 --image pytorch/pytorch --max-hours 12",
    'vast-axi rent 12345 --image pytorch/pytorch --pip "numpy pandas" --onstart setup.sh',
    "vast-axi rent 12345 --template <hash> --confirm",
  ],
});

type Row = Record<string, unknown>;

const isRow = (v: unknown): v is Row =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The array of rows in a `search offers` / `show instances` body, or undefined if the shape is unknown. */
function rowsOf(body: unknown, key: string): Row[] | undefined {
  const list = Array.isArray(body)
    ? body
    : isRow(body) && Array.isArray(body[key])
      ? (body[key] as unknown[])
      : undefined;
  return list?.filter(isRow);
}

function offerUnavailable(): AxiError {
  return mapVastError({ status: null, msg: "no_such_ask" });
}

function toId(raw: string): number {
  if (!/^[1-9]\d{0,15}$/.test(raw)) {
    throw new AxiError(
      `<offer-id> must be a positive integer, got "${raw}"`,
      "VALIDATION_ERROR",
      [USAGE, "Find offer ids with `vast-axi search --limit 10`"],
    );
  }
  return Number(raw);
}

interface OfferLookup {
  /** `dph_total` in USD/hr; null when the offer has no usable price. */
  price: number | null;
  /** Seconds of rental contract left (upstream `duration`); null when unknown. */
  durationSec: number | null;
}

/** Price and contract length of exactly this offer (any visibility, priced for `disk` GB), or OFFER_UNAVAILABLE. */
async function lookupOffer(
  offerId: number,
  disk: number,
): Promise<OfferLookup> {
  // The query token comes first and -n disables the upstream default filter,
  // so unverified and external offers still resolve (U5 plan). The live API
  // (2026-10-20) never matches `id=<n>`; the offer id is filterable only as
  // `ask_contract_id`, which carries the same value.
  const body = await vastJson<unknown>([
    "search",
    "offers",
    `ask_contract_id=${offerId}`,
    "-n",
    "--storage",
    String(disk),
  ]);
  const rows = rowsOf(body, "offers");
  if (!rows) throw parseError(JSON.stringify(body) ?? "");
  const row = rows.find(
    (r) =>
      Number(r["id"]) === offerId || Number(r["ask_contract_id"]) === offerId,
  );
  if (!row || row["rentable"] === false) throw offerUnavailable();
  const price = row["dph_total"];
  const duration = row["duration"];
  return {
    price: typeof price === "number" && Number.isFinite(price) ? price : null,
    durationSec:
      typeof duration === "number" && Number.isFinite(duration)
        ? duration
        : null,
  };
}

async function readBurn(): Promise<BurnReading> {
  try {
    const body = await vastJson<unknown>(["show", "instances"]);
    const rows = rowsOf(body, "instances");
    if (!rows)
      return { burn: null, failure: "unexpected show instances output" };
    return { burn: totalBurnPerHr(rows as BurnInstance[]) };
  } catch (error) {
    const failure =
      error instanceof AxiError
        ? `${error.code}: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
    return { burn: null, failure };
  }
}

/** Best-effort balance for INSUFFICIENT_CREDIT (E14); the original error stands if the lookup fails. */
async function withBalance(error: AxiError, price: number): Promise<AxiError> {
  try {
    const user = await vastJson<Row>(["show", "user"]);
    const raw = user["credit"] ?? user["balance"];
    if (typeof raw !== "number" || !Number.isFinite(raw)) return error;
    return new AxiError(
      `${error.message} (balance $${money(raw, 2)}, offer ${usd(price)})`,
      error.code,
      error.suggestions,
    );
  } catch {
    return error;
  }
}

async function createInstance(
  offerId: number,
  price: number,
  opts: {
    image?: string;
    template?: string;
    disk: number;
    label?: string;
    onstart?: string;
  },
): Promise<{ instance_id: number; dph_total: number }> {
  const argv = ["create", "instance", String(offerId)];
  if (opts.image !== undefined) argv.push("--image", opts.image);
  if (opts.template !== undefined) argv.push("--template_hash", opts.template);
  argv.push("--ssh", "--direct", "--disk", String(opts.disk));
  if (opts.label !== undefined) argv.push("--label", opts.label);
  if (opts.onstart !== undefined) argv.push("--onstart-cmd", opts.onstart);
  // Fail with an error instead of leaving a stopped instance that still bills storage.
  argv.push("--cancel-unavail");

  let body: unknown;
  try {
    body = await vastJson<unknown>(argv);
  } catch (error) {
    if (!(error instanceof AxiError)) throw error;
    // The only thing `create instance` looks up is the offer, so a plain
    // "not found" from it means the offer is gone (E13).
    if (error.code === "NOT_FOUND") throw offerUnavailable();
    if (error.code === "INSUFFICIENT_CREDIT") {
      throw await withBalance(error, price);
    }
    throw error;
  }
  const id = isRow(body) ? body["new_contract"] : undefined;
  if (typeof id !== "number" || !Number.isInteger(id)) {
    // The call may have succeeded and billed: never suggest a blind retry.
    throw new AxiError(
      "vastai accepted the rent but returned no instance id; an instance may exist",
      "UPSTREAM_PARSE_ERROR",
      [
        "Run `vast-axi status` before renting again",
        "Run `vast-axi raw show instances` to inspect the account",
      ],
    );
  }
  return { instance_id: id, dph_total: money(price, 4) };
}

export const command: VastCommand = async (args) => {
  assertKnownFlags(
    args,
    [
      "--image",
      "--template",
      "--disk",
      "--label",
      "--confirm",
      "--hours",
      "--max-hours",
      ...ONSTART_FLAGS,
    ],
    "rent",
  );
  const rest = [...args];
  const image = takeFlag(rest, "--image");
  const template = takeFlag(rest, "--template");
  const disk = takeNumberFlag(rest, "--disk", { min: 1 }) ?? DEFAULT_DISK_GB;
  const label = takeFlag(rest, "--label");
  const confirm = takeBoolFlag(rest, "--confirm");
  const explicitHours = takeHoursFlag(rest, "--hours");
  const maxHours = takeMaxHoursFlag(rest);
  // --max-hours implies --hours for the balance estimate unless --hours is given (E71).
  const hours = explicitHours ?? maxHours;
  const onstartFlags = takeOnstartFlags(rest);
  const offerId = toId(takePositional(rest, "offer-id", USAGE));
  const extra = rest.filter((a) => a !== "--help" && a !== "-h");
  if (extra.length > 0) {
    throw new AxiError(
      `Unexpected argument ${extra.map((a) => `"${a}"`).join(", ")}; rent takes one <offer-id>`,
      "VALIDATION_ERROR",
      [USAGE],
    );
  }
  if (image !== undefined && template !== undefined) {
    throw new AxiError(
      "rent takes --image or --template, not both",
      "VALIDATION_ERROR",
      [USAGE, "Use --template alone when the template sets the image"],
    );
  }
  if (image === undefined && template === undefined) {
    throw new AxiError(
      "rent needs --image or --template (there is no default image)",
      "VALIDATION_ERROR",
      [USAGE, "Example: vast-axi rent 12345 --image vastai/base-image"],
    );
  }

  // Validate the onstart text before any vastai call (E73-E76).
  const onstart = prepareOnstart(onstartFlags);
  // Fail fast, before anything is billed: the destroy timer needs the API key (E68).
  const apiKey =
    maxHours !== undefined ? requireApiKey("rent --max-hours") : undefined;
  const now = nowSec();
  const plan = maxHours !== undefined ? planDestroy(now, maxHours) : undefined;
  const config = loadConfig();
  const { price, durationSec } = await lookupOffer(offerId, disk);
  const burn = await readBurn();
  // The balance is only read when a rental window is given (no extra call otherwise).
  const balance: BalanceReading =
    hours !== undefined ? await readBalance() : { balance: null };
  const decision = decideSpend({
    offerPrice: price,
    currentBurn: burn.burn,
    maxDph: config.maxDph,
    maxBurn: config.maxBurn,
    confirm,
    hours,
    balance: balance.balance,
    ...(plan !== undefined
      ? {
          contract: {
            leftSec: durationSec,
            neededSec: plan.destroyAt - now,
          },
        }
      : {}),
  });
  if (!decision.allow) {
    throw refusal(decision, {
      offerId,
      price,
      burn,
      config,
      hours,
      balance,
      ...(plan !== undefined && maxHours !== undefined
        ? { timer: { maxHours, plan, leftSec: durationSec } }
        : {}),
    });
  }

  // decideSpend only allows a known price; this keeps the types and the guard honest.
  if (price === null) {
    throw new AxiError(`Offer ${offerId} has no usable price`, "PRICE_UNKNOWN");
  }
  const created = await createInstance(offerId, price, {
    ...(image !== undefined ? { image } : {}),
    ...(template !== undefined ? { template } : {}),
    disk,
    ...(label !== undefined ? { label } : {}),
    ...(onstart !== undefined ? { onstart: onstart.text } : {}),
  });
  const ost = onstart && onstartResult(onstart, created.instance_id);
  const estimate =
    hours !== undefined && burn.burn !== null
      ? {
          hours,
          est_cost: costFor(price, hours),
          account_need: costFor(burn.burn + price, hours),
          pct_balance: pctOfBalance(
            (burn.burn + price) * hours,
            balance.balance,
          ),
        }
      : {};
  // Now billing: arm and verify the timer, or destroy it again (E54, E69).
  const timer =
    plan !== undefined && maxHours !== undefined && apiKey !== undefined
      ? await armDestroyTimer(created.instance_id, plan, maxHours, apiKey)
      : undefined;
  return {
    instance_id: created.instance_id,
    type: "on-demand",
    dph_total: created.dph_total,
    priced_for_disk_gb: disk,
    ...estimate,
    ...(timer ? timer.fields : {}),
    ...(ost ? ost.fields : {}),
    ...(decision.overridden.length > 0
      ? {
          guard: `overridden with --confirm (${decision.overridden.join(", ")})`,
        }
      : {}),
    help: [
      `Run \`vast-axi status ${created.instance_id} --wait\` to wait until it is running`,
      `Run \`vast-axi ssh ${created.instance_id}\` to connect`,
      `Run \`vast-axi destroy ${created.instance_id}\` when done (billing continues until then)`,
      ...(timer
        ? [
            `\`vast-axi timer ${created.instance_id} --max-hours <n>\` moves the destroy time; \`vast-axi destroy ${created.instance_id}\` earlier also removes the timer`,
          ]
        : []),
      ...(ost ? ost.help : []),
    ],
  };
};
