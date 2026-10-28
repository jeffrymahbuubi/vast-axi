import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REGISTRY, type Registry } from "../src/commands/index.js";
import * as setup from "../src/commands/setup.js";
import type { RawExec, VastRunner } from "../src/vastai.js";
import { newCallLog, readCallLog, runCli } from "./helpers/run-cli.js";

const SECRET = "abc123secretkey";

function tempHome(): { homeDir: string; execPath: string } {
  const homeDir = mkdtempSync(join(tmpdir(), "vast-axi-setup-"));
  return {
    homeDir,
    // Looks like the installed entrypoint; it does not need to exist.
    execPath: join(
      homeDir,
      "node_modules",
      "vast-axi",
      "dist",
      "bin",
      "vast-axi.js",
    ),
  };
}

function registryWith(deps: setup.SetupDeps): Registry {
  return {
    home: REGISTRY.home,
    commands: {
      ...REGISTRY.commands,
      setup: { command: setup.createSetupCommand(deps), help: setup.help },
    },
  };
}

/** A runner that records argv and answers with `reply`; vastai never starts. */
function recordingRunner(reply: Partial<RawExec> = {}): {
  runner: VastRunner;
  argvs: string[][];
} {
  const argvs: string[][] = [];
  const runner: VastRunner = (argv) => {
    argvs.push(argv);
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0, ...reply });
  };
  return { runner, argvs };
}

const claudeSettings = (homeDir: string) =>
  join(homeDir, ".claude", "settings.json");

function managedEntries(path: string): number {
  const settings = JSON.parse(readFileSync(path, "utf8")) as {
    hooks: { SessionStart: { hooks: { command: string }[] }[] };
  };
  return settings.hooks.SessionStart.flatMap((g) => g.hooks).filter((h) =>
    h.command.includes("vast-axi"),
  ).length;
}

describe("setup: dispatch", () => {
  it("an unknown action exits 2 naming hooks and key, without echoing the token", async () => {
    const out = await runCli(["setup", "frobnicate"]);
    expect(out.exitCode).toBe(2);
    expect(out.stdout).toContain("code: VALIDATION_ERROR");
    expect(out.stdout).toContain("`hooks`");
    expect(out.stdout).toContain("`key`");
    expect(out.stdout).not.toContain("frobnicate");
  });

  it("no action exits 2", async () => {
    const out = await runCli(["setup"]);
    expect(out.exitCode).toBe(2);
    expect(out.stdout).toContain("hooks");
  });

  it("E20: a flag in the action slot lists the valid flags", async () => {
    const out = await runCli(["setup", "--bogus"]);
    expect(out.exitCode).toBe(2);
    expect(out.stdout).toContain("unknown flag --bogus");
    const hooks = await runCli(["setup", "hooks", "--bogus"]);
    expect(hooks.exitCode).toBe(2);
    expect(hooks.stdout).toContain("unknown flag --bogus");
  });

  it("`setup --help` lists both actions", async () => {
    const out = await runCli(["setup", "--help"]);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("hooks");
    expect(out.stdout).toContain("key <key>");
  });
});

describe("setup hooks (R17, OQ4)", () => {
  it("writes the Claude SessionStart entry under a temp home, once, and is idempotent", async () => {
    const realSettings = join(homedir(), ".claude", "settings.json");
    const before = existsSync(realSettings)
      ? statSync(realSettings).mtimeMs
      : null;
    const home = tempHome();
    const registry = registryWith(home);

    const first = await runCli(["setup", "hooks"], { registry });
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain("status: installed");
    expect(first.stdout).toContain("Claude Code");
    const path = claudeSettings(home.homeDir);
    expect(managedEntries(path)).toBe(1);
    const written = readFileSync(path, "utf8");

    const second = await runCli(["setup", "hooks"], { registry });
    expect(second.exitCode).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(written);
    expect(managedEntries(path)).toBe(1);

    const after = existsSync(realSettings)
      ? statSync(realSettings).mtimeMs
      : null;
    expect(after).toBe(before);
  });

  it("run from a dev checkout (a .ts entrypoint) writes nothing and says why", async () => {
    const home = tempHome();
    const registry = registryWith({
      homeDir: home.homeDir,
      execPath: join(home.homeDir, "bin", "vast-axi.ts"),
    });
    const out = await runCli(["setup", "hooks"], { registry });
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("code: HOOKS_NOT_INSTALLED");
    expect(out.stdout).toContain("installed binary");
    expect(existsSync(claudeSettings(home.homeDir))).toBe(false);
  });

  it("takes no arguments", async () => {
    const home = tempHome();
    const out = await runCli(["setup", "hooks", "extra"], {
      registry: registryWith(home),
    });
    expect(out.exitCode).toBe(2);
    expect(existsSync(claudeSettings(home.homeDir))).toBe(false);
  });
});

