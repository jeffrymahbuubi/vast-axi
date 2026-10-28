import { AxiError, exitCodeForError } from "axi-sdk-js";

export { AxiError, exitCodeForError };

/** An error reported by the vast.ai API, as `vastai --raw` surfaces it. */
export interface UpstreamError {
  status: number | null;
  msg: string;
  /** Machine code when upstream sends `"error": "<code>"` (for example `no_such_ask`). */
  code?: string;
}

/** One row of the mapping table; the first matching row wins. */
export interface ErrorPattern {
  test: (error: UpstreamError) => boolean;
  code: string;
  message: (error: UpstreamError) => string;
  suggestions?: (error: UpstreamError) => string[];
}

/** The version vast-axi's fixtures and parsers were recorded against. */
export const TESTED_VASTAI_VERSION = "1.8.3";

/**
 * Strip anything that looks like a credential from text bound for stdout:
 * the configured VAST_API_KEY value, and any long hex token (R16).
 */
export function redactSecrets(text: string): string {
  let out = text;
  const key = process.env["VAST_API_KEY"];
  if (key && key.length >= 4) out = out.split(key).join("<redacted>");
  return out.replace(/\b[0-9a-f]{40,}\b/gi, "<redacted>");
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Recognise an upstream error body: `{error: true, status_code, msg}` (what
 * `_emit_error` writes) or an API failure `{success: false, error, msg}`.
 */
export function errorFromBody(body: unknown): UpstreamError | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body))
    return undefined;
  const o = body as Record<string, unknown>;
  if (o["error"] !== true && o["success"] !== false) return undefined;
  const status =
    typeof o["status_code"] === "number"
      ? o["status_code"]
      : typeof o["status"] === "number"
        ? o["status"]
        : null;
  const code = typeof o["error"] === "string" ? o["error"] : undefined;
  const msg =
    typeof o["msg"] === "string"
      ? o["msg"]
      : typeof o["message"] === "string"
        ? o["message"]
        : (code ?? "unknown error");
  return { status, msg, ...(code ? { code } : {}) };
}

/** Find an upstream error object in stderr text (whole text, then line by line from the end). */
export function parseUpstreamError(stderr: string): UpstreamError | undefined {
  const text = stderr.trim();
  if (!text) return undefined;
  const whole = errorFromBody(tryParse(text));
  if (whole) return whole;
  for (const line of text.split(/\r?\n/).reverse()) {
    if (!line.trimStart().startsWith("{")) continue;
    const found = errorFromBody(tryParse(line.trim()));
    if (found) return found;
  }
  return undefined;
}

function clip(text: string, max = 200): string {
  const line = redactSecrets(text.trim().split(/\r?\n/)[0] ?? "");
  return line.length > max ? `${line.slice(0, max)}...` : line;
}

const text = (e: UpstreamError): string => `${e.code ?? ""} ${e.msg}`;

const patterns: ErrorPattern[] = [
  {
    test: (e) =>
      e.status === 401 ||
      e.status === 403 ||
      // Live API (2026-10-20): a bad key is HTTP 404 "Invalid user key", not 401.
      /(missing|invalid|no|not set).{0,20}(api|user)[ _-]?key|api[ _-]?key.{0,20}(missing|invalid|required|not (set|found))/i.test(
        e.msg,
      ),
    code: "AUTH_REQUIRED",
    // The upstream message is never echoed here: it may quote the key.
    message: () => "vast.ai API key is missing or invalid",
    suggestions: () => [
      "Run `vast-axi setup key <key>` to store a key (create one in the vast.ai console)",
      "Or set VAST_API_KEY in the environment",
    ],
  },
  {
    test: (e) => e.status === 429,
    code: "RATE_LIMITED",
    message: () => "vast.ai rate limit hit; wait about 60s before retrying",
    suggestions: () => [
      "Wait 60s, then rerun the same command",
      "Do not retry in a loop",
    ],
  },
  {
    test: (e) =>
      /insufficient[_ ]?(credit|funds|balance)|not enough (credit|funds|balance)|low (credit|balance)/i.test(
        text(e),
      ),
    code: "INSUFFICIENT_CREDIT",
    message: () => "Not enough vast.ai credit for this action",
    suggestions: () => [
      "Run `vast-axi` to see the current balance",
      "Add credit in the vast.ai billing page, then retry",
    ],
  },
  {
    test: (e) =>
      /no_such_ask|no such (ask|offer)|already rented|offer.*(unavailable|no longer)|ask.*(unavailable|not found|no longer)/i.test(
        text(e),
      ),
    code: "OFFER_UNAVAILABLE",
    message: () => "That offer is no longer available",
    suggestions: () => [
      "Run `vast-axi search --limit 10` to find another offer",
    ],
  },
  {
    test: (e) =>
      e.status === 404 ||
      /not found|no such instance|no_such_instance/i.test(text(e)),
    code: "NOT_FOUND",
    message: (e) => clip(e.msg) || "Not found",
    suggestions: () => ["Run `vast-axi status` to list your instances"],
  },
];

