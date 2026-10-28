import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AxiError } from "axi-sdk-js";
import { assertKnownFlags, takeBoolFlag } from "../src/args.js";
import { main } from "../src/cli.js";
import { REGISTRY, type Registry } from "../src/commands/index.js";
import type { VastCommand } from "../src/commands/types.js";
import { notImplemented } from "../src/commands/types.js";
import { TOP_HELP, buildHelp } from "../src/help.js";
import { VERSION } from "../src/version.js";
import { runCli } from "./helpers/run-cli.js";

const ROOT = new URL("..", import.meta.url);
const COMMAND_NAMES = [
  "search",
  "status",
  "rent",
  "ssh",
  "logs",
  "run",
  "job",
  "finish",
  "stop",
  "destroy",
  "copy",
  "raw",
  "setup",
  "update",
];

/** Run the real entrypoint in a child process (tsx), with stdin closed and no TTY. */
function runBin(
  args: string[],
  opts: { destroyStdout?: boolean } = {},
): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "bin/vast-axi.ts", ...args],
      {
        cwd: ROOT,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    if (opts.destroyStdout) child.stdout.destroy();
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, code }));
  });
}

describe("version", () => {
  it("VERSION matches package.json", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("package.json", ROOT), "utf8"),
    ) as {
      version: string;
    };
    expect(VERSION).toBe(pkg.version);
  });

  it("prints the version for -v, -V and --version, exit 0", async () => {
    for (const flag of ["-v", "-V", "--version"]) {
      const { stdout, exitCode } = await runCli([flag]);
      expect(stdout).toBe(`${VERSION}\n`);
      expect(exitCode).toBe(0);
    }
  });

  it("--version is answered by the bin fast path, which never statically imports the CLI", async () => {
    const source = readFileSync(new URL("bin/vast-axi.ts", ROOT), "utf8");
    expect(source).not.toMatch(/^import .*cli\.js/m);
    expect(source).toMatch(/await import\("\.\.\/src\/cli\.js"\)/);
    const { stdout, code } = await runBin(["--version"]);
    expect(stdout).toBe(`${VERSION}\n`);
    expect(code).toBe(0);
  });
});

describe("help", () => {
  it("--help prints the top-level help naming every command, update and update --check", async () => {
    const { stdout, exitCode } = await runCli(["--help"]);
    expect(stdout).toBe(TOP_HELP);
    expect(exitCode).toBe(0);
    expect(TOP_HELP).toContain("update --check");
    for (const name of COMMAND_NAMES) expect(TOP_HELP).toContain(name);
  });

  it("buildHelp lays out usage, flags, notes and examples", () => {
    const text = buildHelp({
      usage: "vast-axi stop <id>",
      summary: "Stop an instance.",
      flags: ["--json  structured output"],
      notes: ["storage still bills"],
      examples: ["vast-axi stop 42"],
    });
    expect(text).toBe(
      [
        "usage: vast-axi stop <id>",
        "Stop an instance.",
        "flags[1]:",
        "  --json  structured output",
        "note:",
        "  storage still bills",
        "examples:",
        "  vast-axi stop 42",
        "",
      ].join("\n"),
    );
  });

  it("a command whose module exports help serves it for --help", async () => {
    const registry = {
      ...REGISTRY,
      commands: Object.assign(Object.create(null), {
        demo: { command: () => "x", help: "usage: vast-axi demo\n" },
      }),
    };
    const { stdout, exitCode } = await runCli(["demo", "--help"], { registry });
    expect(stdout).toBe("usage: vast-axi demo\n");
    expect(exitCode).toBe(0);
  });
});

describe("command shell", () => {
  it("rejects an unknown command with VALIDATION_ERROR and exit 2", async () => {
    const { stdout, exitCode } = await runCli(["bogus"]);
    expect(stdout).toContain("Unknown command: bogus");
    expect(stdout).toContain("VALIDATION_ERROR");
    expect(exitCode).toBe(2);
  });

  it("treats prototype names as unknown commands, not handlers", async () => {
    const { stdout, exitCode } = await runCli(["constructor"]);
    expect(stdout).toContain("Unknown command: constructor");
    expect(exitCode).toBe(2);
  });

  it("rejects a flag before the command (--json search) with the leading-flag error", async () => {
    const { stdout, exitCode } = await runCli(["--json", "search"]);
    expect(stdout).toContain("Flags must come after the command");
    expect(stdout).toContain("VALIDATION_ERROR");
    expect(exitCode).toBe(2);
  });

  it("registers every command and the home view", () => {
    expect(Object.keys(REGISTRY.commands).sort()).toEqual(
      [...COMMAND_NAMES].sort(),
    );
    expect(typeof REGISTRY.home.command).toBe("function");
    for (const mod of [REGISTRY.home, ...Object.values(REGISTRY.commands)]) {
      expect(typeof mod.command).toBe("function");
      expect(typeof mod.help).toBe("string");
    }
  });

  it("notImplemented throws NOT_IMPLEMENTED (exit 1)", async () => {
    const run = notImplemented("demo");
    expect(() => run([])).toThrow(AxiError);
    const { stdout, exitCode } = await runCli(["demo"], {
      registry: {
        ...REGISTRY,
        commands: Object.assign(Object.create(null), {
          demo: { command: run, help: "" },
        }),
      },
    });
    expect(stdout).toContain("NOT_IMPLEMENTED");
    expect(exitCode).toBe(1);
  });
});

