import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REGISTRY, type Registry } from "../src/commands/index.js";
import * as update from "../src/commands/update.js";
import type { Exec, ExecResult } from "../src/commands/update.js";
import { runCli } from "./helpers/run-cli.js";

// spawnExec's real spawn is replaced so the spawn tests only see its arguments.
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawnMock,
}));

interface Call {
  file: string;
  args: string[];
  cwd?: string;
}

/** gh is scripted per subcommand (view / list / download); npm is one reply. */
interface Script {
  view?: Partial<ExecResult>;
  list?: Partial<ExecResult>;
  download?: Partial<ExecResult>;
  npm?: Partial<ExecResult>;
}

const ok = (stdout: string): Partial<ExecResult> => ({ exitCode: 0, stdout });
const ASSET = "vast-axi-0.2.0.tgz";
const release = (tag: string, assets: string[] = [ASSET]) =>
  ok(
    JSON.stringify({ tagName: tag, assets: assets.map((name) => ({ name })) }),
  );
const DIR = "/tmp/vast-axi-update-test";

/** An `update` command whose gh, npm and temp dir are fakes; nothing real ever runs. */
function updateRegistry(
  script: Script,
  version = "0.1.0",
): { registry: Registry; calls: Call[]; removed: string[] } {
  const calls: Call[] = [];
  const removed: string[] = [];
  const exec: Exec = (file, args, opts) => {
    calls.push({ file, args, ...(opts?.cwd ? { cwd: opts.cwd } : {}) });
    const key = file === "gh" ? (args[1] as keyof Script) : "npm";
    const reply = script[key] ?? { exitCode: 1 };
    return Promise.resolve({ exitCode: 0, stdout: "", stderr: "", ...reply });
  };
  const command = update.createUpdateCommand({
    exec,
    version,
    makeTempDir: () => Promise.resolve(DIR),
    removeDir: (dir) => {
      removed.push(dir);
      return Promise.resolve();
    },
  });
  return {
    calls,
    removed,
    registry: {
      home: REGISTRY.home,
      commands: {
        ...REGISTRY.commands,
        update: { command, help: update.help },
      },
    },
  };
}

const VIEW = [
  "release",
  "view",
  "--repo",
  "jeffrymahbuubi/vast-axi",
  "--json",
  "tagName,assets",
];
const DOWNLOAD = [
  "release",
  "download",
  "v0.2.0",
  "-R",
  "jeffrymahbuubi/vast-axi",
  "-p",
  "vast-axi-*.tgz",
  "-D",
  DIR,
  "--clobber",
];

