// Turn raw `vastai show instance(s) --raw` captures into committable fixtures.
//
//   pnpm tsx scripts/record-fixtures.ts <raw-dir> [out-dir]
//
// <raw-dir> holds show-instances-running.json and show-instance-running.json
// (never committed: they carry jupyter_token, extra_env, onstart, real IPs and
// host ids). The output is tests/fixtures/live-*.json.
//
// The sanitizer is an ALLOWLIST: only the fields vast-axi reads survive, and
// every identifying value among them is replaced. assertClean() then refuses
// the output if anything token-, secret- or address-shaped is left, and
// assertNoRawValues() refuses it if any raw sensitive value is still present.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type Json = Record<string, unknown>;

/** Every instance field src/ reads. Anything not listed here is dropped. */
export const ALLOWED_FIELDS = [
  "id",
  "label",
  "gpu_name",
  "num_gpus",
  "actual_status",
  "intended_status",
  "dph_total",
  "storage_cost",
  "disk_space",
  "start_date",
  "gpu_util",
  "image_uuid",
  "image_runtype",
  "status_msg",
  "ssh_host",
  "ssh_port",
  "public_ipaddr",
  "ports",
] as const;

/** Raw fields whose values are sensitive; used to prove none of them leaked. */
const SENSITIVE_KEYS = [
  "jupyter_token",
  "extra_env",
  "onstart",
  "image_args",
  "public_ipaddr",
  "local_ipaddrs",
  "ssh_host",
  "host_id",
  "machine_id",
  "id",
];

const FAKE_START_DATE = 1760000000.2222798;

/** Stable fake identity: the same raw value always maps to the same fake one. */
export class Pseudonyms {
  private ids = new Map<unknown, number>();
  private hosts = new Map<string, number>();
  private ips = new Map<string, number>();
  private ports = new Map<string, number>();

  id(real: unknown): number {
    if (!this.ids.has(real)) this.ids.set(real, 4000001 + this.ids.size);
    return this.ids.get(real)!;
  }
  host(real: string): string {
    if (!this.hosts.has(real)) this.hosts.set(real, this.hosts.size);
    return `ssh${this.hosts.get(real)}.example.invalid`;
  }
  ip(real: string): string {
    if (!this.ips.has(real)) this.ips.set(real, 10 + this.ips.size);
    return `192.0.2.${this.ips.get(real)}`;
  }
  /** Fake port by first sight, so distinct raw ports stay distinct. */
  port(real: unknown, base: number): number {
    const key = `${base}:${String(real)}`;
    if (!this.ports.has(key)) {
      const used = [...this.ports.keys()].filter((k) =>
        k.startsWith(`${base}:`),
      );
      this.ports.set(key, base + used.length);
    }
    return this.ports.get(key)!;
  }
}

const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Keep a free-text value only if it is plainly harmless; otherwise a neutral stand-in. */
function safeText(v: unknown, pattern: RegExp, fallback: string): string {
  const s = str(v);
  return s !== null && pattern.test(s) ? s : fallback;
}

/** Docker-style port map: keep the container port keys and HostPort, drop HostIp. */
function sanitizePorts(ports: unknown, p: Pseudonyms): Json | null {
  if (!ports || typeof ports !== "object") return null;
  const out: Json = {};
  for (const [key, list] of Object.entries(ports as Json)) {
    if (!/^\d{1,5}\/(tcp|udp)$/.test(key)) continue;
    out[key] = Array.isArray(list)
      ? list.slice(0, 1).map((e) => ({
          HostPort: String(p.port((e as Json)?.["HostPort"], 40022)),
        }))
      : null;
  }
  return out;
}

export function sanitizeInstance(raw: Json, p: Pseudonyms): Json {
  const out: Json = {};
  for (const key of ALLOWED_FIELDS) {
    if (!(key in raw)) continue;
    const v = raw[key];
    switch (key) {
      case "id":
        out[key] = p.id(v);
        break;
      case "label":
        out[key] =
          v === null
            ? null
            : safeText(v, /^vast-axi-[a-z0-9-]{1,40}$/, "live-instance");
        break;
      case "ssh_host":
        out[key] = str(v) ? p.host(v as string) : null;
        break;
      case "public_ipaddr":
        out[key] = str(v) ? p.ip(v as string) : null;
        break;
      case "ssh_port":
        out[key] = num(v) === null ? null : p.port(v, 22001);
        break;
      case "start_date":
        out[key] = num(v) === null ? null : FAKE_START_DATE;
        break;
      case "ports":
        out[key] = sanitizePorts(v, p);
        break;
      case "status_msg":
        out[key] =
          v === null
            ? null
            : safeText(v, /^[A-Za-z0-9 ,._:()/-]{0,120}$/, "status message");
        break;
      case "image_uuid":
        out[key] =
          v === null
            ? null
            : safeText(
                v,
                /^[a-z0-9][a-z0-9._/-]*(:[A-Za-z0-9._-]+)?$/,
                "example/image:latest",
              );
        break;
      case "image_runtype":
        out[key] = v === null ? null : safeText(v, /^[a-z_ ]{1,40}$/, "ssh");
        break;
      default:
        out[key] = v;
    }
  }
  return out;
}