/**
 * Map an upstream error to an AxiError. `extra` patterns are tried first, so a
 * command can refine a code (for example add the balance to
 * INSUFFICIENT_CREDIT) without editing this table.
 */
export function mapVastError(
  error: UpstreamError,
  extra: ErrorPattern[] = [],
): AxiError {
  for (const p of [...extra, ...patterns]) {
    if (p.test(error)) {
      return new AxiError(
        p.message(error),
        p.code,
        p.suggestions?.(error) ?? [],
      );
    }
  }
  const status = error.status ? ` ${error.status}` : "";
  const hints =
    error.status !== null && error.status >= 500
      ? ["vast.ai reported a server error; retry in about 30s"]
      : ["Run `vast-axi` to check account and instance state"];
  return new AxiError(
    `vast.ai error${status}: ${clip(error.msg) || "no details"}`,
    "UPSTREAM_ERROR",
    hints,
  );
}

export function vastNotInstalledError(detail?: string): AxiError {
  return new AxiError(
    detail ?? "vastai CLI is not installed or not on PATH",
    "VASTAI_NOT_INSTALLED",
    [
      "Install it with `uv tool install vastai` (or `pip install vastai`)",
      "Or point VAST_AXI_BIN at the vastai executable, for example a project `.venv/Scripts/vastai.exe`",
    ],
  );
}

export function timeoutError(ms: number): AxiError {
  return new AxiError(
    `vastai did not answer within ${Math.round(ms / 1000)}s`,
    "TIMEOUT",
    [
      "Retry the command once",
      "After a timed-out rent, stop or destroy, run `vast-axi status` before repeating it",
    ],
  );
}

export function outputTooLargeError(limit: number): AxiError {
  return new AxiError(
    `vastai output exceeded ${limit} bytes`,
    "OUTPUT_TOO_LARGE",
    ["Narrow the request (for example a smaller --tail or --limit)"],
  );
}

/** UPSTREAM_PARSE_ERROR: quotes the first 200 chars and points at `raw` (E5). */
export function parseError(output: string, hint?: string): AxiError {
  const snippet = JSON.stringify(redactSecrets(output.slice(0, 200)));
  return new AxiError(
    `Unexpected vastai output: ${snippet}`,
    "UPSTREAM_PARSE_ERROR",
    [
      "Run `vast-axi raw <vastai args>` to inspect the unparsed output",
      ...(hint ? [hint] : []),
    ],
  );
}

/** E7: hint naming the tested version; "older" when the found one is below 1.8. */
export function versionHint(found: string): string {
  const [major = 0, minor = 0] = found.split(".").map(Number);
  const older = major < 1 || (major === 1 && minor < 8);
  return older
    ? `VASTAI_VERSION: vastai ${found} is older than the tested ${TESTED_VASTAI_VERSION}; run \`uv tool upgrade vastai\``
    : `VASTAI_VERSION: vastai ${found} found; vast-axi is tested with ${TESTED_VASTAI_VERSION}`;
}
