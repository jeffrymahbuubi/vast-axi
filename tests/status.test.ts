import { describe, expect, it } from "vitest";
import { REGISTRY, type Registry } from "../src/commands/index.js";
import {
  createStatusCommand,
  help,
  WAIT_DEADLINE_MS,
  WAIT_INTERVAL_MS,
  waitForRunning,
  type StatusInstance,
  type WaitClock,
} from "../src/commands/status.js";
import type { ToolRun, ToolSpawner } from "../src/transfer.js";
import { newCallLog, runCli, upstreamCalls } from "./helpers/calls.js";

const nowS = () => Date.now() / 1000;

function inst(over: Record<string, unknown> = {}): Record<string, unknown> {
  const { ageMin = 120, ...rest } = over;
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
    start_date: nowS() - (ageMin as number) * 60,
    gpu_util: 80,
    ...rest,
  };
}

function withInstances(list: unknown[]): Record<string, string> {
  return {
    FAKE_VASTAI_ROUTES: JSON.stringify({
      "show instances": { stdout: JSON.stringify(list) },
    }),
  };
}

/** `show instances` answers step through `lists`, the last one repeating. */
function withSequence(lists: unknown[][]): Record<string, string> {
  return {
    FAKE_VASTAI_ROUTES: JSON.stringify({
      "show instances": {
        sequence: lists.map((l) => ({ stdout: JSON.stringify(l) })),
      },
    }),
  };
}

const states = { U4_FIXTURE: "u4-states.json" };
const status = (args: string[], env: Record<string, string> = {}) =>
  runCli(["status", ...args], { env });

