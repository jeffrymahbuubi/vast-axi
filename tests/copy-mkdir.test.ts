import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as copy from "../src/commands/copy.js";
import { REGISTRY, type Registry } from "../src/commands/index.js";
import type { ToolRun, ToolSpawner } from "../src/transfer.js";
import { newCallLog, readCallLog, runCli } from "./helpers/run-cli.js";

const SRC = join(mkdtempSync(join(tmpdir(), "vast-axi-mkdir-src-")), "job");
writeFileSync(SRC, "x");

interface Call {
  file: string;
  args: string[];
}

/** Records every ssh and scp start; `ssh`/`scp` set the answer per tool. */
function world(
  answers: { ssh?: Partial<ToolRun>; scp?: Partial<ToolRun> } = {},
) {
  const calls: Call[] = [];
  const spawn: ToolSpawner = (file, args) => {
    calls.push({ file, args });
    const extra = file === "ssh" ? answers.ssh : answers.scp;
    return Promise.resolve({ exitCode: 0, stdout: "", stderr: "", ...extra });
  };
  const command = copy.createCopyCommand({ spawn, resolveTool: (n) => n });
  const registry: Registry = {
    home: REGISTRY.home,
    commands: { ...REGISTRY.commands, copy: { command, help: copy.help } },
  };
  return { calls, registry };
}

const up = (dest: string) => ["copy", `local:${SRC}`, `C.42:${dest}`];

describe("copy uploads create the destination parent", () => {
  it("E122: upload to /workspace/job runs ssh mkdir -p -- /workspace, then scp", async () => {
    const { calls, registry } = world();
    const out = await runCli(up("/workspace/job"), { registry });
    expect(out.exitCode).toBe(0);
    expect(calls.map((c) => c.file)).toEqual(["ssh", "scp"]);
    expect(calls[0]!.args.slice(-2)).toEqual([
      "root@1.2.3.4",
      "mkdir -p -- '/workspace'",
    ]);
    expect(out.stdout).toContain("ensured_dir: /workspace");
  });

  it("E123: a dest ending in / is created itself; /data needs no mkdir", async () => {
    const a = world();
    const outA = await runCli(up("/workspace/out/"), { registry: a.registry });
    expect(outA.exitCode).toBe(0);
    expect(a.calls[0]!.args.at(-1)).toBe("mkdir -p -- '/workspace/out/'");
    expect(outA.stdout).toContain("ensured_dir: /workspace/out/");

    const b = world();
    const outB = await runCli(up("/data"), { registry: b.registry });
    expect(outB.exitCode).toBe(0);
    expect(b.calls.map((c) => c.file)).toEqual(["scp"]);
    expect(outB.stdout).not.toContain("ensured_dir");
  });

  it("E124: a failing mkdir is REMOTE_PATH_MISSING (exit 1) and scp never starts", async () => {
    const { calls, registry } = world({
      ssh: {
        exitCode: 1,
        stderr: "mkdir: cannot create directory: Read-only file system",
      },
    });
    const out = await runCli(up("/ro/job"), { registry });
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("code: REMOTE_PATH_MISSING");
    expect(out.stdout).toContain("could not create /ro on #42");
    expect(out.stdout).toContain("Read-only file system");
    expect(calls.map((c) => c.file)).toEqual(["ssh"]);
  });

  it("E125: a download with a missing remote path is REMOTE_PATH_MISSING with the ls hint and no key hint", async () => {
    const { calls, registry } = world({
      scp: {
        exitCode: 1,
        stderr: "scp: /workspace/nope: No such file or directory",
      },
    });
    const out = await runCli(["copy", "C.42:/workspace/nope", "local:./o"], {
      registry,
    });
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("code: REMOTE_PATH_MISSING");
    expect(out.stdout).toContain("vast-axi ssh 42 --exec -- ls -la /workspace");
    expect(out.stdout).not.toContain("ssh key");
    expect(calls.map((c) => c.file)).toEqual(["scp"]);
  });

  it("E126: scp `Permission denied` keeps the key hint; `Connection refused` gets the wait hint and no key hint", async () => {
    const auth = world({
      scp: {
        exitCode: 255,
        stderr: "root@1.2.3.4: Permission denied (publickey).",
      },
    });
    const a = await runCli(up("/data"), { registry: auth.registry });
    expect(a.stdout).toContain("code: TRANSFER_FAILED");
    expect(a.stdout).toContain("ssh key attached on vast.ai");

    const down = world({
      scp: {
        exitCode: 255,
        stderr: "ssh: connect to host 1.2.3.4 port 2222: Connection refused",
      },
    });
    const b = await runCli(up("/data"), { registry: down.registry });
    expect(b.stdout).toContain("code: TRANSFER_FAILED");
    expect(b.stdout).toContain("vast-axi status 42 --wait");
    expect(b.stdout).not.toContain("ssh key attached");
  });

  it("E128: a dest parent with a space or a quote is one quoted argument", async () => {
    const { calls, registry } = world();
    await runCli(up("/work space/it's/job"), { registry });
    expect(calls[0]!.args.at(-1)).toBe(`mkdir -p -- '/work space/it'\\''s'`);
  });

  it("E129: a missing local source is exit 2 before any call", async () => {
    const log = newCallLog();
    const { calls, registry } = world();
    const out = await runCli(
      [
        "copy",
        `local:${join(tmpdir(), "vast-axi-no-such-source")}`,
        "C.42:/w/x",
      ],
      { registry, env: { FAKE_VASTAI_LOG: log } },
    );
    expect(out.exitCode).toBe(2);
    expect(out.stdout).toContain("code: VALIDATION_ERROR");
    expect(calls).toEqual([]);
    expect(readCallLog(log)).toEqual([]);
  });
});

