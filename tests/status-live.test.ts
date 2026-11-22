import { describe, expect, it } from "vitest";
import { REGISTRY, type Registry } from "../src/commands/index.js";
import { createStatusCommand, help } from "../src/commands/status.js";
import type { ToolRun, ToolSpawner } from "../src/transfer.js";
import { runCli } from "./helpers/calls.js";

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