describe("setup key (R16, R17)", () => {
  it("forwards the key to `vastai set api-key` and never prints it", async () => {
    const { runner, argvs } = recordingRunner({
      stdout: `saved ${SECRET}\n`,
      stderr: `note: ${SECRET}\n`,
    });
    const out = await runCli(["setup", "key", SECRET], {
      registry: registryWith({ runner }),
    });
    expect(out.exitCode).toBe(0);
    expect(argvs).toEqual([
      ["--raw", "--retry", "1", "set", "api-key", SECRET],
    ]);
    expect(out.stdout).toContain("status: saved");
    expect(out.stdout).not.toContain(SECRET);
    const json = await runCli(["setup", "key", SECRET, "--json"], {
      registry: registryWith({ runner }),
    });
    expect(json.stdout).not.toContain(SECRET);
  });

  it("a failing vastai never echoes the key in the error", async () => {
    const { runner } = recordingRunner({
      exitCode: 1,
      stderr: `bad key ${SECRET} rejected\n`,
    });
    const out = await runCli(["setup", "key", SECRET], {
      registry: registryWith({ runner }),
    });
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("code: SETUP_FAILED");
    expect(out.stdout).not.toContain(SECRET);
    expect(out.stdout).toContain("<redacted>");
  });

  it("an upstream error object that quotes the key is scrubbed too", async () => {
    const { runner } = recordingRunner({
      exitCode: 1,
      stderr: JSON.stringify({
        error: true,
        status_code: 400,
        msg: `key ${SECRET} is malformed`,
      }),
    });
    const out = await runCli(["setup", "key", SECRET], {
      registry: registryWith({ runner }),
    });
    expect(out.exitCode).toBe(1);
    expect(out.stdout).not.toContain(SECRET);
  });

  it("works end to end against the fake vastai and logs the forwarded call", async () => {
    const log = newCallLog();
    const out = await runCli(["setup", "key", SECRET], {
      env: { FAKE_VASTAI_LOG: log },
    });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).not.toContain(SECRET);
    const calls = readCallLog(log);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.argv.slice(-3)).toEqual(["set", "api-key", SECRET]);
  });

  it("a missing key exits 2 and calls nothing", async () => {
    const { runner, argvs } = recordingRunner();
    const out = await runCli(["setup", "key"], {
      registry: registryWith({ runner }),
    });
    expect(out.exitCode).toBe(2);
    expect(out.stdout).toContain("usage: vast-axi setup key <key>");
    expect(argvs).toEqual([]);
  });

  it("extra or flag-shaped values exit 2 without echoing them", async () => {
    const { runner, argvs } = recordingRunner();
    const registry = registryWith({ runner });
    for (const args of [
      ["setup", "key", SECRET, "second"],
      ["setup", "key", `--${SECRET}`],
    ]) {
      const out = await runCli(args, { registry });
      expect(out.exitCode).toBe(2);
      expect(out.stdout).not.toContain(SECRET);
      expect(out.stdout).not.toContain("second");
    }
    expect(argvs).toEqual([]);
  });

  it("the help text never contains a key", async () => {
    expect(setup.help).not.toContain(SECRET);
    const out = await runCli(["setup", "key", "--help"]);
    expect(out.stdout).not.toContain(SECRET);
  });
});
