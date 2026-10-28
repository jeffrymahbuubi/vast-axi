import { encode } from "@toon-format/toon";
import { takeBoolFlag } from "../args.js";
import {
  AxiError,
  errorFromBody,
  mapVastError,
  redactSecrets,
} from "../errors.js";
import { byteSize, truncate } from "../format.js";
import { buildHelp } from "../help.js";
import { vastRaw, type VastRunner } from "../vastai.js";
import type { VastCommand } from "./types.js";

const USAGE = "vast-axi raw <vastai args...> [--full]";

/** Rendered size above which output is cut unless `--full` is given. */
export const RAW_MAX_CHARS = 6000;

/** Output keys this command adds itself; upstream JSON using one is wrapped under `result`. */
const RESERVED = new Set(["help", "truncated", "stderr", "exit_code"]);

export const help = buildHelp({
  usage: USAGE,
  summary:
    "Run any other vastai command with --raw (teams, volumes, serverless, api-keys...). JSON output is rendered as TOON; text output goes in an `output:` block.",
  flags: [
    `--full  do not cut output larger than ${RAW_MAX_CHARS} characters (consumed here, never forwarded)`,
  ],
  notes: [
    "arguments are forwarded unchanged, so `vastai` flags such as --limit work as usual",
    "a JSON body that holds an error exits 1; other exit codes are kept as vastai reported them",
    "no guard rails here: raw does not apply the spend cap, so prefer `rent`, `stop` and `destroy`",
  ],
  examples: [
    "vast-axi raw show volumes",
    "vast-axi raw show invoices --full",
    "vast-axi raw search templates",
  ],
});

type Plain = Record<string, unknown>;

function isPlain(value: unknown): value is Plain {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Objects pass through as keys; anything else (and any reserved-key clash) sits under `result`. */
function asRecord(data: unknown): Plain {
  if (isPlain(data) && !Object.keys(data).some((k) => RESERVED.has(k))) {
    return data;
  }
  return { result: data };
}

/** Keep roughly `factor` of every array's rows (at least one); undefined when nothing can be cut. */
function cutRows(
  data: unknown,
  factor: number,
): { data: unknown; note: string } | undefined {
  const keep = (n: number) => Math.max(1, Math.floor(n * factor));
  if (Array.isArray(data) && data.length > 1) {
    const k = keep(data.length);
    return { data: data.slice(0, k), note: `${k} of ${data.length} rows` };
  }
  if (!isPlain(data)) return undefined;
  const out: Plain = {};
  const notes: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value) && value.length > 1) {
      const k = keep(value.length);
      out[key] = value.slice(0, k);
      notes.push(`${key} ${k} of ${value.length}`);
    } else {
      out[key] = value;
    }
  }
  return notes.length > 0 ? { data: out, note: notes.join(", ") } : undefined;
}

function fullHint(args: string[]): string {
  return `Rerun with --full for everything: vast-axi raw ${args.join(" ")} --full`;
}

/** Render parsed JSON, cutting rows (or, failing that, text) beyond RAW_MAX_CHARS. */
function jsonOutput(data: unknown, args: string[], full: boolean): Plain {
  const size = encode(asRecord(data)).length;
  if (full || size <= RAW_MAX_CHARS) return asRecord(data);
  const total = byteSize(size);
  const cut = cutRows(data, RAW_MAX_CHARS / size);
  if (cut) {
    return {
      ...asRecord(cut.data),
      truncated: `showing ${cut.note} (${total} rendered)`,
      help: [fullHint(args)],
    };
  }
  return {
    output: truncate(encode(asRecord(data)), RAW_MAX_CHARS),
    truncated: `cut at ${RAW_MAX_CHARS} chars (${total} rendered)`,
    help: [fullHint(args)],
  };
}

function textOutput(text: string, args: string[], full: boolean): Plain {
  if (full || text.length <= RAW_MAX_CHARS) return { output: text };
  return {
    output: truncate(text, RAW_MAX_CHARS),
    truncated: `cut at ${RAW_MAX_CHARS} chars (${byteSize(text.length)} total)`,
    help: [fullHint(args)],
  };
}

/** Factory so tests can inject the vastai runner; real runs use the default below. */
export function createRawCommand(
  deps: { runner?: VastRunner } = {},
): VastCommand {
  return async (args) => {
    const rest = [...args];
    const full = takeBoolFlag(rest, "--full");
    if (rest.length === 0) {
      throw new AxiError("raw needs a vastai command", "VALIDATION_ERROR", [
        `usage: ${USAGE}`,
        "Example: vast-axi raw show volumes",
      ]);
    }
    const result = await vastRaw(
      rest,
      deps.runner ? { runner: deps.runner } : {},
    );
    if (result.upstreamError) throw mapVastError(result.upstreamError);

    const stdout = result.stdout.trim();
    let parsed: unknown;
    let isJson = false;
    try {
      parsed = JSON.parse(stdout);
      isJson = true;
    } catch {
      // Not JSON: falls through to the text block.
    }
    // A 200 with an error object in the body is an error too (R14).
    const bodyError = isJson ? errorFromBody(parsed) : undefined;
    if (bodyError) throw mapVastError(bodyError);

    const out: Plain = isJson
      ? jsonOutput(
          JSON.parse(redactSecrets(JSON.stringify(parsed))),
          rest,
          full,
        )
      : textOutput(redactSecrets(stdout), rest, full);
    const stderr = redactSecrets(result.stderr.trim());
    if (stderr) out["stderr"] = truncate(stderr, 1000);
    if (result.exitCode !== 0) {
      // Keep the upstream exit code (R14); the structured fields say why.
      out["exit_code"] = result.exitCode;
      process.exitCode = result.exitCode;
    }
    return out;
  };
}

export const command: VastCommand = createRawCommand();