describe("status list (R9)", () => {
  it("lists instances with actual_status and class, and a next step per class", async () => {
    const { stdout, exitCode } = await status([]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain(
      "instances[3]{id,label,gpu,actual_status,class,reason,dph_total,age_h}:",
    );
    expect(stdout).toContain("1000001,train-run,RTX 4090,running,running,");
    expect(stdout).toContain("1000003,null,RTX 4090,exited,stopped,");
    expect(stdout).toContain("running: Run `vast-axi ssh 1000001`");
    expect(stdout).toContain("stopped: Restart with");
    expect(stdout).not.toContain("destroy");
  });

  it("zero instances prints the empty state with a search suggestion", async () => {
    const { stdout, exitCode } = await status([], {
      U4_FIXTURE: "u4-empty.json",
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("instances: 0 instances");
    expect(stdout).toContain("vast-axi search");
  });

  it("E11: a mixed account never lists offline/unknown/exited/loading as running", async () => {
    const { stdout } = await status([], states);
    expect(stdout).not.toMatch(/,running,running/);
    expect(stdout).toContain("2002,null,RTX 4090,offline,terminal,offline,");
    expect(stdout).toContain("2003,null,RTX 4090,unknown,terminal,unknown,");
    expect(stdout).toContain("2005,null,RTX 4090,exited,stopped,host_stopped,");
    expect(stdout).toContain("terminal: Run `vast-axi destroy 2002`");
  });
});

describe("status prices", () => {
  it("rounds dph_total to 4 decimals in the list and in the detail view", async () => {
    const env = withInstances([inst({ dph_total: 0.04891851851851852 })]);
    const list = await status([], env);
    expect(list.stdout).toContain(",0.0489,");
    expect(list.stdout).not.toContain("0.048918");
    const one = await status(["5001"], env);
    expect(one.stdout).toContain("dph_total: 0.0489\n");
  });
});

describe("status <id>", () => {
  it("shows ssh, image, status_msg and reason fields for a running instance", async () => {
    const { stdout, exitCode } = await status(["1000001"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("id: 1000001");
    expect(stdout).toContain("class: running");
    expect(stdout).toContain("ssh_host: ssh-host.example.test");
    expect(stdout).toContain("ssh_port: 22222");
    expect(stdout).toContain('image: "example/image:latest"');
    expect(stdout).toContain("reason: null");
    expect(stdout).toContain("status_msg: null");
    expect(stdout).toContain("vast-axi ssh 1000001");
  });

  it("AE3/E11: offline is terminal; help suggests destroy and search, never wait", async () => {
    const { stdout, exitCode } = await status(["2002"], states);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("class: terminal");
    expect(stdout).toContain("vast-axi destroy 2002");
    expect(stdout).toContain("vast-axi search");
    expect(stdout).not.toMatch(/wait/i);
  });

  it("AE3/E17: exited with intended running is stopped (host_stopped), no destroy hint", async () => {
    const { stdout } = await status(["2005"], states);
    expect(stdout).toContain("class: stopped");
    expect(stdout).toContain("reason: host_stopped");
    expect(stdout).toContain("vast-axi raw");
    expect(stdout).not.toContain("destroy");
  });

  it("E11: a user-stopped instance is stopped with no destroy hint", async () => {
    const { stdout } = await status(["2004"], states);
    expect(stdout).toContain("class: stopped");
    expect(stdout).toContain("reason: null");
    expect(stdout).not.toContain("destroy");
  });

  it("E12: loading past 10 min is booting with reason slow, status_msg and no destroy hint", async () => {
    const { stdout } = await status(["2001"], states);
    expect(stdout).toContain("class: booting");
    expect(stdout).toContain("reason: slow");
    expect(stdout).toContain("status_msg: Pulling image layers");
    expect(stdout).not.toContain("destroy");
  });

  it("E12: loading within 10 min is booting with a status retry hint", async () => {
    const { stdout } = await status(
      ["5001"],
      withInstances([
        inst({ actual_status: "loading", ageMin: 2, ssh_host: null }),
      ]),
    );
    expect(stdout).toContain("class: booting");
    expect(stdout).toContain("reason: null");
    expect(stdout).toContain("vast-axi status 5001 --wait");
    expect(stdout).not.toContain("destroy");
  });

  it("status 999 is NOT_FOUND, exit 1", async () => {
    const { stdout, exitCode } = await status(["999"]);
    expect(exitCode).toBe(1);
    expect(stdout).toContain("code: NOT_FOUND");
    expect(stdout).toContain("vast-axi status");
  });

  it("rejects a non-numeric id with VALIDATION_ERROR, exit 2", async () => {
    const { stdout, exitCode } = await status(["abc"]);
    expect(exitCode).toBe(2);
    expect(stdout).toContain("VALIDATION_ERROR");
  });

  it("E27: a unicode label survives TOON and --json", async () => {
    const toon = await status(["1000002"]);
    expect(toon.stdout).toContain("label: 训练-ünï");
    const json = await status(["1000002", "--json"]);
    expect(JSON.parse(json.stdout)).toMatchObject({ label: "训练-ünï" });
  });

  it("E20: an unknown flag exits 2 and lists the valid ones", async () => {
    const { stdout, exitCode } = await status(["--bogus"]);
    expect(exitCode).toBe(2);
    expect(stdout).toContain("--bogus");
    expect(stdout).toContain("valid flags for status: --wait");
  });
});

describe("status --wait (R9)", () => {
  const fast = { VAST_AXI_POLL_MS: "10", VAST_AXI_WAIT_MS: "80" };

  it("needs an id", async () => {
    const { stdout, exitCode } = await status(["--wait"]);
    expect(exitCode).toBe(2);
    expect(stdout).toContain("--wait needs an <id>");
  });

  it("returns at once, exit 0, when the instance is already running", async () => {
    const log = newCallLog();
    const { stdout, exitCode } = await status(["1000001", "--wait"], {
      ...fast,
      FAKE_VASTAI_LOG: log,
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("class: running");
    expect(upstreamCalls(log)).toHaveLength(1);
  });

  it("polls through booting until running", async () => {
    const log = newCallLog();
    const { stdout, exitCode } = await status(["5001", "--wait"], {
      VAST_AXI_POLL_MS: "10",
      VAST_AXI_WAIT_MS: "30000",
      FAKE_VASTAI_LOG: log,
      ...withSequence([
        [inst({ actual_status: "loading", ageMin: 1 })],
        [inst({ actual_status: "loading", ageMin: 1 })],
        [inst()],
      ]),
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("class: running");
    expect(upstreamCalls(log)).toHaveLength(3);
  });

  it("E11: exits 1 at once for terminal and for stopped, after a single call", async () => {
    for (const [id, code] of [
      ["2002", "INSTANCE_TERMINAL"],
      ["2003", "INSTANCE_TERMINAL"],
      ["2004", "INSTANCE_STOPPED"],
      ["2005", "INSTANCE_STOPPED"],
    ] as const) {
      const log = newCallLog();
      const { stdout, exitCode } = await status([id, "--wait"], {
        ...states,
        ...fast,
        FAKE_VASTAI_LOG: log,
      });
      expect(exitCode).toBe(1);
      expect(stdout).toContain(`code: ${code}`);
      expect(upstreamCalls(log)).toHaveLength(1);
      if (code === "INSTANCE_STOPPED") expect(stdout).not.toContain("destroy");
      else expect(stdout).toContain(`vast-axi destroy ${id}`);
    }
  });

  it("E12: exits 1 at the deadline while still booting, naming status_msg", async () => {
    const { stdout, exitCode } = await status(["2001", "--wait"], {
      ...states,
      ...fast,
    });
    expect(exitCode).toBe(1);
    expect(stdout).toContain("code: WAIT_TIMEOUT");
    expect(stdout).toContain("Pulling image layers");
    expect(stdout).not.toContain("destroy");
  });

  it("an instance that vanishes mid-wait is NOT_FOUND, exit 1", async () => {
    const { stdout, exitCode } = await status(["5001", "--wait"], {
      VAST_AXI_POLL_MS: "10",
      VAST_AXI_WAIT_MS: "30000",
      FAKE_VASTAI_LOG: newCallLog(),
      ...withSequence([[inst({ actual_status: "loading", ageMin: 1 })], []]),
    });
    expect(exitCode).toBe(1);
    expect(stdout).toContain("code: NOT_FOUND");
  });
});

describe("waitForRunning with an injected clock", () => {
  /** A fake clock: sleep advances time and records each wait. */
  function fakeClock() {
    let t = 1_800_000_000_000;
    const sleeps: number[] = [];
    const clock: WaitClock = {
      now: () => t,
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
      intervalMs: WAIT_INTERVAL_MS,
      deadlineMs: WAIT_DEADLINE_MS,
    };
    return { clock, sleeps, advance: (ms: number) => (t += ms) };
  }

  const make = (actual_status: string, extra = {}): StatusInstance => ({
    id: 9,
    actual_status,
    intended_status: "running",
    ...extra,
  });

  it("polls every 15 s and returns the running instance", async () => {
    const { clock, sleeps } = fakeClock();
    const answers = ["loading", "loading", "running"];
    let calls = 0;
    const got = await waitForRunning(9, clock, async () =>
      make(answers[calls++]!),
    );
    expect(got.actual_status).toBe("running");
    expect(sleeps).toEqual([15_000, 15_000]);
  });

  it("gives up at the 10-minute deadline with WAIT_TIMEOUT, polling a last time at the edge", async () => {
    const { clock, sleeps } = fakeClock();
    let calls = 0;
    await expect(
      waitForRunning(9, clock, async () => {
        calls++;
        return make("loading");
      }),
    ).rejects.toMatchObject({ code: "WAIT_TIMEOUT" });
    expect(sleeps.reduce((a, b) => a + b, 0)).toBe(WAIT_DEADLINE_MS);
    expect(sleeps).toHaveLength(WAIT_DEADLINE_MS / WAIT_INTERVAL_MS);
    expect(calls).toBe(WAIT_DEADLINE_MS / WAIT_INTERVAL_MS + 1);
  });

  it("does not sleep at all for a stopped or terminal instance", async () => {
    for (const status of ["exited", "offline", "unknown"]) {
      const { clock, sleeps } = fakeClock();
      await expect(
        waitForRunning(9, clock, async () => make(status)),
      ).rejects.toMatchObject({ code: expect.stringMatching(/INSTANCE_/) });
      expect(sleeps).toEqual([]);
    }
  });

  it("an instance that turns stopped mid-wait fails at that poll", async () => {
    const { clock, sleeps } = fakeClock();
    const answers = ["loading", "exited"];
    let calls = 0;
    await expect(
      waitForRunning(9, clock, async () => make(answers[calls++]!)),
    ).rejects.toMatchObject({ code: "INSTANCE_STOPPED" });
    expect(sleeps).toEqual([15_000]);
  });
});

describe("status idle tri-state (E32)", () => {
  const one = (over: Record<string, unknown>) =>
    status(["5001"], withInstances([inst(over)]));

  it("E32: a 6 min old instance reading 0 is unknown, labelled as delayed", async () => {
    const { stdout, exitCode } = await one({ gpu_util: 0, ageMin: 6 });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("idle: unknown");
    expect(stdout).toContain("gpu_util_source: vast.ai (delayed)");
    expect(stdout).not.toContain("--live");
  });

  it("E32: a 40 min old instance reading 0 is likely, with the --live hint and never a plain yes", async () => {
    const { stdout } = await one({ gpu_util: 0, ageMin: 40 });
    expect(stdout).toContain("idle: likely");
    expect(stdout).not.toMatch(/idle: (true|yes)/);
    expect(stdout).toContain(
      "#5001 looks idle per vast.ai's delayed gpu_util; confirm with `vast-axi status 5001 --live` before stopping",
    );
  });

  it("E32: null gpu_util is unknown and 99.99 is no", async () => {
    expect((await one({ gpu_util: null, ageMin: 300 })).stdout).toContain(
      "idle: unknown",
    );
    const busy = await one({ gpu_util: 99.99, ageMin: 300 });
    expect(busy.stdout).toContain("idle: no");
    expect(busy.stdout).not.toContain("looks idle");
  });
});

interface LiveCall {
  file: string;
  args: string[];
  capture: boolean;
}

/** A registry whose `status` runs ssh through a recording fake, never the real one. */
function liveRegistry(run: Partial<ToolRun> = {}): {
  registry: Registry;
  calls: LiveCall[];
} {
  const calls: LiveCall[] = [];
  const spawn: ToolSpawner = (file, args, opts) => {
    calls.push({ file, args, capture: opts.capture });
    return Promise.resolve({ exitCode: 0, stdout: "", stderr: "", ...run });
  };
  const command = createStatusCommand({ spawn, resolveTool: () => "ssh" });
  return {
    calls,
    registry: {
      home: REGISTRY.home,
      commands: { ...REGISTRY.commands, status: { command, help } },
    },
  };
}

const live = (
  run: Partial<ToolRun>,
  args: string[] = ["5001", "--live"],
  over: Record<string, unknown> = {},
) => {
  const { registry, calls } = liveRegistry(run);
  return runCli(["status", ...args], {
    env: withInstances([inst(over)]),
    registry,
  }).then((out) => ({ ...out, calls }));
};

describe("status --live (E32)", () => {
  it("E32: 100% at 342 W is busy, over ssh with BatchMode and no shell", async () => {
    const out = await live({ stdout: "100, 342.10, 18000\n" });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("gpu_util_live: 100");
    expect(out.stdout).toContain("power_w: 342.1");
    expect(out.stdout).toContain("mem_used_mib: 18000");
    expect(out.stdout).toContain("idle_live: no");
    expect(out.calls).toEqual([
      {
        file: "ssh",
        args: [
          "-p",
          "22000",
          "-o",
          "StrictHostKeyChecking=accept-new",
          "-o",
          "BatchMode=yes",
          "root@ssh-host.example.test",
          "nvidia-smi",
          "--query-gpu=utilization.gpu,power.draw,memory.used",
          "--format=csv,noheader,nounits",
        ],
        capture: true,
      },
    ]);
  });

  it("E32: several GPUs report the max utilisation, summed power and memory", async () => {
    const out = await live({
      stdout: "0, 25.0, 300\n87, 210.55, 9000\n3, 40.0, 512\n",
    });
    expect(out.stdout).toContain("gpus: 3");
    expect(out.stdout).toContain("gpu_util_live: 87");
    expect(out.stdout).toContain("power_w: 275.6");
    expect(out.stdout).toContain("mem_used_mib: 9812");
    expect(out.stdout).toContain("idle_live: no");
  });

  it("E32: every GPU under 5% is idle_live yes, and only then is stop offered", async () => {
    const out = await live({ stdout: "0, 25.0, 300\n" });
    expect(out.stdout).toContain("gpu_util_live: 0");
    expect(out.stdout).toContain("idle_live: yes");
    expect(out.stdout).toContain("vast-axi stop 5001");
  });

  it("E32: ssh exit 255 is SSH_FAILED and never falls back to the upstream value", async () => {
    const out = await live({
      exitCode: 255,
      stderr: "Permission denied (publickey).",
    });
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("code: SSH_FAILED");
    expect(out.stdout).toContain("Permission denied");
    expect(out.stdout).toContain("vast-axi status 5001");
    expect(out.stdout).not.toContain("gpu_util_live");
  });

  it("E32: a failing or unparsable nvidia-smi is SSH_FAILED, not a guess", async () => {
    const missing = await live({
      exitCode: 127,
      stderr: "nvidia-smi: not found",
    });
    expect(missing.stdout).toContain("code: SSH_FAILED");
    const garbage = await live({ stdout: "N/A, N/A, N/A\n" });
    expect(garbage.stdout).toContain("code: SSH_FAILED");
    const empty = await live({ stdout: "" });
    expect(empty.stdout).toContain("code: SSH_FAILED");
  });

  it("E32: --live on a stopped instance is VALIDATION_ERROR (exit 2) and runs no ssh", async () => {
    const out = await live({}, ["5001", "--live"], {
      actual_status: "exited",
      intended_status: "stopped",
    });
    expect(out.exitCode).toBe(2);
    expect(out.stdout).toContain("code: VALIDATION_ERROR");
    expect(out.calls).toEqual([]);
  });

  it("E32: --live with --wait, or without an id, is exit 2", async () => {
    const both = await live({}, ["5001", "--live", "--wait"]);
    expect(both.exitCode).toBe(2);
    expect(both.stdout).toContain("code: VALIDATION_ERROR");
    const bare = await live({}, ["--live"]);
    expect(bare.exitCode).toBe(2);
    expect(bare.calls).toEqual([]);
  });
});
