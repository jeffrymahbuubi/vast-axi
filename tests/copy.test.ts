import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as copy from "../src/commands/copy.js";
import { REGISTRY, type Registry } from "../src/commands/index.js";
import {
  assertSafeDestination,
  buildScpArgs,
  parseLocation,
  quoteArg,
  renderCommand,
  type ToolRun,
  type ToolSpawner,
} from "../src/transfer.js";
import { newCallLog, readCallLog, runCli } from "./helpers/run-cli.js";

interface SpawnCall {
  file: string;
  args: string[];
  capture: boolean;
}

/** A registry whose `copy` records the scp it would start instead of starting it. */
function copyRegistry(run: Partial<ToolRun> = {}): {
  registry: Registry;
  spawned: SpawnCall[];
} {
  const spawned: SpawnCall[] = [];
  const spawn: ToolSpawner = (file, args, opts) => {
    spawned.push({ file, args, capture: opts.capture });
    return Promise.resolve({ exitCode: 0, stdout: "", stderr: "", ...run });
  };
  const command = copy.createCopyCommand({ spawn, resolveTool: () => "scp" });
  return {
    spawned,
    registry: {
      home: REGISTRY.home,
      commands: { ...REGISTRY.commands, copy: { command, help: copy.help } },
    },
  };
}

const SCP_OPTS = [
  "-o",
  "StrictHostKeyChecking=accept-new",
  "-o",
  "BatchMode=yes",
  "-r",
];

