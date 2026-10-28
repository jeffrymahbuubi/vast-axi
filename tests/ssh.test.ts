import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { REGISTRY, type Registry } from "../src/commands/index.js";
import * as ssh from "../src/commands/ssh.js";
import {
  parseInstanceId,
  resolveEndpoint,
  type InstanceInfo,
} from "../src/endpoint.js";
import { AxiError } from "../src/errors.js";
import {
  requireTool,
  spawnTool,
  type ToolRun,
  type ToolSpawner,
} from "../src/transfer.js";
import { newCallLog, readCallLog, runCli } from "./helpers/run-cli.js";

interface SpawnCall {
  file: string;
  args: string[];
  capture: boolean;
}

/** A registry whose `ssh` uses a recording spawner instead of the real ssh. */
function sshRegistry(run: Partial<ToolRun> = {}): {
  registry: Registry;
  calls: SpawnCall[];
} {
  const calls: SpawnCall[] = [];
  const spawn: ToolSpawner = (file, args, opts) => {
    calls.push({ file, args, capture: opts.capture });
    return Promise.resolve({ exitCode: 0, stdout: "", stderr: "", ...run });
  };
  const command = ssh.createSshCommand({ spawn, resolveTool: () => "ssh" });
  return {
    calls,
    registry: {
      home: REGISTRY.home,
      commands: { ...REGISTRY.commands, ssh: { command, help: ssh.help } },
    },
  };
}

const route = (fixture: string) =>
  JSON.stringify({ "show instance": { fixture } });

describe("ssh", () => {
  it("prints the ssh command and exits 0 without spawning anything", async () => {
    const log = newCallLog();
    const { registry, calls } = sshRegistry();
    const out = await runCli(["ssh", "42"], {
      env: { FAKE_VASTAI_LOG: log },
      registry,
    });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("ssh -p 2222 root@1.2.3.4");
    expect(out.stdout).toContain("instance: #42");
    expect(calls).toEqual([]);
    expect(readCallLog(log).map((c) => c.tokens.slice(0, 2))).toEqual([
      ["show", "instance"],
    ]);
  });

  it("A5: a direct instance uses public_ipaddr and the mapped 22/tcp port", async () => {
    const out = await runCli(["ssh", "42"], {
      env: { FAKE_VASTAI_ROUTES: route("u6-instance-direct.json") },
    });
    expect(out.stdout).toContain("ssh -p 40022 root@198.51.100.7");
  });

  it("--json keeps the same structure", async () => {
    const out = await runCli(["ssh", "42", "--json"]);
    const body = JSON.parse(out.stdout) as Record<string, unknown>;
    expect(body["ssh"]).toBe("ssh -p 2222 root@1.2.3.4");
    expect(body["instance"]).toBe("#42");
  });

  it("a stopped instance is NOT_RUNNING with a status hint (exit 1)", async () => {
    const out = await runCli(["ssh", "42"], {
      env: { FAKE_VASTAI_ROUTES: route("u6-instance-stopped.json") },
    });
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("code: NOT_RUNNING");
    expect(out.stdout).toContain("vast-axi status 42");
  });

  it("a missing instance is NOT_FOUND", async () => {
    const out = await runCli(["ssh", "42"], {
      env: { FAKE_VASTAI_ROUTES: route("u6-instance-missing.json") },
    });
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("code: NOT_FOUND");
  });

  it("rejects a non-numeric id with exit 2", async () => {
    const out = await runCli(["ssh", "abc"]);
    expect(out.exitCode).toBe(2);
    expect(out.stdout).toContain("code: VALIDATION_ERROR");
  });

  it("--exec runs ssh with BatchMode and captures a remote command's output", async () => {
    const { registry, calls } = sshRegistry({
      stdout: "gpu ok\n",
      exitCode: 0,
    });
    const out = await runCli(
      ["ssh", "42", "--exec", "--", "nvidia-smi", "-L"],
      {
        registry,
      },
    );
    expect(out.exitCode).toBe(0);
    expect(calls).toEqual([
      {
        file: "ssh",
        args: [
          "-p",
          "2222",
          "-o",
          "StrictHostKeyChecking=accept-new",
          "-o",
          "BatchMode=yes",
          "root@1.2.3.4",
          "nvidia-smi",
          "-L",
        ],
        capture: true,
      },
    ]);
    expect(out.stdout).toContain("exit_code: 0");
    expect(out.stdout).toContain("gpu ok");
  });

  it("E25: --exec without a remote command is refused, never an interactive session", async () => {
    const { registry, calls } = sshRegistry();
    const out = await runCli(["ssh", "42", "--exec"], { registry });
    expect(out.exitCode).toBe(2);
    expect(out.stdout).toContain("code: VALIDATION_ERROR");
    expect(calls).toHaveLength(0);
  });

  it("ssh exit 255 is SSH_FAILED", async () => {
    const { registry } = sshRegistry({
      exitCode: 255,
      stderr: "Permission denied (publickey).",
    });
    const out = await runCli(["ssh", "42", "--exec", "--", "true"], {
      registry,
    });
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("code: SSH_FAILED");
    expect(out.stdout).toContain("Permission denied");
  });

  it("a remote command without --exec is a validation error", async () => {
    const out = await runCli(["ssh", "42", "--", "ls"]);
    expect(out.exitCode).toBe(2);
    expect(out.stdout).toContain("--exec");
  });

  it("E23: --exec without ssh on PATH reports TRANSFER_TOOL_MISSING", async () => {
    const empty = mkdtempSync(join(tmpdir(), "vast-axi-nopath-"));
    const out = await runCli(["ssh", "42", "--exec", "--", "true"], {
      env: { PATH: empty },
    });
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("code: TRANSFER_TOOL_MISSING");
  });

  it("E20: an unknown flag exits 2 and lists the valid flags", async () => {
    const out = await runCli(["ssh", "42", "--exce"]);
    expect(out.exitCode).toBe(2);
    expect(out.stdout).toContain("--exec");
  });

  it("has --help", async () => {
    const out = await runCli(["ssh", "--help"]);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("usage: vast-axi ssh");
  });
});