describe("no TTY", () => {
  it("E25: a closed stdout (EPIPE) exits 0 instead of throwing", async () => {
    let onError: ((e: unknown) => void) | undefined;
    const stdout = {
      on: (event: string, fn: (e: unknown) => void) => {
        if (event === "error") onError = fn;
      },
      write: () => {
        onError?.(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
        return false;
      },
    };
    const previous = process.exitCode;
    process.exitCode = 1;
    try {
      await main({ argv: ["--help"], stdout });
      expect(process.exitCode).toBe(0);
    } finally {
      process.exitCode = previous;
    }
  });

  it("E25: piped output has no colour codes, never prompts, and a destroyed reader exits 0", async () => {
    const piped = await runBin(["--help"]);
    expect(piped.code).toBe(0);
    expect(piped.stdout).toBe(TOP_HELP);
    expect(piped.stdout).not.toContain("\u001b[");

    const closed = await runBin(["--help"], { destroyStdout: true });
    expect(closed.code).toBe(0);
  });
});

/** A registry whose only commands are `demo` (the given handler) and a home view. */
function demoRegistry(
  demo: VastCommand,
  home: VastCommand = () => ({ ok: true }),
): Registry {
  return {
    home: { command: home, help: "" },
    commands: Object.assign(Object.create(null), {
      demo: { command: demo, help: "" },
    }),
  };
}

describe("output adapter", () => {
  const sample: VastCommand = () => ({
    offers: [{ id: 1 }, { id: 2 }],
    help: ["Run `vast-axi rent <id> --image <image>`"],
  });

  it("renders an object as TOON with a trailing help block", async () => {
    const { stdout, exitCode } = await runCli(["demo"], {
      registry: demoRegistry(sample),
    });
    expect(stdout).toBe(
      "offers[2]{id}:\n  1\n  2\nhelp[1]:\n  Run `vast-axi rent <id> --image <image>`\n",
    );
    expect(exitCode).toBe(0);
  });

  it("--json (after the command) prints the same structure as JSON and hides the flag from the handler", async () => {
    let seen: string[] = [];
    const registry = demoRegistry((args) => {
      seen = args;
      return sample(args);
    });
    const { stdout } = await runCli(["demo", "--json"], { registry });
    expect(seen).toEqual([]);
    expect(JSON.parse(stdout)).toEqual({
      offers: [{ id: 1 }, { id: 2 }],
      help: ["Run `vast-axi rent <id> --image <image>`"],
    });
  });

  it("a string result passes through as text", async () => {
    const { stdout } = await runCli(["demo"], {
      registry: demoRegistry(() => "line one\nline two"),
    });
    expect(stdout).toBe("line one\nline two\n");
  });

  it("an AxiError is structured on stdout (error, code, help) with exit 1", async () => {
    const registry = demoRegistry(() => {
      throw new AxiError("boom", "UPSTREAM_ERROR", ["try again"]);
    });
    const { stdout, exitCode } = await runCli(["demo"], { registry });
    expect(stdout).toBe(
      "error: boom\ncode: UPSTREAM_ERROR\nhelp[1]:\n  try again\n",
    );
    expect(exitCode).toBe(1);
  });

  it("E20: an unknown flag exits 2 with the valid flags listed inline", async () => {
    const registry = demoRegistry((args) => {
      assertKnownFlags(args, ["--state", "--limit"], "demo");
      return { ok: true };
    });
    const { stdout, exitCode } = await runCli(["demo", "--stat", "open"], {
      registry,
    });
    expect(exitCode).toBe(2);
    expect(stdout).toContain("unknown flag --stat");
    expect(stdout).toContain("valid flags for demo: --state, --limit");
  });

  it("scrubs VAST_API_KEY from an unexpected error message", async () => {
    const registry = demoRegistry(() => {
      throw new Error("failed with key SECRETKEY123456 in url");
    });
    const { stdout, exitCode } = await runCli(["demo"], {
      registry,
      env: { VAST_API_KEY: "SECRETKEY123456" },
    });
    expect(stdout).toContain("UNKNOWN");
    expect(stdout).not.toContain("SECRETKEY123456");
    expect(exitCode).toBe(1);
  });

  it("the home view is the bin/description header followed by the rendered body", async () => {
    const registry = demoRegistry(sample, () => ({
      balance: 12.35,
      help: ["Run `vast-axi search`"],
    }));
    const { stdout, exitCode } = await runCli([], { registry });
    expect(stdout).toMatch(
      /^bin: .*\ndescription: .*\nbalance: 12.35\nhelp\[1\]:\n {2}Run `vast-axi search`\n$/,
    );
    expect(exitCode).toBe(0);
  });

  it("takeBoolFlag leaves other flags alone (sanity for the wrapper contract)", () => {
    const args = ["--json", "--full"];
    expect(takeBoolFlag(args, "--json")).toBe(true);
    expect(args).toEqual(["--full"]);
  });
});