describe("copy local <-> instance (scp)", () => {
  it("uploads: scp -P <port> accept-new -r <local> root@<host>:<path>", async () => {
    const { registry, spawned } = copyRegistry();
    const out = await runCli(["copy", "local:./data", "C.42:/workspace/data"], {
      registry,
    });
    expect(out.exitCode).toBe(0);
    expect(spawned).toEqual([
      {
        file: "scp",
        args: [
          "-P",
          "2222",
          ...SCP_OPTS,
          "./data",
          "root@1.2.3.4:/workspace/data",
        ],
        capture: true,
      },
    ]);
    expect(out.stdout).toContain(
      "scp -P 2222 -o StrictHostKeyChecking=accept-new",
    );
  });

  it("downloads: the remote side comes first", async () => {
    const { registry, spawned } = copyRegistry();
    const out = await runCli(["copy", "C.42:/workspace/out", "local:./out"], {
      registry,
    });
    expect(out.exitCode).toBe(0);
    expect(spawned[0]!.args.slice(-2)).toEqual([
      "root@1.2.3.4:/workspace/out",
      "./out",
    ]);
  });

  it("accepts the legacy `<id>:<path>` form and a bare local path", async () => {
    const { registry, spawned } = copyRegistry();
    await runCli(["copy", "notes.txt", "42:/workspace/notes.txt"], {
      registry,
    });
    expect(spawned[0]!.args.slice(-2)).toEqual([
      "notes.txt",
      "root@1.2.3.4:/workspace/notes.txt",
    ]);
  });

  it("A5: a direct instance is reached at public_ipaddr and the mapped port", async () => {
    const { registry, spawned } = copyRegistry();
    await runCli(["copy", "local:x", "C.42:/workspace/x"], {
      registry,
      env: {
        FAKE_VASTAI_ROUTES: JSON.stringify({
          "show instance": { fixture: "u6-instance-direct.json" },
        }),
      },
    });
    expect(spawned[0]!.args.slice(0, 2)).toEqual(["-P", "40022"]);
    expect(spawned[0]!.args.at(-1)).toBe("root@198.51.100.7:/workspace/x");
  });

  it("E22: a path with spaces reaches scp as one argument, with no shell involved", async () => {
    const { registry, spawned } = copyRegistry();
    const out = await runCli(
      ["copy", "local:./my data/file name.txt", "C.42:/workspace/my data/"],
      { registry },
    );
    expect(out.exitCode).toBe(0);
    expect(spawned[0]!.args.slice(-2)).toEqual([
      "./my data/file name.txt",
      "root@1.2.3.4:/workspace/my data/",
    ]);
  });

  it("E22: the displayed command quotes spaces for Git Bash and PowerShell", () => {
    const args = buildScpArgs(
      "up",
      { host: "1.2.3.4", port: 2222 },
      "./my data/it's.txt",
      "/workspace/a b",
    );
    expect(renderCommand("scp", args, "posix")).toContain(
      `'./my data/it'\\''s.txt' 'root@1.2.3.4:/workspace/a b'`,
    );
    expect(renderCommand("scp", args, "powershell")).toContain(
      `'./my data/it''s.txt' 'root@1.2.3.4:/workspace/a b'`,
    );
    expect(quoteArg("plain-file_1.txt", "posix")).toBe("plain-file_1.txt");
    expect(quoteArg("", "posix")).toBe("''");
    expect(quoteArg("a$b", "powershell")).toBe("'a$b'");
  });

  it("keeps a Windows drive path local and protects a relative path containing a colon", async () => {
    expect(parseLocation("C:\\Users\\me\\data")).toEqual({
      kind: "local",
      path: "C:\\Users\\me\\data",
    });
    expect(
      buildScpArgs("up", { host: "h", port: 1 }, "C:\\d", "/w").at(-2),
    ).toBe("C:\\d");
    expect(buildScpArgs("up", { host: "h", port: 1 }, "a:b", "/w").at(-2)).toBe(
      "./a:b",
    );
  });

  it("a failing scp is TRANSFER_FAILED with scp's message (exit 1)", async () => {
    const { registry } = copyRegistry({
      exitCode: 1,
      stderr: "scp: /workspace/x: No such file or directory",
    });
    const out = await runCli(["copy", "local:x", "C.42:/workspace/x"], {
      registry,
    });
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("code: TRANSFER_FAILED");
    expect(out.stdout).toContain("No such file or directory");
  });

  it("a stopped instance cannot be copied to (NOT_RUNNING), and scp never starts", async () => {
    const { registry, spawned } = copyRegistry();
    const out = await runCli(["copy", "local:x", "C.42:/workspace/x"], {
      registry,
      env: {
        FAKE_VASTAI_ROUTES: JSON.stringify({
          "show instance": { fixture: "u6-instance-stopped.json" },
        }),
      },
    });
    expect(out.stdout).toContain("code: NOT_RUNNING");
    expect(spawned).toEqual([]);
  });

  it("never starts rsync", async () => {
    const { registry, spawned } = copyRegistry();
    await runCli(["copy", "local:x", "C.42:/workspace/x"], { registry });
    await runCli(["copy", "C.42:/a", "C.43:/b"], { registry });
    expect(spawned.every((s) => s.file === "scp")).toBe(true);
  });

  it("E23: with scp missing from PATH, copy reports TRANSFER_TOOL_MISSING before any vastai call", async () => {
    const log = newCallLog();
    const out = await runCli(["copy", "local:x", "C.42:/workspace/x"], {
      env: {
        PATH: mkdtempSync(join(tmpdir(), "vast-axi-nopath-")),
        FAKE_VASTAI_LOG: log,
      },
    });
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("code: TRANSFER_TOOL_MISSING");
    expect(out.stdout).toMatch(/OpenSSH/i);
    expect(readCallLog(log)).toEqual([]);
  });
});

describe("copy destinations", () => {
  it.each([
    "/",
    "/root",
    "/root/",
    "//",
    "/root/.",
    "/tmp/../root",
    "",
    "~",
    "~/",
    ".",
  ])("rejects C.42:%j as a destination and starts nothing", async (path) => {
    const log = newCallLog();
    const { registry, spawned } = copyRegistry();
    const out = await runCli(["copy", "local:x", `C.42:${path}`], {
      registry,
      env: { FAKE_VASTAI_LOG: log },
    });
    expect(out.exitCode).toBe(2);
    expect(out.stdout).toContain("code: VALIDATION_ERROR");
    expect(spawned).toEqual([]);
    expect(readCallLog(log)).toEqual([]);
  });

  it("rejects /root for a remote-to-remote copy as well", async () => {
    const log = newCallLog();
    const out = await runCli(["copy", "C.42:/a", "C.43:/root"], {
      env: { FAKE_VASTAI_LOG: log },
    });
    expect(out.exitCode).toBe(2);
    expect(readCallLog(log)).toEqual([]);
  });

  it("allows subdirectories of /root and /workspace", () => {
    for (const ok of ["/root/data", "/workspace", "/rootx", "data", "~/data"]) {
      expect(() => assertSafeDestination(ok)).not.toThrow();
    }
  });
});

