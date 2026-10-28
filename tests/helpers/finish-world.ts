// Shared fixture for the finish tests: a finish command wired to a recording
// ssh/scp spawner, an instant clock and an in-memory filesystem.
import { normalize } from "node:path";
import * as finish from "../../src/commands/finish.js";
import { REGISTRY, type Registry } from "../../src/commands/index.js";
import type { ToolRun } from "../../src/transfer.js";
import {
  decodeRemote,
  ok,
  record,
  recordingSpawner,
  type SpawnCall,
} from "./job-records.js";
import { newCallLog, readCallLog } from "./run-cli.js";
export const END = "2026-10-20T10:42:00Z";
export const running = ok(record({ alive: true }));
export const finished = (extra = {}) =>
  ok(record({ marker: { code: 0, end: END }, tail: "done\n", ...extra }));
export const failed = (code = 3) =>
  ok(record({ marker: { code, end: END }, tail: "boom\n" }));
export const lost = ok(record({ alive: false }));
export const sshDown: ToolRun = {
  exitCode: 255,
  stdout: "",
  stderr: "timed out",
};
export const listing = (...files: Array<[number, string]>) =>
  `@vaxi spec 0\n${files.map(([s, p]) => `${s} ${p}`).join("\n")}\n@vaxi end\n`;

export interface World {
  /** Replies to successive probes; the last one repeats. */
  probes: ToolRun[];
  /** Reply to the remote file listing. */
  list?: string;
  /** Called for each scp; may create local files via `put`. */
  scp?: (call: SpawnCall, put: (path: string, size: number) => void) => ToolRun;
}

/** A finish command wired to fakes: ssh/scp spawner, instant clock, in-memory filesystem. */
export function build(world: World) {
  const files = new Map<string, { size: number; isDirectory: boolean }>();
  const put = (path: string, size: number) =>
    void files.set(normalize(path), { size, isDirectory: false });
  const sleeps: number[] = [];
  let now = 0;
  let probeIndex = 0;
  const scpCalls: SpawnCall[] = [];
  const listCalls: SpawnCall[] = [];
  const { spawn, calls } = recordingSpawner((call) => {
    if (call.file === "scp") {
      scpCalls.push(call);
      return world.scp ? world.scp(call, put) : ok();
    }
    const script = decodeRemote(call.args);
    if (script.includes("vaxi_probe_job")) {
      const reply =
        world.probes[Math.min(probeIndex, world.probes.length - 1)]!;
      probeIndex++;
      return reply;
    }
    listCalls.push(call);
    return ok(world.list ?? "");
  });
  const command = finish.createFinishCommand({
    spawn,
    resolveTool: (name) => name,
    clock: {
      now: () => now,
      sleep: (ms) => {
        sleeps.push(ms);
        now += ms;
        return Promise.resolve();
      },
    },
    stat: (p) => files.get(normalize(p)),
    mkdirp: () => undefined,
  });
  const registry: Registry = {
    home: REGISTRY.home,
    commands: { ...REGISTRY.commands, finish: { command, help: finish.help } },
  };
  return { registry, calls, scpCalls, listCalls, sleeps, files, put };
}

export const withLog = () => {
  const log = newCallLog();
  return { log, env: { FAKE_VASTAI_LOG: log } };
};
export const vastCalls = (log: string, ...prefix: string[]) =>
  readCallLog(log).filter((c) => prefix.every((p, i) => c.tokens[i] === p));