describe("copy G7 and G8", () => {
  const down = (dest: string) => ["copy", "C.42:/workspace/out", dest];

  it("E175: download into a missing local directory is exit 2 with zero calls", async () => {
    const base = mkdtempSync(join(tmpdir(), "vast-axi-down-"));
    const { calls, registry } = world();
    const out = await runCli(down(join(base, "nope", "sub", "out")), {
      registry,
    });
    expect(out.exitCode).toBe(2);
    expect(out.stdout).toContain("code: VALIDATION_ERROR");
    expect(out.stdout).toContain("local directory not found");
    expect(out.stdout).toContain("sub");
    expect(out.stdout).not.toContain('out"');
    expect(calls).toEqual([]);
  });

  it("E176: download to a new name or an existing directory runs scp", async () => {
    const base = mkdtempSync(join(tmpdir(), "vast-axi-down-"));
    const a = world();
    const outA = await runCli(down(join(base, "newname")), {
      registry: a.registry,
    });
    expect(outA.exitCode).toBe(0);
    expect(a.calls.map((c) => c.file)).toEqual(["scp"]);
    const b = world();
    const outB = await runCli(down(base), { registry: b.registry });
    expect(outB.exitCode).toBe(0);
    expect(b.calls.map((c) => c.file)).toEqual(["scp"]);
  });

  it("E177: ~user/ upload is exit 2 before any call; ~/ works unquoted", async () => {
    const a = world();
    const outA = await runCli(up("~bob/x/y"), { registry: a.registry });
    expect(outA.exitCode).toBe(2);
    expect(outA.stdout).toContain("code: VALIDATION_ERROR");
    expect(outA.stdout).toContain("not supported");
    expect(a.calls).toEqual([]);

    const b = world();
    const outB = await runCli(up("~/x/y"), { registry: b.registry });
    expect(outB.exitCode).toBe(0);
    expect(b.calls[0]!.args.at(-1)).toBe("mkdir -p -- ~/'x'");
  });

  it("E178: scp 'No such file or directory' stays REMOTE_PATH_MISSING with the ls hint", async () => {
    const base = mkdtempSync(join(tmpdir(), "vast-axi-down-"));
    const { registry } = world({
      scp: {
        exitCode: 1,
        stderr: "scp: /workspace/out: No such file or directory",
      },
    });
    const out = await runCli(down(join(base, "out")), { registry });
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("code: REMOTE_PATH_MISSING");
    expect(out.stdout).toContain("ls -la /workspace");
  });
});