describe("endpoint helper", () => {
  const base: InstanceInfo = {
    ssh_host: "ssh4.vast.ai",
    ssh_port: 11111,
    public_ipaddr: "203.0.113.5",
  };

  it("uses the proxy pair when no 22/tcp mapping exists", () => {
    expect(resolveEndpoint(base)).toEqual({
      host: "ssh4.vast.ai",
      port: 11111,
    });
  });

  it("prefers public_ipaddr and the 22/tcp host port when mapped", () => {
    const inst = { ...base, ports: { "22/tcp": [{ HostPort: "40022" }] } };
    expect(resolveEndpoint(inst)).toEqual({ host: "203.0.113.5", port: 40022 });
  });

  it("adds 1 to the proxy port for jupyter runtypes", () => {
    const inst = { ...base, image_runtype: "jupyter_direc ssh_proxy" };
    expect(resolveEndpoint(inst)).toEqual({
      host: "ssh4.vast.ai",
      port: 11112,
    });
  });

  it("returns undefined without a usable pair", () => {
    expect(resolveEndpoint({ ssh_host: "x" })).toBeUndefined();
    expect(resolveEndpoint({ ssh_port: 22 })).toBeUndefined();
  });

  it("parseInstanceId accepts digits only", () => {
    expect(parseInstanceId("42")).toBe(42);
    for (const bad of ["0", "-1", "4.2", "C.42", ""]) {
      expect(() => parseInstanceId(bad)).toThrow();
    }
  });
});

describe("E110: batch shims on Windows", () => {
  const onWindows = process.platform === "win32";

  /** Run `fn` with PATH set to `dirs`, restoring the old PATH afterwards. */
  function withPath<T>(dirs: string[], fn: () => T): T {
    const saved = process.env["PATH"];
    process.env["PATH"] = dirs.join(delimiter);
    try {
      return fn();
    } finally {
      process.env["PATH"] = saved;
    }
  }

  function dirWith(file: string): string {
    const dir = mkdtempSync(join(tmpdir(), "vast-axi-shim-"));
    writeFileSync(join(dir, file), "@echo off\r\n");
    return dir;
  }

  it.runIf(onWindows)(
    "E110: an ssh.cmd shim ahead of ssh.exe on PATH is skipped",
    () => {
      const shimDir = dirWith("ssh.cmd");
      const exeDir = dirWith("ssh.exe");
      const found = withPath([shimDir, exeDir], () => requireTool("ssh"));
      expect(found?.toLowerCase()).toBe(join(exeDir, "ssh.exe").toLowerCase());
    },
  );

  it.runIf(onWindows)(
    "E110: only an ssh.cmd shim on PATH reports TRANSFER_TOOL_MISSING naming the shim",
    () => {
      const shimDir = dirWith("ssh.cmd");
      let caught: unknown;
      withPath([shimDir], () => {
        try {
          requireTool("ssh");
        } catch (error) {
          caught = error;
        }
      });
      expect(caught).toBeInstanceOf(AxiError);
      expect((caught as AxiError).code).toBe("TRANSFER_TOOL_MISSING");
      expect((caught as AxiError).message).toContain("batch shim");
    },
  );

  it.runIf(onWindows)(
    "E110: spawning a .cmd directly maps EINVAL to TRANSFER_TOOL_MISSING",
    async () => {
      const shim = join(dirWith("ssh.cmd"), "ssh.cmd");
      await expect(
        spawnTool(shim, [], { capture: true }),
      ).rejects.toMatchObject({ code: "TRANSFER_TOOL_MISSING" });
    },
  );
});
