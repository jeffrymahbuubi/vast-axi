// `status <id> --wait` also waits for ssh (FR7, B7). Every test injects the
// clock; none counts attempts against real time.
import { describe, expect, it } from "vitest";
import { REGISTRY, type Registry } from "../src/commands/index.js";
import {
  createStatusCommand,
  help,
  type WaitClock,
} from "../src/commands/status.js";
import { AxiError } from "../src/errors.js";
import { buildOnstartText } from "../src/onstart.js";
import type { ToolRun } from "../src/transfer.js";
import {
  decodeRemote,
  ok,
  record,
  recordingSpawner,
} from "./helpers/job-records.js";
import {
  newCallLog,
  readCallLog,
  runCli,
  type Env,
} from "./helpers/run-cli.js";

const IMAGE = "python:3.11-slim";
const SSH_DOWN: ToolRun = {
  exitCode: 255,
  stdout: "",
  stderr:
    "ssh: connect to host ssh-host.example.test port 22000: Connection refused\nsecond line",
};
const LAUNCH_LOOP = "/.launch: line 48: ssh: command not found\n";
const NO_SIG = "starting container\nall good\n";

function inst(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 5001,
    label: "job",
    gpu_name: "RTX 4090",
    num_gpus: 1,
    image_uuid: IMAGE,
    dph_total: 0.4,
    actual_status: "running",
    intended_status: "running",
    status_msg: "",
    ssh_host: "ssh-host.example.test",
    ssh_port: 22000,
    start_date: Date.now() / 1000 - 7200,
    gpu_util: 80,
    ...over,
  };
}

const routes = (
  row: Record<string, unknown>,
  logs: { stdout?: string } = { stdout: NO_SIG },
): Env => ({
  FAKE_VASTAI_ROUTES: JSON.stringify({
    "show instances": { stdout: JSON.stringify([row]) },
    logs,
  }),
});

/** Sleep advances time at once and is recorded. */
function fakeClock(
  intervalMs = 15_000,
  deadlineMs = 600_000,
): WaitClock & { sleeps: number[] } {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    intervalMs,
    deadlineMs,
    sleeps,
  };
}

async function status(
  args: string[],
  env: Env,
  reply: (i: number) => string | ToolRun,
  opts: { clock?: WaitClock; resolveTool?: () => string } = {},
) {
  const { spawn, calls } = recordingSpawner((_c, i) => {
    const r = reply(i);
    return typeof r === "string" ? ok(r) : r;
  });
  const clock = opts.clock ?? fakeClock();
  const registry: Registry = {
    home: REGISTRY.home,
    commands: {
      ...REGISTRY.commands,
      status: {
        command: createStatusCommand({
          spawn,
          resolveTool: opts.resolveTool ?? (() => "ssh"),
          clock,
        }),
        help,
      },
    },
  };
  const log = newCallLog();
  const out = await runCli(["status", ...args], {
    env: { FAKE_VASTAI_LOG: log, ...env },
    registry,
  });
  return { ...out, ssh: calls, vast: readCallLog(log) };
}

const verbs = (r: { vast: Array<{ tokens: string[] }> }) =>
  r.vast.map((c) => c.tokens[0]);