describe("copy remote <-> remote (passthrough)", () => {
  it("E24: passes `copy C.42:/a C.43:/b` to vastai unchanged, with no scp and no rsync", async () => {
    const log = newCallLog();
    const empty = mkdtempSync(join(tmpdir(), "vast-axi-nopath-"));
    const { registry, spawned } = copyRegistry();
    // PATH holds neither scp nor rsync: the passthrough must not need them.
    const out = await runCli(["copy", "C.42:/a", "C.43:/b"], {
      registry,
      env: { FAKE_VASTAI_LOG: log, PATH: empty },
    });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("remote-to-remote copy initiated");
    expect(spawned).toEqual([]);
    const calls = readCallLog(log);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.argv).toEqual([
      "--raw",
      "--retry",
      "1",
      "copy",
      "C.42:/a",
      "C.43:/b",
    ]);
  });

  it("passes an instance <-> cloud locator through as well", async () => {
    const log = newCallLog();
    const out = await runCli(["copy", "s3.101:/data/", "C.42:/workspace/"], {
      env: { FAKE_VASTAI_LOG: log },
    });
    expect(out.exitCode).toBe(0);
    expect(readCallLog(log)[0]!.argv.slice(3)).toEqual([
      "copy",
      "s3.101:/data/",
      "C.42:/workspace/",
    ]);
  });

  it("does not report success when upstream refuses (exit 0 with a message)", async () => {
    const out = await runCli(["copy", "C.42:/a", "C.43:/b"], {
      env: {
        FAKE_VASTAI_ROUTES: JSON.stringify({
          copy: {
            stdout: "copying C.42:/a C.43:/b\nsrc_path not supported VMs.\n",
          },
        }),
      },
    });
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("code: UPSTREAM_ERROR");
  });

  it("a local leg with a cloud locator is refused rather than handed to rsync", async () => {
    const log = newCallLog();
    const out = await runCli(["copy", "local:x", "s3.101:/y"], {
      env: { FAKE_VASTAI_LOG: log },
    });
    expect(out.exitCode).toBe(2);
    expect(readCallLog(log)).toEqual([]);
  });

  it("two local sides are refused", async () => {
    const out = await runCli(["copy", "local:a", "b"]);
    expect(out.exitCode).toBe(2);
  });
});

describe("copy arguments", () => {
  it("needs both sides and rejects extras", async () => {
    expect((await runCli(["copy", "local:x"])).exitCode).toBe(2);
    expect((await runCli(["copy", "a", "C.1:/b", "c"])).exitCode).toBe(2);
  });

  it("E20: an unknown flag exits 2", async () => {
    const out = await runCli(["copy", "local:x", "C.42:/w", "--rsync"]);
    expect(out.exitCode).toBe(2);
    expect(out.stdout).toContain("valid flags for copy: --allow-secrets");
  });

  it("has --help", async () => {
    const out = await runCli(["copy", "--help"]);
    expect(out.stdout).toContain("usage: vast-axi copy");
  });

  it("parses locations", () => {
    expect(parseLocation("C.42:/a:b")).toEqual({
      kind: "instance",
      id: 42,
      path: "/a:b",
    });
    expect(parseLocation("42:/a")).toEqual({
      kind: "instance",
      id: 42,
      path: "/a",
    });
    expect(parseLocation("local:rel/x")).toEqual({
      kind: "local",
      path: "rel/x",
    });
    expect(parseLocation("drive:/f")).toEqual({
      kind: "other",
      raw: "drive:/f",
    });
    expect(parseLocation("V.12:/f")).toEqual({ kind: "other", raw: "V.12:/f" });
    expect(parseLocation("plain.txt")).toEqual({
      kind: "local",
      path: "plain.txt",
    });
  });
});
