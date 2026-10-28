import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AxiError } from "./errors.js";
import { METRIC_LAG_GRACE_MIN } from "./idle.js";

/** Built-in defaults (OQ3a, OQ13a); `maxBurn` defaults to 2x the resolved `maxDph`. */
export const DEFAULTS = {
  maxDph: 1,
  idleMinutes: 30,
  metricLagMinutes: METRIC_LAG_GRACE_MIN,
} as const;

type Key = "maxDph" | "maxBurn" | "idleMinutes" | "metricLagMinutes";
type Source = "env" | "file" | "default";

export interface Config {
  /** Per-instance price cap in USD/hr (inclusive). */
  maxDph: number;
  /** Aggregate burn ceiling in USD/hr. */
  maxBurn: number;
  /** Minutes a running instance may sit below 5% GPU before it is flagged idle. */
  idleMinutes: number;
  /** Minutes vast.ai's `gpu_util` is assumed to lag; a younger instance is never "likely" idle. */
  metricLagMinutes: number;
  sources: Record<Key, Source>;
  path: string;
}

export interface LoadOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

const ENV_NAMES: Record<Key, string> = {
  maxDph: "VAST_AXI_MAX_DPH",
  maxBurn: "VAST_AXI_MAX_BURN",
  idleMinutes: "VAST_AXI_IDLE_MINUTES",
  metricLagMinutes: "VAST_AXI_METRIC_LAG_MINUTES",
};

/** `~/.config/vast-axi/config.json`, or `VAST_AXI_CONFIG` when set (tests, odd layouts). */
export function configPath(opts: LoadOptions = {}): string {
  const env = opts.env ?? process.env;
  return (
    env["VAST_AXI_CONFIG"] ??
    join(opts.homeDir ?? homedir(), ".config", "vast-axi", "config.json")
  );
}

function readFile(path: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new AxiError(`Cannot read config file ${path}`, "CONFIG_ERROR", [
      `Fix the permissions on ${path} or delete it`,
    ]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AxiError(
      `Config file ${path} is not valid JSON`,
      "CONFIG_ERROR",
      [
        `Fix or delete ${path}`,
        'Expected shape: {"maxDph": 1, "maxBurn": 2, "idleMinutes": 30}',
      ],
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AxiError(
      `Config file ${path} must hold a JSON object`,
      "CONFIG_ERROR",
      [`Fix or delete ${path}`],
    );
  }
  return parsed as Record<string, unknown>;
}

function checkNumber(
  value: unknown,
  where: string,
  allowZero: boolean,
): number {
  const n =
    typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (
    typeof n !== "number" ||
    !Number.isFinite(n) ||
    n < 0 ||
    (n === 0 && !allowZero)
  ) {
    throw new AxiError(
      `${where} must be a ${allowZero ? "non-negative" : "positive"} number`,
      "CONFIG_ERROR",
    );
  }
  return n;
}

/**
 * Resolve the spend-guard settings once per invocation (KTD9, R15): env var,
 * then the config file, then the default. Read-only; only `setup` writes.
 * Unknown file keys are ignored.
 */
export function loadConfig(opts: LoadOptions = {}): Config {
  const env = opts.env ?? process.env;
  const path = configPath(opts);
  const file = readFile(path);
  const values: Partial<Record<Key, number>> = {};
  const sources = {} as Record<Key, Source>;

  for (const key of Object.keys(ENV_NAMES) as Key[]) {
    const allowZero = key === "idleMinutes" || key === "metricLagMinutes";
    const fromEnv = env[ENV_NAMES[key]];
    if (fromEnv !== undefined && fromEnv !== "") {
      values[key] = checkNumber(fromEnv, ENV_NAMES[key], allowZero);
      sources[key] = "env";
    } else if (file[key] !== undefined) {
      values[key] = checkNumber(file[key], `${key} in ${path}`, allowZero);
      sources[key] = "file";
    } else {
      sources[key] = "default";
    }
  }

  const maxDph = values.maxDph ?? DEFAULTS.maxDph;
  return {
    maxDph,
    maxBurn: values.maxBurn ?? maxDph * 2,
    idleMinutes: values.idleMinutes ?? DEFAULTS.idleMinutes,
    metricLagMinutes: values.metricLagMinutes ?? DEFAULTS.metricLagMinutes,
    sources,
    path,
  };
}