const IPV4 = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;

/**
 * Denylist: throws if the serialized fixture carries anything secret-shaped.
 * Exported so the fixture test applies the very same check to the committed files.
 */
export function assertClean(text: string, label = "fixture"): void {
  const problems: string[] = [];
  const fail = (what: string) => problems.push(what);
  for (const ip of text.match(IPV4) ?? []) {
    if (!/^192\.0\.2\.\d{1,3}$/.test(ip))
      fail(`IP outside 192.0.2.0/24: ${ip}`);
  }
  if (/[0-9a-f]{32,}/i.test(text)) fail("32+ hex characters (token or hash)");
  if (/[A-Za-z0-9+/=_-]{40,}/.test(text)) fail("40+ char token-like string");
  if (/\b(?:[0-9a-f]{1,4}:){3,}[0-9a-f]{0,4}\b/i.test(text))
    fail("IPv6-looking address");
  if (
    /SHA256:|ssh-(?:ed25519|rsa)|BEGIN [A-Z ]*KEY|eyJ[A-Za-z0-9_-]{10,}/.test(
      text,
    )
  )
    fail("key or JWT material");
  if (/@/.test(text)) fail("an @ (email or credentialed URL)");
  if (/\.vast\.ai\b/i.test(text)) fail("a real vast.ai hostname");
  const keys = [
    "jupyter_token",
    "extra_env",
    "onstart",
    "image_args",
    "local_ipaddrs",
    "host_id",
    "machine_id",
    "api_key",
    "password",
    "secret",
    "authorization",
    "bearer",
  ];
  for (const k of keys)
    if (new RegExp(k, "i").test(text)) fail(`forbidden name "${k}"`);
  if (problems.length > 0) {
    throw new Error(`${label} is not clean:\n  - ${problems.join("\n  - ")}`);
  }
}

/** Collect every scalar inside `v`, for the raw-value cross-check. */
function scalars(v: unknown, into: Array<string | number> = []) {
  if (typeof v === "string" || typeof v === "number") into.push(v);
  else if (Array.isArray(v)) v.forEach((x) => scalars(x, into));
  else if (v && typeof v === "object")
    Object.values(v).forEach((x) => scalars(x, into));
  return into;
}

/** Fails if any raw sensitive value (token, env, IP, host, id) appears in the output. */
export function assertNoRawValues(raws: Json[], output: string): void {
  const leaked: string[] = [];
  for (const raw of raws) {
    for (const key of SENSITIVE_KEYS) {
      for (const value of scalars(raw[key])) {
        const text = String(value);
        // Short values (an empty string, "9") would match everywhere; the pattern checks cover them.
        if (text.length < 6) continue;
        if (output.includes(text))
          leaked.push(`${key} value of ${text.length} chars`);
      }
    }
  }
  if (leaked.length > 0) {
    throw new Error(`raw values survived sanitizing: ${leaked.join(", ")}`);
  }
}

function readRaw(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function asRows(body: unknown): Json[] {
  if (Array.isArray(body)) return body as Json[];
  const inner = (body as Json | null)?.["instances"];
  return Array.isArray(inner) ? (inner as Json[]) : [body as Json];
}

/** Sanitize both captures with one shared pseudonym table, so ids line up across files. */
export function sanitizeCaptures(
  instancesBody: unknown,
  instanceBody: unknown,
): { instances: string; instance: string } {
  const p = new Pseudonyms();
  const rawRows = [...asRows(instancesBody), ...asRows(instanceBody)];
  const instances = asRows(instancesBody).map((r) => sanitizeInstance(r, p));
  const single = asRows(instanceBody).map((r) => sanitizeInstance(r, p));
  const instancesText = `${JSON.stringify(instances, null, 2)}\n`;
  const instanceText = `${JSON.stringify(single[0], null, 2)}\n`;
  assertClean(instancesText, "live-show-instances-running.json");
  assertClean(instanceText, "live-show-instance-running.json");
  assertNoRawValues(rawRows, instancesText + instanceText);
  return { instances: instancesText, instance: instanceText };
}

function main(): void {
  const [rawDir, outArg] = process.argv.slice(2);
  if (!rawDir) {
    console.error("usage: record-fixtures.ts <raw-dir> [out-dir]");
    process.exit(2);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = resolve(outArg ?? join(here, "..", "tests", "fixtures"));
  const out = sanitizeCaptures(
    readRaw(join(rawDir, "show-instances-running.json")),
    readRaw(join(rawDir, "show-instance-running.json")),
  );
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, "live-show-instances-running.json"),
    out.instances,
  );
  writeFileSync(join(outDir, "live-show-instance-running.json"), out.instance);
  console.log(`wrote 2 sanitized fixtures to ${outDir}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
