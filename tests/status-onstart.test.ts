import { describe, expect, it } from "vitest";
import { REGISTRY, type Registry } from "../src/commands/index.js";
import { createStatusCommand, help } from "../src/commands/status.js";
import { buildOnstartText } from "../src/onstart.js";
import type { ToolRun } from "../src/transfer.js";
import {
  decodeRemote,
  ok,
  record,
  recordingSpawner,
  type SpawnCall,
} from "./helpers/job-records.js";
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

function inst(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 5001,
    label: "job",
    gpu_name: "RTX 4090",
    num_gpus: 1,
    image_uuid: "example/image:latest",
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

const rows = (...list: Record<string, unknown>[]): Env => ({
  FAKE_VASTAI_ROUTES: JSON.stringify({
    "show instances": { stdout: JSON.stringify(list) },
  }),
});

const FAST: Env = { VAST_AXI_POLL_MS: "10", VAST_AXI_WAIT_MS: "300" };

/** Replies for successive ssh calls; the last one repeats. A string is a probe reply, a ToolRun is raw. */
function sshReplies(...replies: Array<string | ToolRun>) {
  const { spawn, calls } = recordingSpawner((_c, i) => {
    const r = replies[Math.min(i, replies.length - 1)]!;
    return typeof r === "string" ? ok(r) : r;
  });
  return { spawn, calls };
}

const SSH_DOWN: ToolRun = {
  exitCode: 255,
  stdout: "",
  stderr: "Connection refused",
};
const T0 = "2026-10-20T10:00:00Z";
const done = (code: number, tail?: string, end = "2026-10-20T10:03:00Z") =>
  record({
    name: "onstart",
    start: T0,
    marker: { code, end },
    ...(tail !== undefined ? { tail } : {}),
  });
const running = () =>
  record({ name: "onstart", start: T0, alive: true, tail: "installing\n" });

async function status(
  args: string[],
  env: Env,
  replies: Array<string | ToolRun> = [done(0)],
) {
  const { spawn, calls } = sshReplies(...replies);
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
  const out = await runCli(["status", ...args], {
    env: { FAKE_VASTAI_LOG: log, ...env },
    registry,
  });
  return { ...out, ssh: calls, vast: readCallLog(log) };
}

const probedJobs = (calls: SpawnCall[]) =>
  calls.map((c) => decodeRemote(c.args));

describe("status without --wait", () => {
  it("shows onstart: present when the marker is stored, with no ssh call", async () => {
    const r = await status(["5001"], rows(inst()));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("onstart: present");
    expect(r.stdout).toContain("vast-axi job 5001 --name onstart");
    expect(r.ssh).toHaveLength(0);
  });

  it.each([["None"], [null], [""], ["env | sort"]])(
    "an instance with onstart %j is unchanged: no onstart line, no ssh",
    async (onstart) => {
      const r = await status(["5001"], rows(inst({ onstart })));
      expect(r.exitCode).toBe(0);
      expect(r.stdout).not.toContain("onstart");
      expect(r.ssh).toHaveLength(0);
    },
  );
});

describe("status --wait with a vast-axi onstart", () => {
  it("finished: waits on the onstart job over ssh and reports exit 0 with minutes", async () => {
    const r = await status(["5001", "--wait"], { ...FAST, ...rows(inst()) });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('onstart: "finished (exit 0, 3 min)"');
    expect(r.stdout).toContain("class: running");
    expect(r.ssh).toHaveLength(1);
    expect(r.ssh[0]!.args.join(" ")).toContain("-o BatchMode=yes");
    expect(probedJobs(r.ssh)[0]).toContain(".vast-axi/jobs/onstart");
  });

  it("keeps polling while the job runs, then reports finished", async () => {
    const r = await status(
      ["5001", "--wait"],
      { ...FAST, VAST_AXI_WAIT_MS: "30000", ...rows(inst()) },
      [running(), running(), done(0)],
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("finished (exit 0");
    expect(r.ssh).toHaveLength(3);
  });

  it("E77: a failed job exits 1 with the last log lines and a help line, and keeps the instance", async () => {
    const tail = `${"line\n".repeat(30)}ERROR: no matching distribution\n`;
    const r = await status(["5001", "--wait"], { ...FAST, ...rows(inst()) }, [
      done(2, tail),
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("onstart: failed (exit 2)");
    expect(r.stdout).toContain("onstart_log[20]:");
    expect(r.stdout).toContain("ERROR: no matching distribution");
    expect(r.stdout).toContain("vast-axi job 5001 --name onstart --tail 100");
    expect(r.stdout).toContain("The instance is kept");
    expect(r.stdout).not.toContain("__VAST_AXI_EXIT__");
    const verbs = r.vast.map((c) => c.tokens[0]);
    expect(verbs).not.toContain("stop");
    expect(verbs).not.toContain("destroy");
  });

  it("E77: a lost job (no exit line, no process) is reported like a failure after two readings", async () => {
    const lost = record({ name: "onstart", start: T0, alive: false });
    const r = await status(["5001", "--wait"], { ...FAST, ...rows(inst()) }, [
      lost,
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('onstart: "failed (lost: no exit recorded)"');
    expect(r.ssh.length).toBeGreaterThanOrEqual(2);
  });

  it("one lost reading while the wrapper starts is not a failure", async () => {
    const lost = record({ name: "onstart", start: T0, alive: false });
    const r = await status(["5001", "--wait"], { ...FAST, ...rows(inst()) }, [
      lost,
      running(),
      done(0),
    ]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("finished (exit 0");
  });

  it("ssh not reachable yet, or no job record yet: keeps polling inside the deadline", async () => {
    const r = await status(["5001", "--wait"], { ...FAST, ...rows(inst()) }, [
      SSH_DOWN,
      "@vaxi notfound\n",
      "Welcome banner only\n",
      done(0),
    ]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("finished (exit 0");
    expect(r.ssh).toHaveLength(4);
  });

  it("deadline with ssh never reachable: onstart unknown (deadline), exit 1", async () => {
    const r = await status(["5001", "--wait"], { ...FAST, ...rows(inst()) }, [
      SSH_DOWN,
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("onstart: unknown (deadline)");
    expect(r.stdout).toContain("class: running");
  });

  it("deadline while the job still runs: says so, exit 1", async () => {
    const r = await status(["5001", "--wait"], { ...FAST, ...rows(inst()) }, [
      running(),
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain(
      "onstart: running (not finished at the deadline)",
    );
    expect(r.stdout).toContain("vast-axi job 5001 --name onstart");
  });

  it("an unexpected ssh/tool error is not swallowed", async () => {
    const r = await status(["5001", "--wait"], { ...FAST, ...rows(inst()) }, [
      "@vaxi missing bash\n",
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("REMOTE_TOOL_MISSING");
  });
});

describe("status --wait without a vast-axi onstart", () => {
  it.each([["None"], [null], ["env | sort"]])(
    "onstart %j: returns when running with exactly the old behaviour and no ssh",
    async (onstart) => {
      const r = await status(["5001", "--wait"], {
        ...FAST,
        ...rows(inst({ onstart })),
      });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("class: running");
      expect(r.stdout).not.toContain("onstart");
      expect(r.ssh).toHaveLength(0);
    },
  );
});
