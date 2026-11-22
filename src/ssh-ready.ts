// `status --wait` on an instance without an onstart job: also wait until ssh
// answers, so the first `ssh`/`copy` after it works without a retry (B7).
import type {
  StatusDeps,
  StatusInstance,
  WaitClock,
} from "./commands/status.js";
import { resolveEndpoint, type Endpoint } from "./endpoint.js";
import { AxiError } from "./errors.js";
import { formatDuration, truncate } from "./format.js";
import { findNoSshLine, noSshError } from "./status-onstart.js";
import { requireTool, runSsh, spawnTool } from "./transfer.js";

export interface SshWait {
  /** The `ssh:` output value. */
  line: string;
  /** True when ssh never answered: the command exits 1. */
  failed: boolean;
}

/** Longest ssh wait after the instance is running, and the poll cap. */
export const SSH_WINDOW_MS = 180_000;
export const SSH_INTERVAL_MS = 5_000;
const FAILS_BEFORE_LOG = 2;

function firstLine(text: string): string {
  return truncate(text.trim().split(/\r?\n/)[0] ?? "", 200);
}

/** The stderr part of runSsh's SSH_FAILED message. */
function stderrOf(error: AxiError): string {
  const m = /^ssh could not connect to #\d+: ([\s\S]*)$/.exec(error.message);
  return firstLine(m?.[1] ?? error.message);
}

export async function waitForSsh(
  id: number,
  inst: StatusInstance,
  clock: WaitClock,
  deps: StatusDeps,
  fetch: (id: number) => Promise<StatusInstance>,
): Promise<SshWait> {
  let sshPath: string;
  try {
    sshPath = (deps.resolveTool ?? requireTool)("ssh");
  } catch (error) {
    if (error instanceof AxiError && error.code === "TRANSFER_TOOL_MISSING") {
      return { line: "unchecked (no ssh client on PATH)", failed: false };
    }
    throw error;
  }
  const windowMs = Math.min(clock.deadlineMs, SSH_WINDOW_MS);
  const intervalMs = Math.min(clock.intervalMs, SSH_INTERVAL_MS);
  const startedAt = clock.now();
  let endpoint: Endpoint | undefined = resolveEndpoint(inst);
  let fails = 0;
  let reason = "no ssh endpoint yet";
  for (;;) {
    endpoint ??= resolveEndpoint(await fetch(id));
    if (endpoint) {
      try {
        const { run } = await runSsh(
          deps.spawn ?? spawnTool,
          sshPath,
          id,
          endpoint,
          ["true"],
          { connectTimeoutSec: 10 },
        );
        if (run.exitCode === 0) {
          const elapsed = clock.now() - startedAt;
          return {
            line:
              fails === 0 && elapsed < 1000
                ? "ready"
                : `ready after ${formatDuration(elapsed / 1000)}`,
            failed: false,
          };
        }
        fails += 1;
        reason = firstLine(run.stderr) || `ssh true exited ${run.exitCode}`;
      } catch (error) {
        if (!(error instanceof AxiError) || error.code !== "SSH_FAILED") {
          throw error;
        }
        fails += 1;
        reason = stderrOf(error);
      }
      if (fails >= FAILS_BEFORE_LOG) {
        const line = await findNoSshLine(id);
        if (line !== undefined) throw noSshError(id, inst, line);
      }
    }
    const elapsed = clock.now() - startedAt;
    if (elapsed >= windowMs) {
      return {
        line: `not ready after ${formatDuration(elapsed / 1000)}: ${reason}`,
        failed: true,
      };
    }
    await clock.sleep(Math.min(intervalMs, windowMs - elapsed));
  }
}
