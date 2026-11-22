import * as childProcess from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  INSTANCE,
  NOW,
  dailyJob,
  jobsRoute,
  routes,
  withBurn,
} from "./helpers/max-hours-world.js";
import { fakeEnv, runCli } from "./helpers/run-cli.js";
import { GUARD_MARK, makeGuard } from "./helpers/ssh-guard.js";

// Own guard over vi.fn() fakes: nothing here can start a process, and the
// global guard in no-real-ssh.ts records nothing.
function fakeReal() {
  const execFile = vi.fn(() => "execFile-result") as ReturnType<typeof vi.fn> &
    Record<symbol, unknown>;
  execFile[promisify.custom] = vi.fn(() =>
    Promise.resolve({ stdout: "out", stderr: "err" }),
  );
  return {
    spawn: vi.fn(() => "spawn-result"),
    spawnSync: vi.fn(() => "spawnSync-result"),
    execFile,
    execFileSync: vi.fn(() => "execFileSync-result"),
    exec: vi.fn(() => "exec-result"),
    execSync: vi.fn(() => "execSync-result"),
  };
}

describe("no-real-ssh guard", () => {
  it("E191: spawn, spawnSync, execFile and execFileSync of ssh/scp are blocked and recorded", () => {
    const real = fakeReal();
    const g = makeGuard(real);
    const files = ["Z:/nope/ssh.exe", "SSH.EXE", "scp.com", "ssh"];
    const fns = [g.spawn, g.spawnSync, g.execFile, g.execFileSync];
    for (const fn of fns) {
      for (const file of files) expect(() => fn(file, [])).toThrow(/real/);
    }
    expect(g.attempts).toHaveLength(fns.length * files.length);
    for (const fn of Object.values(real)) expect(fn).not.toHaveBeenCalled();
    expect(() => g.check()).toThrow(/started the real ssh\/scp/);
    expect(() => g.check()).not.toThrow();
  });

  it("E192: exec('ssh -V') is blocked; execFile('node') and spawn('sshd-keygen') pass through", () => {
    const real = fakeReal();
    const g = makeGuard(real);
    expect(() => g.exec("ssh -V")).toThrow(/real/);
    expect(() => g.execSync('"C:\\Git\\scp.exe" a b')).toThrow(/real/);
    expect(g.execFile("node", ["-v"])).toBe("execFile-result");
    expect(g.spawn("sshd-keygen", [])).toBe("spawn-result");
    expect(real.execFile).toHaveBeenCalledWith("node", ["-v"]);
    expect(real.spawn).toHaveBeenCalledWith("sshd-keygen", []);
    expect(real.exec).not.toHaveBeenCalled();
    expect(g.attempts).toHaveLength(2);
    expect(() => g.check()).toThrow();
  });

  it("E193: promisify(execFile) on an allowed command resolves with { stdout, stderr }", async () => {
    const real = fakeReal();
    const g = makeGuard(real);
    await expect(promisify(g.execFile)("node", ["-v"])).resolves.toEqual({
      stdout: "out",
      stderr: "err",
    });
    await expect(promisify(g.execFile)("ssh", [])).rejects.toThrow(/real/);
    expect(g.attempts).toEqual(["ssh"]);
    expect(() => g.check()).toThrow();
  });

  it("E191: the setup file is wired, the imported spawn carries the guard marker", () => {
    const marked = (fn: unknown) => (fn as Record<symbol, unknown>)[GUARD_MARK];
    expect(marked(childProcess.spawn)).toBe(true);
    expect(marked(childProcess.default.spawn)).toBe(true);
  });
});

describe("fakeEnv REST default (I12)", () => {
  it("E194: fakeEnv points VAST_AXI_API_URL at dead loopback unless a test passes its own", () => {
    expect(fakeEnv()["VAST_AXI_API_URL"]).toBe("http://127.0.0.1:1");
    expect(fakeEnv({ VAST_AXI_API_URL: undefined })["VAST_AXI_API_URL"]).toBe(
      "http://127.0.0.1:1",
    );
    expect(
      fakeEnv({ VAST_AXI_API_URL: "http://127.0.0.1:4000" })[
        "VAST_AXI_API_URL"
      ],
    ).toBe("http://127.0.0.1:4000");
  });

  it("E194: timer --max-hours with no fake server fails on loopback, never reaching vast.ai", async () => {
    const out = await runCli(
      ["timer", String(INSTANCE), "--max-hours", "3", "--json"],
      {
        env: {
          ...withBurn,
          VAST_AXI_NOW: NOW,
          ...routes(jobsRoute([dailyJob(5081, 4)])),
        },
      },
    );
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("TIMER_FAILED");
    expect(out.stdout).not.toContain("console.vast.ai");
  });
});
