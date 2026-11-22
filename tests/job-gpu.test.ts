// Field-report fixes FR3 (E131-E137): the GPU sample in the job probe, the
// `as_of` field, and the rewritten-path check of `--fetch`. No ssh runs here.
import { describe, expect, it } from "vitest";
import { REGISTRY, type Registry } from "../src/commands/index.js";
import * as job from "../src/commands/job.js";
import {
  buildProbeScript,
  parseFetchSpec,
  parseProbeOutput,
  type JobRecord,
} from "../src/job.js";
import { parseGpuSample } from "../src/job-gpu.js";
import type { ToolRun } from "../src/transfer.js";
import {
  ok,
  record,
  recordingSpawner,
  type RecordOpts,
  type SpawnCall,
} from "./helpers/job-records.js";
import { runCli } from "./helpers/run-cli.js";

function jobRegistry(reply: (call: SpawnCall) => ToolRun): Registry {
  const { spawn } = recordingSpawner(reply);
  const command = job.createJobCommand({ spawn, resolveTool: () => "ssh" });
  return {
    home: REGISTRY.home,
    commands: { ...REGISTRY.commands, job: { command, help: job.help } },
  };
}

/** `job 42` on a running job whose probe printed `opts`; `now` is `minutes` after the start. */
async function running(opts: RecordOpts, minutes: number) {
  const secs = Math.round(minutes * 60);
  const now = new Date(Date.parse("2026-10-20T10:00:00Z") + secs * 1000)
    .toISOString()
    .replace(".000", "");
  const registry = jobRegistry(() => ok(record({ alive: true, now, ...opts })));
  return runCli(["job", "42"], { registry });
}

describe("FR3 GPU sample", () => {
  it("E131: an idle GPU after 12 min shows the live fields and a warning", async () => {
    const out = await running({ gpu: "0, 165;" }, 12);
    expect(out.stdout).toContain("gpu_util_live: 0");
    expect(out.stdout).toContain("gpu_mem_mib: 165");
    expect(out.stdout).toContain(
      'gpu_warning: "GPU idle: every GPU is under 5% (now 0%, 165 MiB) and job \\"main\\" has run for 12m.',
    );
    expect(out.stdout).toContain("vast-axi ssh 42 --exec -- nvidia-smi");
    // key order after elapsed (I4)
    const keys = ["elapsed:", "as_of:", "gpu_util_live:", "gpu_mem_mib:"];
    const at = keys.map((k) => out.stdout.indexOf(k));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(out.stdout.indexOf("gpu_warning:")).toBeGreaterThan(at[3]!);
    expect(out.stdout.indexOf("log:")).toBeGreaterThan(
      out.stdout.indexOf("gpu_warning:"),
    );
  });

  it("E132: one of two GPUs at 80% gives the fields and no warning", async () => {
    const out = await running({ gpu: "80, 4000;0, 165;" }, 12);
    expect(out.stdout).toContain("gpu_util_live: 80");
    expect(out.stdout).toContain("gpu_mem_mib: 4165");
    expect(out.stdout).not.toContain("gpu_warning");
    expect(out.stdout).not.toContain("nvidia-smi");
  });

  it("E133: running 2 min shows fields only; 30 s shows nothing", async () => {
    const two = await running({ gpu: "0, 165;" }, 2);
    expect(two.stdout).toContain("gpu_util_live: 0");
    expect(two.stdout).not.toContain("gpu_warning");
    const short = await running({ gpu: "0, 165;" }, 0.5);
    expect(short.stdout).not.toContain("gpu_");
  });

  it("E133: a finished job shows no gpu keys", async () => {
    const registry = jobRegistry(() =>
      ok(
        record({
          gpu: "0, 165;",
          marker: { code: 0, end: "2026-10-20T10:42:00Z" },
        }),
      ),
    );
    const out = await runCli(["job", "42"], { registry });
    expect(out.stdout).toContain("state: finished");
    expect(out.stdout).not.toContain("gpu_");
  });

  it("E134: no sample, [N/A] utilisation or garbage gives no gpu keys and no error", async () => {
    for (const gpu of [
      undefined,
      "[N/A], [N/A];",
      "[Not Supported], 5;",
      "x",
    ]) {
      const out = await running(gpu === undefined ? {} : { gpu }, 12);
      expect(out.exitCode, String(gpu)).toBe(0);
      expect(out.stdout).toContain("state: running");
      expect(out.stdout).not.toContain("gpu_");
    }
  });

  it("E134: N/A memory is null and totals the known GPUs", () => {
    expect(parseGpuSample("10, [N/A];")).toEqual({
      util: [10],
      memMib: [null],
    });
    expect(parseGpuSample("10, N/A;20, 100;")).toEqual({
      util: [10, 20],
      memMib: [null, 100],
    });
    expect(parseGpuSample("10, 5;oops;")).toBeUndefined();
    expect(parseGpuSample("")).toBeUndefined();
  });

  it("E134: all-N/A memory prints gpu_mem_mib null", async () => {
    const out = await running({ gpu: "0, [N/A];" }, 12);
    expect(out.stdout).toContain("gpu_mem_mib: null");
    expect(out.stdout).toContain("(now 0%)");
  });

  it("E135: the onstart job is never warned about", async () => {
    const out = await running({ name: "onstart", gpu: "0, 165;" }, 12);
    expect(out.stdout).toContain("gpu_util_live: 0");
    expect(out.stdout).not.toContain("gpu_warning");
    expect(out.stdout).not.toContain("nvidia-smi");
  });

  it("E135: the probe samples the GPU for one job but not for --list", () => {
    const one = buildProbeScript({ kind: "name", name: "main" }, 20);
    expect(one).toContain("nvidia-smi");
    expect(one).toContain("--query-gpu=utilization.gpu,memory.used");
    expect(one).toContain("timeout 10");
    // the sample is guarded by the tail size, which is 0 for --list
    expect(one).toContain('[ "$n" -gt 0 ] && command -v nvidia-smi');
    expect(buildProbeScript({ kind: "all" }, 0)).toContain(
      'vaxi_probe_job "$d" 0',
    );
  });

  it("the probe parser stores the sample on the record", () => {
    const r = parseProbeOutput(record({ gpu: "3, 100;7, 200;" }));
    const rec = (r as { jobs: JobRecord[] }).jobs[0]!;
    expect(rec.gpu).toEqual({ util: [3, 7], memMib: [100, 200] });
  });
});