describe("status --wait: ssh readiness", () => {
  it("E162: ssh fails twice then answers: ssh: ready after the polls, exit 0", async () => {
    const clock = fakeClock();
    const r = await status(
      ["5001", "--wait"],
      routes(inst()),
      (i) => (i < 2 ? SSH_DOWN : ""),
      { clock },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("class: running");
    expect(r.stdout).toContain("ssh: ready after 10s");
    expect(r.ssh).toHaveLength(3);
    // The remote command is `true`, and the poll is capped at 5 s.
    expect(r.ssh[0]!.args.at(-1)).toBe("true");
    // E189: the probe bounds the connect (OQ63).
    expect(r.ssh[0]!.args).toContain("ConnectTimeout=10");
    expect(clock.sleeps).toEqual([5000, 5000]);
  });

  it("E162: ssh answering at once prints plain ssh: ready", async () => {
    const r = await status(["5001", "--wait"], routes(inst()), () => "");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("ssh: ready");
    expect(r.stdout).not.toContain("ready after");
    expect(r.ssh).toHaveLength(1);
  });

  it("E163: ssh never answers: exit 1, not ready after 3m with the first stderr line", async () => {
    const clock = fakeClock();
    const r = await status(["5001", "--wait"], routes(inst()), () => SSH_DOWN, {
      clock,
    });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('ssh: "not ready after 3m:');
    expect(r.stdout).toContain("Connection refused");
    expect(r.stdout).not.toContain("second line");
    expect(r.stdout).toContain("vast-axi status 5001 --wait");
    expect(r.stdout).toContain("vast-axi logs 5001");
    expect(r.stdout).toContain("class: running");
    // 180 s window at 5 s polls: 37 attempts; the log is read once per poll from the second failure.
    expect(r.ssh).toHaveLength(37);
    expect(verbs(r).filter((v) => v === "logs")).toHaveLength(36);
  });

  it("E163: a short wait deadline shortens the ssh window", async () => {
    const r = await status(["5001", "--wait"], routes(inst()), () => SSH_DOWN, {
      clock: fakeClock(1000, 20_000),
    });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('ssh: "not ready after 20s:');
    expect(r.ssh).toHaveLength(21);
  });

  it("E164: no ssh client on PATH: ssh: unchecked, exit 0, no ssh call", async () => {
    const r = await status(["5001", "--wait"], routes(inst()), () => "", {
      resolveTool: () => {
        throw new AxiError("no ssh", "TRANSFER_TOOL_MISSING");
      },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("ssh: unchecked (no ssh client on PATH)");
    expect(r.ssh).toHaveLength(0);
  });

  it("E164: an image without ssh stops with IMAGE_NO_SSH after two failures", async () => {
    const r = await status(
      ["5001", "--wait"],
      routes(inst(), { stdout: LAUNCH_LOOP }),
      () => SSH_DOWN,
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("IMAGE_NO_SSH");
    expect(r.stdout).toContain(`The image ${IMAGE} has no ssh`);
    expect(r.ssh).toHaveLength(2);
    expect(verbs(r).filter((v) => v === "logs")).toHaveLength(1);
  });

  it("E165: an onstart instance without --wait: onstart as before, no ssh call", async () => {
    const onstart = buildOnstartText({
      script: "echo hi\n",
      token: "aabbccddeeff00112233aabb",
    });
    const r = await status(["5001"], routes(inst({ onstart })), () => "");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("onstart: present");
    expect(r.stdout).not.toContain("ssh: ");
    expect(r.ssh).toHaveLength(0);
  });

  it("E165: an onstart instance with --wait runs the onstart wait only, never ssh true", async () => {
    const onstart = buildOnstartText({
      script: "echo hi\n",
      token: "aabbccddeeff00112233aabb",
    });
    const done = record({
      name: "onstart",
      start: "2026-10-20T10:00:00Z",
      marker: { code: 0, end: "2026-10-20T10:03:00Z" },
    });
    const r = await status(
      ["5001", "--wait"],
      routes(inst({ onstart })),
      () => done,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("finished (exit 0");
    expect(r.stdout).not.toContain("ssh: ready");
    expect(r.ssh).toHaveLength(1);
    expect(decodeRemote(r.ssh[0]!.args)).toContain(".vast-axi/jobs/onstart");
  });

  it("E165: plain status without --wait makes no ssh call", async () => {
    const r = await status(["5001"], routes(inst()), () => "");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain("ssh: ");
    expect(r.ssh).toHaveLength(0);
  });

  it("E166: --live on an idle GPU points at `vast-axi job <id>` and names gpu_warning", async () => {
    const r = await status(
      ["5001", "--live"],
      routes(inst()),
      () => ok("0, 25.0, 300\n").stdout,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("idle_live: yes");
    expect(r.stdout).toContain("check it with `vast-axi job 5001`");
    expect(r.stdout).toContain("gpu_warning");
    expect(r.stdout).toContain("`vast-axi stop 5001`");
  });

  it("the status help names the ssh wait", () => {
    expect(help).toContain("3 more min for ssh");
  });
});
