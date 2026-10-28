// Canned remote replies and script decoding for the run/job/finish tests, so
// no test ever starts a real ssh. The reply format is the `@vaxi` protocol of
// src/job.ts.
import { type ToolRun, type ToolSpawner } from "../../src/transfer.js";

export interface RecordOpts {
  name?: string;
  pid?: number;
  alive?: boolean;
  start?: string;
  cwd?: string;
  log?: string;
  cmd?: string;
  size?: number;
  nolog?: boolean;
  /** A token-carrying exit marker line. */
  marker?: { code: number; end: string };
  exitfile?: string;
  /** Raw tail text (base64-encoded for the wire). */
  tail?: string;
  now?: string;
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

/** One probe record as the remote script would print it. */
export function record(o: RecordOpts = {}): string {
  const lines = [
    `@vaxi job ${o.name ?? "main"}`,
    `@vaxi pid ${o.pid ?? 4242}`,
    `@vaxi alive ${o.alive ? "yes" : "no"}`,
    `@vaxi start ${o.start ?? "2026-10-20T10:00:00Z"}`,
    `@vaxi cwd ${o.cwd ?? "/workspace"}`,
    `@vaxi log ${o.log ?? "/workspace/run.log"}`,
    `@vaxi cmd ${b64(`${o.cmd ?? "python train.py"}\n`)}`,
  ];
  if (o.nolog) lines.push("@vaxi nolog");
  else {
    lines.push(`@vaxi size ${o.size ?? 2048}`);
    if (o.marker) {
      lines.push(
        `@vaxi marker __VAST_AXI_EXIT__ aabbccddeeff00112233aabb code=${o.marker.code} end=${o.marker.end}`,
      );
    }
    if (o.tail !== undefined) lines.push(`@vaxi tail ${b64(o.tail)}`);
  }
  if (o.exitfile) lines.push(`@vaxi exitfile ${o.exitfile}`);
  lines.push(`@vaxi now ${o.now ?? "2026-10-20T10:05:00Z"}`);
  return `${lines.join("\n")}\n`;
}

/** The two-level decode: ssh's last argument to the script it pipes into bash. */
export function decodeRemote(sshArgs: string[]): string {
  const last = sshArgs[sshArgs.length - 1]!;
  const m = /echo ([A-Za-z0-9+/=]+) \| base64 -d \| bash$/.exec(last);
  if (!m)
    throw new Error(`not a vast-axi remote command: ${last.slice(0, 80)}`);
  return Buffer.from(m[1]!, "base64").toString("utf8");
}

/** The run.sh embedded in a launcher script. */
export function embeddedRunScript(launcher: string): string {
  const m = /printf %s ([A-Za-z0-9+/=]+) \| base64 -d > "\$d\/run\.sh"/.exec(
    launcher,
  );
  if (!m) throw new Error("no run.sh in the script");
  return Buffer.from(m[1]!, "base64").toString("utf8");
}

export interface SpawnCall {
  file: string;
  args: string[];
  capture: boolean;
}

export const ok = (stdout = ""): ToolRun => ({
  exitCode: 0,
  stdout,
  stderr: "",
});

/** A spawner that records calls and answers each with `reply(call, index)`. */
export function recordingSpawner(
  reply: (call: SpawnCall, index: number) => ToolRun | Promise<ToolRun>,
): { spawn: ToolSpawner; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const spawn: ToolSpawner = (file, args, opts) => {
    const call = { file, args, capture: opts.capture };
    calls.push(call);
    return Promise.resolve(reply(call, calls.length - 1));
  };
  return { spawn, calls };
}