describe("FR3 as_of", () => {
  it("E136: the remote clock decides elapsed and as_of, not the local one", async () => {
    const registry = jobRegistry(() =>
      ok(
        record({
          alive: true,
          start: "2026-10-20T02:50:00Z",
          now: "2026-10-20T02:55:10Z",
        }),
      ),
    );
    const out = await runCli(["job", "42"], { registry });
    expect(out.stdout).toContain("elapsed: 5m");
    expect(out.stdout).toContain('as_of: "2026-10-20T02:55:10Z"');
    expect(out.stdout.indexOf("as_of:")).toBeGreaterThan(
      out.stdout.indexOf("elapsed:"),
    );
  });
});

describe("FR3 fetch spec", () => {
  it("E137: a rewritten Windows path in --fetch is refused with the MSYS hint", () => {
    // The refusal applies on win32 or under MSYSTEM only (G11, E187/E188), so
    // pin the platform: this row must also pass on the ubuntu CI runner.
    const real = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      for (const spec of [
        "C:/Program Files/Git/workspace/out:./o",
        "out\\run;C:\\tmp",
        "D:\\x\\y:./o",
      ]) {
        let err: unknown;
        try {
          parseFetchSpec(spec);
        } catch (e) {
          err = e;
        }
        expect(JSON.stringify(err), spec).toMatch(/MSYS_NO_PATHCONV=1/);
        expect(JSON.stringify(err), spec).toMatch(/VALIDATION_ERROR/);
      }
    } finally {
      Object.defineProperty(process, "platform", { value: real });
    }
  });

  it("E137: a Windows drive in the local half still works", () => {
    expect(parseFetchSpec("out/m.pt:C:\\res\\m.pt").local).toBe(
      "C:\\res\\m.pt",
    );
  });
});

describe("FR3 N5", () => {
  it("a missing ssh tool is reported before any endpoint lookup", async () => {
    const command = job.createJobCommand({
      resolveTool: () => {
        throw new Error("ssh-missing-first");
      },
    });
    await expect(command(["42"])).rejects.toThrow("ssh-missing-first");
  });
});
