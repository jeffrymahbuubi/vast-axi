// Instance lookup and the one place that decides which host and port reach an
// instance over ssh (A5). `ssh`, `copy`, `stop` and `destroy` all read it.
import { AxiError } from "./errors.js";
import { vastJson, type VastOptions } from "./vastai.js";

/** The fields of a `show instance` row this tool reads; everything else is ignored. */
export interface InstanceInfo {
  id?: number;
  actual_status?: string | null;
  intended_status?: string | null;
  ssh_host?: string | null;
  ssh_port?: number | null;
  public_ipaddr?: string | null;
  image_runtype?: string | null;
  /** Docker-style port map, for example `{"22/tcp": [{"HostPort": "40022"}]}`. */
  ports?: Record<string, Array<{ HostPort?: string | number }> | null> | null;
}

export interface Endpoint {
  host: string;
  port: number;
}

/** Parse an instance id argument; anything but a positive integer is a VALIDATION_ERROR. */
export function parseInstanceId(raw: string): number {
  if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
    throw new AxiError(
      `<id> must be a positive integer, got "${raw}"`,
      "VALIDATION_ERROR",
      ["Run `vast-axi status` to list your instance ids"],
    );
  }
  return Number(raw);
}

/**
 * Normalise what `show instance --raw` prints: the row itself, a
 * `{instances: row}` wrapper, or `{instances: null}` for a missing id.
 */
function unwrap(body: unknown, id: number): InstanceInfo | undefined {
  if (!body || typeof body !== "object") return undefined;
  if (Array.isArray(body)) {
    const row = body.find((r) => (r as InstanceInfo)?.id === id);
    return row ? (row as InstanceInfo) : undefined;
  }
  const o = body as Record<string, unknown>;
  if ("instances" in o) return unwrap(o["instances"], id);
  return typeof o["id"] === "number" || o["actual_status"] !== undefined
    ? (o as InstanceInfo)
    : undefined;
}

/**
 * Read one instance. A missing instance is `undefined` (callers decide
 * whether that is an error or a no-op); every other failure throws.
 */
export async function fetchInstance(
  id: number,
  opts: VastOptions = {},
): Promise<InstanceInfo | undefined> {
  try {
    const body = await vastJson<unknown>(
      ["show", "instance", String(id)],
      opts,
    );
    return unwrap(body, id);
  } catch (error) {
    if (error instanceof AxiError && error.code === "NOT_FOUND")
      return undefined;
    throw error;
  }
}

/** Reject leftover positionals so a typo never silently runs a different command. */
export function assertNoExtra(args: string[], usage: string): void {
  const extra = args.filter((a) => !a.startsWith("-"));
  if (extra.length === 0) return;
  throw new AxiError(
    `unexpected argument${extra.length > 1 ? "s" : ""}: ${extra.join(" ")}`,
    "VALIDATION_ERROR",
    [`usage: ${usage}`],
  );
}

/** Upstream treats exited + intended stopped as a user stop (see KTD5). */
export function isStopped(instance: InstanceInfo): boolean {
  return (
    instance.actual_status === "exited" &&
    instance.intended_status === "stopped"
  );
}

/**
 * The connectable host and port, chosen like upstream `vastai ssh-url`:
 * a direct instance publishes `22/tcp` on `public_ipaddr`; otherwise the
 * proxy pair `ssh_host`/`ssh_port` is used (+1 for jupyter runtypes, where
 * the proxy's first port serves jupyter). Undefined when neither is usable.
 */
export function resolveEndpoint(instance: InstanceInfo): Endpoint | undefined {
  const direct = instance.ports?.["22/tcp"]?.[0]?.HostPort;
  const directPort = Number(direct);
  if (
    instance.public_ipaddr &&
    Number.isInteger(directPort) &&
    directPort > 0
  ) {
    return { host: instance.public_ipaddr, port: directPort };
  }
  const base = Number(instance.ssh_port);
  if (!instance.ssh_host || !Number.isInteger(base) || base <= 0)
    return undefined;
  const port = /jupyter/i.test(instance.image_runtype ?? "") ? base + 1 : base;
  return { host: instance.ssh_host, port };
}

/**
 * Fetch an instance and require a usable ssh endpoint. Missing, not running,
 * or without a port are all errors that point at `status`.
 */
export async function requireEndpoint(
  id: number,
  opts: VastOptions = {},
): Promise<Endpoint> {
  const instance = await fetchInstance(id, opts);
  if (!instance) {
    throw new AxiError(`Instance #${id} not found`, "NOT_FOUND", [
      "Run `vast-axi status` to list your instances",
    ]);
  }
  const state = instance.actual_status ?? "unknown";
  const endpoint = resolveEndpoint(instance);
  if (state !== "running" || !endpoint) {
    throw new AxiError(
      state !== "running"
        ? `Instance #${id} is ${state}, not running; ssh is not available`
        : `Instance #${id} has no ssh endpoint yet`,
      "NOT_RUNNING",
      [`Run \`vast-axi status ${id}\` to see its state`],
    );
  }
  return endpoint;
}
