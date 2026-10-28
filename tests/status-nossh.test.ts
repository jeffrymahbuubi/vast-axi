import { describe, expect, it } from "vitest";
import { REGISTRY, type Registry } from "../src/commands/index.js";
import { createStatusCommand, help } from "../src/commands/status.js";
import { buildOnstartText } from "../src/onstart.js";
import type { ToolRun } from "../src/transfer.js";
import { ok, record, recordingSpawner } from "./helpers/job-records.js";
import {
  newCallLog,
  readCallLog,
  runCli,
  type Env,
} from "./helpers/run-cli.js";

const ONSTART_TEXT = buildOnstartText({
  script: "echo hi\n",
  token: "aabbccddeeff00112233aabb",
});
const IMAGE = "python:3.11-slim";

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
    onstart: ONSTART_TEXT,
    ...over,
  };
}

/** Routes for `show instances` plus an optional `logs` reply. */
const routes = (
  row: Record<string, unknown>,
  logs?: { stdout?: string; stderr?: string; exit?: number },
): Env => ({
  FAKE_VASTAI_ROUTES: JSON.stringify({
    "show instances": { stdout: JSON.stringify([row]) },
    ...(logs ? { logs } : {}),
  }),
});

const SSH_DOWN: ToolRun = {
  exitCode: 255,
  stdout: "",
  stderr:
    "ssh: connect to host ssh-host.example.test port 22000: Connection refused",
};
const LAUNCH_LOOP = [
  "Wed Oct 21 03:19:52 UTC 2026",
  "/.launch: line 48: ssh: command not found",
  "Wed Oct 21 03:19:53 UTC 2026",
  "/.launch: line 48: ssh: command not found",
].join("\n");
const NO_SIG = "Wed Oct 21 03:19:52 UTC 2026\nstarting container\nall good\n";

const T0 = "2026-10-20T10:00:00Z";
const done = record({
  name: "onstart",
  start: T0,
  marker: { code: 0, end: "2026-10-20T10:03:00Z" },
});

async function status(
  args: string[],
  env: Env,
  replies: Array<string | ToolRun>,
) {
  const { spawn, calls } = recordingSpawner((_c, i) => {
    const r = replies[Math.min(i, replies.length - 1)]!;
    return typeof r === "string" ? ok(r) : r;
  });
  const registry: Registry = {
    home: REGISTRY.home,
    commands: {
      ...REGISTRY.commands,
      status: {
        command: createStatusCommand({ spawn, resolveTool: () => "ssh" }),
        help,
      },
    },
  };
  const log = newCallLog();
  const t = Date.now();
  const out = await runCli(["status", ...args], {
    env: { FAKE_VASTAI_LOG: log, ...env },
    registry,
  });
  return {
    ...out,
    ssh: calls,
    vast: readCallLog(log),
    ms: Date.now() - t,
  };
}

const verbs = (r: { vast: Array<{ tokens: string[] }> }) =>
  r.vast.map((c) => c.tokens[0]);
const FAST: Env = { VAST_AXI_POLL_MS: "10", VAST_AXI_WAIT_MS: "300" };
const LONG: Env = { VAST_AXI_POLL_MS: "10", VAST_AXI_WAIT_MS: "60000" };

describe("status --wait: image without ssh", () => {
  it("E87: stops with IMAGE_NO_SSH when the container log shows the launcher's ssh-not-found loop", async () => {
    const r = await status(
      ["5001", "--wait"],
      { ...LONG, ...routes(inst(), { stdout: LAUNCH_LOOP }) },
      [SSH_DOWN],
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("IMAGE_NO_SSH");
    expect(r.stdout).toContain(
      `The image ${IMAGE} has no ssh, so vast.ai cannot start sshd and the instance is never reachable`,
    );
    expect(r.stdout).toContain(
      "container log: '/.launch: line 48: ssh: command not found'",
    );
    expect(r.stdout).toContain("vast-axi destroy 5001");
    expect(r.stdout).toContain("ubuntu:22.04");
    expect(r.stdout).not.toContain("unknown (deadline)");
    // Far inside the 60 s deadline, after exactly two failed ssh polls.
    expect(r.ms).toBeLessThan(20_000);
    expect(r.ssh).toHaveLength(2);
    const v = verbs(r);
    expect(v.filter((x) => x === "logs")).toHaveLength(1);
    expect(v).not.toContain("stop");
    expect(v).not.toContain("destroy");
  });

  it.each([
    ["sshd: not found"],
    ["/usr/sbin/sshd: No such file or directory"],
    ["/.launch: line 12: sshd: command not found"],
  ])("recognises the signature %j", async (line) => {
    const r = await status(
      ["5001", "--wait"],
      { ...LONG, ...routes(inst(), { stdout: `noise\n${line}\n` }) },
      [SSH_DOWN],
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("IMAGE_NO_SSH");
    expect(r.stdout).toContain(`container log: '${line}'`);
  });

  it("a banner-only ssh reply counts as an ssh failure too", async () => {
    const r = await status(
      ["5001", "--wait"],
      { ...LONG, ...routes(inst(), { stdout: LAUNCH_LOOP }) },
      ["Welcome banner only\n"],
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("IMAGE_NO_SSH");
  });

  it("one ssh failure is not enough: no log fetch when ssh recovers", async () => {
    const r = await status(
      ["5001", "--wait"],
      { ...LONG, ...routes(inst(), { stdout: LAUNCH_LOOP }) },
      [SSH_DOWN, done],
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("finished (exit 0");
    expect(verbs(r)).not.toContain("logs");
  });

  it("E88: a failing log fetch keeps the old retry and deadline behaviour", async () => {
    const r = await status(
      ["5001", "--wait"],
      { ...FAST, ...routes(inst(), { stderr: "boom\n", exit: 1 }) },
      [SSH_DOWN],
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("onstart: unknown (deadline)");
    expect(r.stdout).not.toContain("IMAGE_NO_SSH");
    expect(r.ssh.length).toBeGreaterThan(2);
    // Never more than one log fetch per poll.
    expect(verbs(r).filter((x) => x === "logs").length).toBeLessThan(
      r.ssh.length,
    );
  });

  it("E88: a log fetch failure does not stop a later recovery", async () => {
    const r = await status(
      ["5001", "--wait"],
      { ...LONG, ...routes(inst(), { stderr: "boom\n", exit: 1 }) },
      [SSH_DOWN, SSH_DOWN, SSH_DOWN, done],
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("finished (exit 0");
  });

  it("E89: ssh failing but no signature in the log: unchanged deadline behaviour", async () => {
    const r = await status(
      ["5001", "--wait"],
      { ...FAST, ...routes(inst(), { stdout: NO_SIG }) },
      [SSH_DOWN],
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("onstart: unknown (deadline)");
    expect(r.stdout).not.toContain("IMAGE_NO_SSH");
    expect(verbs(r)).toContain("logs");
  });

  it.each([["None"], [null], ["env | sort"]])(
    "no onstart marker (%j): --wait makes no ssh and no logs call",
    async (onstart) => {
      const r = await status(
        ["5001", "--wait"],
        { ...FAST, ...routes(inst({ onstart }), { stdout: LAUNCH_LOOP }) },
        [SSH_DOWN],
      );
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("class: running");
      expect(r.ssh).toHaveLength(0);
      expect(verbs(r)).not.toContain("logs");
    },
  );
});
