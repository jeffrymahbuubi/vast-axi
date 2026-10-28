// The one place vast-axi talks to the vast.ai REST API directly. The `vastai`
// CLI cannot create a scheduled destroy, so `rent --max-hours` needs this.
//
// Key safety (E62): the API key is only ever sent in the Authorization header
// to the API base URL. Every piece of text that leaves this module (errors,
// response snippets) is scrubbed of the actual key value, because it may come
// from a file where redactSecrets' env-var branch would miss it.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AxiError, redactSecrets } from "./errors.js";

/** Production API root; `VAST_AXI_API_URL` points tests at a local fake server. */
export const DEFAULT_API_URL = "https://console.vast.ai";

/** Per-request ceiling in ms; `VAST_AXI_REST_TIMEOUT_MS` overrides it (tests). */
export const REST_TIMEOUT_MS = 20_000;

/**
 * The API root. The key goes to this host, so an override must be https on a
 * vast.ai host, or plain http on loopback (the test fake); anything else is a
 * CONFIG_ERROR rather than a key sent somewhere unexpected.
 */
export function apiBaseUrl(): string {
  const fromEnv = process.env["VAST_AXI_API_URL"]?.trim();
  const base = (fromEnv || DEFAULT_API_URL).replace(/\/+$/, "");
  let url: URL | undefined;
  try {
    url = new URL(base);
  } catch {
    url = undefined;
  }
  const host = url?.hostname ?? "";
  const vastHost = host === "vast.ai" || host.endsWith(".vast.ai");
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(host);
  const allowed =
    url !== undefined &&
    ((url.protocol === "https:" && vastHost) ||
      (url.protocol === "http:" && loopback));
  if (!allowed) {
    throw new AxiError(
      "VAST_AXI_API_URL must be an https URL on a vast.ai host (or http on loopback for tests); refusing to send the API key there",
      "CONFIG_ERROR",
      ["Unset VAST_AXI_API_URL to use https://console.vast.ai"],
    );
  }
  return base;
}

function readTrimmed(path: string): string | undefined {
  try {
    const text = readFileSync(path, "utf8").trim();
    return text === "" ? undefined : text;
  } catch {
    return undefined;
  }
}

/** Where `findApiKey` looks, in order (for error messages; no key content). */
export function apiKeyLocations(): string[] {
  const xdg = process.env["XDG_CONFIG_HOME"]?.trim();
  const configDir = xdg ? xdg : join(homedir(), ".config");
  return [
    "VAST_API_KEY environment variable",
    join(configDir, "vastai", "vast_api_key"),
    join(homedir(), ".vast_api_key"),
  ];
}

/**
 * The vast.ai API key, looked up like vastai/_base.py: VAST_API_KEY, then
 * $XDG_CONFIG_HOME/vastai/vast_api_key (fallback ~/.config/vastai/vast_api_key),
 * then the legacy ~/.vast_api_key. Whitespace is trimmed.
 */
export function findApiKey(): string | undefined {
  const fromEnv = process.env["VAST_API_KEY"]?.trim();
  if (fromEnv) return fromEnv;
  const [, xdgFile, legacyFile] = apiKeyLocations();
  return readTrimmed(xdgFile!) ?? readTrimmed(legacyFile!);
}

/** The key, or CONFIG_ERROR (exit 1) naming the three locations, never any key content. */
export function requireApiKey(why: string): string {
  // Check where the key would go before anything is rented.
  apiBaseUrl();
  const key = findApiKey();
  if (key) return key;
  const [env, xdgFile, legacyFile] = apiKeyLocations();
  throw new AxiError(
    `${why} needs the vast.ai API key to call the REST API, but none was found`,
    "CONFIG_ERROR",
    [
      "Run `vast-axi setup key <key>` to store a key (create one in the vast.ai console)",
      `Looked in: ${env}, ${xdgFile}, ${legacyFile}`,
    ],
  );
}

/** Remove the key value (and any bearer token) and other credential-looking text from `text`. */
export function scrubSecrets(text: string, key: string | undefined): string {
  let out = text;
  if (key && key.length >= 1) out = out.split(key).join("<redacted>");
  out = out.replace(/\bBearer\s+\S+/gi, "Bearer <redacted>");
  return redactSecrets(out);
}

export interface RestResponse {
  status: number;
  /** Parsed JSON body; undefined when the body was empty or not JSON. */
  json: unknown;
}

/** A REST call that did not produce a usable 2xx answer. The message is already scrubbed. */
export class RestError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "RestError";
    this.status = status;
  }
}

function timeoutMs(): number {
  const fromEnv = Number(process.env["VAST_AXI_REST_TIMEOUT_MS"]);
  return fromEnv > 0 ? fromEnv : REST_TIMEOUT_MS;
}

function snippet(json: unknown, text: string, key: string): string {
  let msg = text;
  if (json && typeof json === "object" && !Array.isArray(json)) {
    const o = json as Record<string, unknown>;
    const parts = [o["error"], o["msg"], o["message"]].filter(
      (v): v is string => typeof v === "string" && v !== "",
    );
    if (parts.length > 0) msg = parts.join(": ");
  }
  const clean = scrubSecrets(msg.trim().split(/\r?\n/)[0] ?? "", key);
  return clean.length > 200 ? `${clean.slice(0, 200)}...` : clean;
}

/**
 * POST a JSON body to `<base><path>` with the key as a bearer token. Resolves
 * only for HTTP 2xx; everything else (network error, timeout, non-2xx) throws a
 * RestError whose message never contains the key. Redirects are refused so the
 * key can never be forwarded to another host. No shell, no retries.
 */
export async function restPost(
  path: string,
  body: unknown,
  apiKey: string,
): Promise<RestResponse> {
  const limit = timeoutMs();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limit);
  try {
    let status: number;
    let text: string;
    try {
      const res = await fetch(`${apiBaseUrl()}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
        redirect: "error",
        signal: controller.signal,
      });
      status = res.status;
      text = await res.text();
    } catch (error) {
      if (controller.signal.aborted) {
        throw new RestError(
          `no answer from the vast.ai API within ${limit} ms`,
        );
      }
      const why = error instanceof Error ? error.message : String(error);
      const cause =
        error instanceof Error && error.cause instanceof Error
          ? `: ${error.cause.message}`
          : "";
      throw new RestError(
        `network error calling the vast.ai API (${scrubSecrets(why + cause, apiKey)})`,
      );
    }
    let json: unknown;
    try {
      json = text.trim() === "" ? undefined : JSON.parse(text);
    } catch {
      json = undefined;
    }
    if (status < 200 || status >= 300) {
      const detail = snippet(json, text, apiKey);
      throw new RestError(
        `vast.ai API answered HTTP ${status}${detail ? `: ${detail}` : ""}`,
        status,
      );
    }
    return { status, json };
  } finally {
    clearTimeout(timer);
  }
}