describe("update (R18, KTD7)", () => {
  it("--check reports a newer release and the exact two commands, installing nothing", async () => {
    const { registry, calls, removed } = updateRegistry({
      view: release("v0.2.0"),
    });
    const out = await runCli(["update", "--check"], { registry });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("current: 0.1.0");
    expect(out.stdout).toContain("latest: 0.2.0");
    expect(out.stdout).toContain("available: true");
    expect(out.stdout).toContain(
      'download: "gh release download v0.2.0 -R jeffrymahbuubi/vast-axi -p \\"vast-axi-*.tgz\\" -D <dir> --clobber"',
    );
    expect(out.stdout).toContain(`install: npm i -g <dir>/${ASSET}`);
    expect(calls).toEqual([{ file: "gh", args: VIEW }]);
    expect(removed).toEqual([]);
  });

  it("--check when already latest reports available: false and no commands", async () => {
    const { registry } = updateRegistry({ view: release("v0.1.0") });
    const out = await runCli(["update", "--check"], { registry });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("available: false");
    expect(out.stdout).not.toContain("install:");
  });

  it("a release older than the running version is not an update", async () => {
    const { registry } = updateRegistry({ view: release("v0.0.9") });
    const out = await runCli(["update", "--check"], { registry });
    expect(out.stdout).toContain("available: false");
  });

  it("update downloads the tarball, installs it with npm, then removes the temp dir", async () => {
    const { registry, calls, removed } = updateRegistry({
      view: release("v0.2.0"),
      download: ok(""),
      npm: ok("added 1 package"),
    });
    const out = await runCli(["update"], { registry });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("status: installed");
    expect(out.stdout).toContain("installed: 0.2.0");
    expect(calls).toEqual([
      { file: "gh", args: VIEW },
      { file: "gh", args: DOWNLOAD },
      { file: "npm", args: ["i", "-g", `./${ASSET}`], cwd: DIR },
    ]);
    expect(removed).toEqual([DIR]);
  });

  it("update when already latest downloads nothing and makes no temp dir", async () => {
    const { registry, calls, removed } = updateRegistry({
      view: release("v0.1.0"),
    });
    const out = await runCli(["update"], { registry });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("available: false");
    expect(calls.map((c) => c.args[1])).toEqual(["view"]);
    expect(removed).toEqual([]);
  });

  it("--pre takes the newest release from gh release list, pre-releases included", async () => {
    const { registry, calls } = updateRegistry({
      list: ok(JSON.stringify([{ tagName: "v0.2.0" }])),
      view: release("v0.2.0"),
    });
    const out = await runCli(["update", "--check", "--pre"], { registry });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("latest: 0.2.0");
    expect(calls).toEqual([
      {
        file: "gh",
        args: [
          "release",
          "list",
          "--repo",
          "jeffrymahbuubi/vast-axi",
          "--exclude-drafts",
          "--limit",
          "1",
          "--json",
          "tagName",
        ],
      },
      {
        file: "gh",
        args: [
          "release",
          "view",
          "v0.2.0",
          "--repo",
          "jeffrymahbuubi/vast-axi",
          "--json",
          "tagName,assets",
        ],
      },
    ]);
  });

  it("--pre with no releases at all is NO_RELEASES", async () => {
    const { registry } = updateRegistry({ list: ok("[]") });
    const out = await runCli(["update", "--pre"], { registry });
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("code: NO_RELEASES");
  });

  it("a release without a vast-axi tgz asset is UPDATE_UNAVAILABLE naming the tag", async () => {
    const { registry, calls, removed } = updateRegistry({
      view: release("v0.2.0", ["notes.txt", "other-0.2.0.tgz"]),
    });
    const out = await runCli(["update"], { registry });
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("code: UPDATE_UNAVAILABLE");
    expect(out.stdout).toContain("v0.2.0");
    expect(calls.map((c) => c.args[1])).toEqual(["view"]);
    expect(removed).toEqual([]);
  });

  it("gh not logged in is UPDATE_UNAVAILABLE with a gh auth login hint", async () => {
    const { registry } = updateRegistry({
      view: {
        exitCode: 4,
        stderr:
          "To get started with GitHub CLI, please run:  gh auth login\nmore",
      },
    });
    const out = await runCli(["update", "--check"], { registry });
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("code: UPDATE_UNAVAILABLE");
    expect(out.stdout).toContain("gh auth login");
    expect(out.stdout).not.toContain("setup-git");
  });

  it("a rejected token (HTTP 401) also reads as not logged in", async () => {
    const { registry } = updateRegistry({
      view: { exitCode: 1, stderr: "HTTP 401: Bad credentials" },
    });
    const out = await runCli(["update", "--check"], { registry });
    expect(out.stdout).toContain("code: UPDATE_UNAVAILABLE");
  });

  it("a failing download is UPDATE_ERROR, installs nothing, and still removes the temp dir", async () => {
    const { registry, calls, removed } = updateRegistry({
      view: release("v0.2.0"),
      download: { exitCode: 1, stderr: "no assets match the file pattern" },
    });
    const out = await runCli(["update"], { registry });
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("code: UPDATE_ERROR");
    expect(out.stdout).toContain("no assets match");
    expect(calls.some((c) => c.file === "npm")).toBe(false);
    expect(removed).toEqual([DIR]);
  });

  it("a failing npm install is UPDATE_ERROR with the manual commands, and removes the temp dir", async () => {
    const { registry, removed } = updateRegistry({
      view: release("v0.2.0"),
      download: ok(""),
      npm: { exitCode: 1, stderr: "npm ERR! code EACCES\nmore" },
    });
    const out = await runCli(["update"], { registry });
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("code: UPDATE_ERROR");
    expect(out.stdout).toContain("npm ERR! code EACCES");
    expect(out.stdout).toContain(`npm i -g <dir>/${ASSET}`);
    expect(removed).toEqual([DIR]);
  });

  it("a missing npm is reported, not a crash", async () => {
    const { registry } = updateRegistry({
      view: release("v0.2.0"),
      download: ok(""),
      npm: { exitCode: 127, missing: true },
    });
    const out = await runCli(["update"], { registry });
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("npm is not installed");
  });

  it("a missing gh is GH_NOT_INSTALLED, not a crash", async () => {
    const { registry } = updateRegistry({
      view: { exitCode: 127, missing: true },
    });
    const out = await runCli(["update", "--check"], { registry });
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("code: GH_NOT_INSTALLED");
    expect(out.stdout).toContain("cli.github.com");
  });

  it("no releases yet is NO_RELEASES and points at --pre", async () => {
    const { registry } = updateRegistry({
      view: { exitCode: 1, stderr: "release not found" },
    });
    const out = await runCli(["update", "--check"], { registry });
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("code: NO_RELEASES");
    expect(out.stdout).toContain("--pre");
  });

  it("any other gh failure is UPDATE_ERROR pointing at gh auth status", async () => {
    const { registry } = updateRegistry({
      view: { exitCode: 1, stderr: "HTTP 502: Bad Gateway" },
    });
    const out = await runCli(["update", "--check"], { registry });
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("code: UPDATE_ERROR");
    expect(out.stdout).toContain("gh auth status");
  });

  it("refuses a tag that is not a plain version, so nothing odd reaches the shell", async () => {
    const { registry, calls } = updateRegistry({
      view: release("v1.0.0 && calc"),
    });
    const out = await runCli(["update"], { registry });
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("code: UPDATE_ERROR");
    expect(calls.map((c) => c.file)).toEqual(["gh"]);
  });

  it("ignores an asset whose name is not a plain vast-axi tarball", async () => {
    const { registry } = updateRegistry({
      view: release("v0.2.0", ["vast-axi-0.2.0 & calc.tgz"]),
    });
    const out = await runCli(["update", "--check"], { registry });
    expect(out.stdout).toContain("code: UPDATE_UNAVAILABLE");
  });

  it("garbage from gh is UPDATE_ERROR", async () => {
    const { registry } = updateRegistry({ view: ok("not json") });
    const out = await runCli(["update", "--check"], { registry });
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("code: UPDATE_ERROR");
  });

  it("E20: an unknown flag exits 2 listing --check and --pre, before gh is called", async () => {
    const { registry, calls } = updateRegistry({ view: release("v0.2.0") });
    const out = await runCli(["update", "--chek"], { registry });
    expect(out.exitCode).toBe(2);
    expect(out.stdout).toContain("unknown flag --chek");
    expect(out.stdout).toContain("--check");
    expect(out.stdout).toContain("--pre");
    expect(calls).toEqual([]);
  });

  it("an extra argument exits 2", async () => {
    const { registry } = updateRegistry({ view: release("v0.2.0") });
    const out = await runCli(["update", "now"], { registry });
    expect(out.exitCode).toBe(2);
  });

  it("is registered as a custom command that shadows the SDK built-in", async () => {
    const out = await runCli(["update", "--help"]);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("gh auth login");
    expect(out.stdout).toContain("--pre");
    expect(out.stdout).not.toContain("setup-git");
    expect(out.stdout).not.toContain("npm version");
  });
});

