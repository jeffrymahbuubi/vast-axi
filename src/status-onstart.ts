// `status --wait` on an instance with a vast-axi onstart job: poll the job over
// ssh, and fail fast when the container log shows the image has no ssh at all.
import { fetchLogText } from "./commands/logs.js";
import { pickJob, runProbe } from "./commands/job.js";
import type {
  StatusDeps,
  StatusInstance,
  WaitClock,
} from "./commands/status.js";
import { resolveEndpoint, type Endpoint } from "./endpoint.js";
import { AxiError, redactSecrets } from "./errors.js";
import { truncate } from "./format.js";
import {
  buildProbeScript,
  cleanTail,
  jobStatus,
  type JobRecord,
} from "./job.js";
import { ONSTART_JOB, describeOnstart } from "./onstart.js";

export interface OnstartWait {
  /** The `onstart:` output value. */
  line: string;
  /** True for failed, lost and deadline: the command exits 1. */
  failed: boolean;
  /** Last log lines, set when the job failed. */
  tail: string[];
}

const ONSTART_TAIL = 20;
/** ssh not up yet, or a banner-only reply: keep polling. */
const RETRY_CODES = ["SSH_FAILED", "REMOTE_FAILED"];
/** Consecutive failed ssh polls before the container log is read. */
const SSH_FAILS_BEFORE_LOG = 2;
const LOG_TAIL = 50;
/** What vast.ai's launcher prints when the image has no ssh/sshd to start. */
const NO_SSH_SIGNATURE =
  /\/\.launch: line \d+: (?:ssh|sshd): command not found|sshd: not found|\/usr\/sbin\/sshd: No such file or directory/;

/** The launcher's no-ssh line from the container log, or undefined (also on any fetch failure). */
async function findNoSshLine(id: number): Promise<string | undefined> {
  try {
    const text = await fetchLogText(id, LOG_TAIL);
    return text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => NO_SSH_SIGNATURE.test(l));
  } catch {
    return undefined;
  }
}

function noSshError(id: number, inst: StatusInstance, line: string): AxiError {
  const image = inst.image_uuid ?? "unknown";
  return new AxiError(
    `The image ${image} has no ssh, so vast.ai cannot start sshd and the instance is never reachable (container log: '${redactSecrets(truncate(line, 200))}')`,
    "IMAGE_NO_SSH",
    [
      `Run \`vast-axi destroy ${id}\` and rent again with an image that ships ssh (for example ubuntu:22.04, pytorch/pytorch or vastai/base-image)`,
      `Run \`vast-axi logs ${id}\` to see the container log`,
    ],
  );
}

/**
 * After the instance is running, poll the `onstart` job over ssh until it has
 * finished or failed (E77). A fresh deadline window starts here; ssh that is
 * not reachable yet and a record not written yet just mean "poll again".
 * `lost` must be seen twice in a row so the moment between the launcher
 * creating the job dir and the wrapper writing its pid is not a failure.
 * After two ssh failures in a row the container log is read once per poll; the
 * launcher's "ssh: command not found" loop ends the wait with IMAGE_NO_SSH.
 */
export async function waitForOnstart(
  id: number,
  inst: StatusInstance,
  clock: WaitClock,
  deps: StatusDeps,
  fetch: (id: number) => Promise<StatusInstance>,
): Promise<OnstartWait> {
  const startedAt = clock.now();
  let endpoint: Endpoint | undefined = resolveEndpoint(inst);
  let lostSeen = false;
  let sshFails = 0;
  let rec: JobRecord | undefined;
  for (;;) {
    let sshFailed = false;
    try {
      endpoint ??= resolveEndpoint(await fetch(id));
      if (endpoint) {
        const probe = await runProbe(
          deps,
          id,
          endpoint,
          buildProbeScript({ kind: "name", name: ONSTART_JOB }, ONSTART_TAIL),
        );
        rec =
          probe.kind === "jobs"
            ? pickJob(probe, id, { kind: "name", name: ONSTART_JOB })
            : undefined;
      }
    } catch (error) {
      if (!(error instanceof AxiError) || !RETRY_CODES.includes(error.code)) {
        throw error;
      }
      sshFailed = true;
    }
    sshFails = sshFailed ? sshFails + 1 : 0;
    if (sshFails >= SSH_FAILS_BEFORE_LOG) {
      const line = await findNoSshLine(id);
      if (line !== undefined) throw noSshError(id, inst, line);
    }
    const elapsed = clock.now() - startedAt;
    const expired = elapsed >= clock.deadlineMs;
    if (rec) {
      const view = describeOnstart(rec);
      const lost = jobStatus(rec).state === "lost";
      if (view.state === "finished") {
        return { line: view.line, failed: false, tail: [] };
      }
      if (view.state === "failed" && (!lost || lostSeen || expired)) {
        return {
          line: view.line,
          failed: true,
          tail: cleanTail(rec, ONSTART_TAIL),
        };
      }
      lostSeen = lost;
    }
    if (expired) {
      return {
        line: rec
          ? "running (not finished at the deadline)"
          : "unknown (deadline)",
        failed: true,
        tail: rec ? cleanTail(rec, ONSTART_TAIL) : [],
      };
    }
    await clock.sleep(Math.min(clock.intervalMs, clock.deadlineMs - elapsed));
  }
}