/** A child process that exits 0 on the next tick, like a finished `npm i -g`. */
function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: Object.assign(new EventEmitter(), { end: () => {} }),
  });
  setImmediate(() => child.emit("close", 0));
  return child;
}

describe("update: running npm without a shell (DEP0190)", () => {
  const npmArgs = ["i", "-g", `./${ASSET}`];
  const realPlatform = Object.getOwnPropertyDescriptor(process, "platform");

  afterEach(() => {
    spawnMock.mockReset();
    if (realPlatform) Object.defineProperty(process, "platform", realPlatform);
  });

  async function spawnedOn(platform: NodeJS.Platform, file: string) {
    Object.defineProperty(process, "platform", { value: platform });
    spawnMock.mockImplementation(() => fakeChild());
    const result = await update.spawnExec(file, npmArgs, { cwd: DIR });
    expect(result.exitCode).toBe(0);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [spawnFile, spawnArgs, options] = spawnMock.mock.calls[0] as [
      string,
      string[],
      { shell?: unknown; cwd?: string },
    ];
    return { spawnFile, spawnArgs, options };
  }

  it("launchSpec runs npm through cmd.exe /d /s /c npm.cmd on win32", () => {
    expect(update.launchSpec("npm", npmArgs, "win32")).toEqual({
      file: "cmd.exe",
      args: ["/d", "/s", "/c", "npm.cmd", ...npmArgs],
    });
  });

  it("launchSpec runs npm directly elsewhere, and gh directly everywhere", () => {
    for (const platform of ["linux", "darwin"] as const) {
      expect(update.launchSpec("npm", npmArgs, platform)).toEqual({
        file: "npm",
        args: npmArgs,
      });
    }
    expect(update.launchSpec("gh", ["release", "view"], "win32")).toEqual({
      file: "gh",
      args: ["release", "view"],
    });
  });

  it("spawns cmd.exe with the exact argv on win32, shell never true, temp dir only as cwd", async () => {
    const { spawnFile, spawnArgs, options } = await spawnedOn("win32", "npm");
    expect(spawnFile).toBe("cmd.exe");
    expect(spawnArgs).toEqual(["/d", "/s", "/c", "npm.cmd", ...npmArgs]);
    expect(options.shell).toBe(false);
    expect(options.cwd).toBe(DIR);
    expect(spawnArgs.join(" ")).not.toContain(DIR);
  });

  it("spawns npm directly on non-win32, shell never true", async () => {
    const { spawnFile, spawnArgs, options } = await spawnedOn("linux", "npm");
    expect(spawnFile).toBe("npm");
    expect(spawnArgs).toEqual(npmArgs);
    expect(options.shell).toBe(false);
  });

  it("spawns gh directly with shell never true on win32 too", async () => {
    const { spawnFile, spawnArgs, options } = await spawnedOn("win32", "gh");
    expect(spawnFile).toBe("gh");
    expect(spawnArgs).toEqual(npmArgs);
    expect(options.shell).toBe(false);
  });
});
