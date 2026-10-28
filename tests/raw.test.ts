import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { RAW_MAX_CHARS } from "../src/commands/raw.js";
import { newCallLog, readCallLog, runCli } from "./helpers/run-cli.js";

const route = (key: string, spec: Record<string, unknown>) => ({
  FAKE_VASTAI_ROUTES: JSON.stringify({ [key]: spec }),
});

const manyRows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: i,
    name: `volume-${i}`,
    size: i * 2,
    note: "x".repeat(20),
  }));

describe("raw (R14)", () => {
  it("runs `vastai --raw show volumes` and renders the JSON as TOON", async () => {
    const log = newCallLog();
    const out = await runCli(["raw", "show", "volumes"], {
      env: { FAKE_VASTAI_LOG: log },
    });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("result[2]{id,name,size,disk_name}:");
    expect(out.stdout).toContain("11,data,20,vol-a");
    const calls = readCallLog(log);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.argv).toEqual([
      "--raw",
      "--retry",
      "1",
      "show",
      "volumes",
    ]);
  });

  it("puts non-JSON stdout in an output: block", async () => {
    const out = await runCli(["raw", "stop", "instance", "42"]);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("output: ");
    expect(out.stdout).toContain("stopping instance 42.");
  });

  it("keeps a top-level JSON object as plain keys", async () => {
    const out = await runCli(["raw", "show", "volumes"], {
      env: route("show volumes", { stdout: '{"credit": 3.5, "name": "x"}' }),
    });
    expect(out.stdout).toContain("credit: 3.5");
    expect(out.stdout).not.toContain("result");
  });

  it("wraps an upstream object that uses a reserved key under result", async () => {
    const out = await runCli(["raw", "show", "volumes"], {
      env: route("show volumes", { stdout: '{"help": "upstream", "id": 1}' }),
    });
    expect(out.stdout).toContain("result:");
    expect(out.stdout).toContain("help: upstream");
  });

  it("--json returns the same structure as JSON", async () => {
    const out = await runCli(["raw", "show", "volumes", "--json"]);
    const parsed = JSON.parse(out.stdout) as { result: unknown[] };
    expect(parsed.result).toHaveLength(2);
  });

  it("a stderr error object exits 1 through the existing mapping", async () => {
    const out = await runCli(["raw", "show", "volumes"], {
      env: { FAKE_VASTAI_SCENARIO: "rate429" },
    });
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("code: RATE_LIMITED");
  });

  it("a JSON body that is an error exits 1", async () => {
    const out = await runCli(["raw", "show", "volumes"], {
      env: route("show volumes", {
        stdout: '{"success": false, "error": "no_such_ask", "msg": "gone"}',
      }),
    });
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("code: OFFER_UNAVAILABLE");
  });

  it("keeps the upstream exit code when there is no error object", async () => {
    const out = await runCli(["raw", "show", "volumes"], {
      env: route("show volumes", { stderr: "disk exploded\n", exit: 3 }),
    });
    expect(out.exitCode).toBe(3);
    expect(out.stdout).toContain("exit_code: 3");
    expect(out.stdout).toContain("stderr: disk exploded");
  });

  it("an unknown vastai command surfaces upstream's usage error and exit 2", async () => {
    const out = await runCli(["raw", "frobnicate", "things"]);
    expect(out.exitCode).toBe(2);
    expect(out.stdout).toContain("invalid choice");
  });

  it("no args exits 2 with usage", async () => {
    const log = newCallLog();
    const out = await runCli(["raw"], { env: { FAKE_VASTAI_LOG: log } });
    expect(out.exitCode).toBe(2);
    expect(out.stdout).toContain("code: VALIDATION_ERROR");
    expect(out.stdout).toContain("usage: vast-axi raw <vastai args...>");
    expect(readCallLog(log)).toEqual([]);
  });

  it("--full alone is still no args", async () => {
    const out = await runCli(["raw", "--full"]);
    expect(out.exitCode).toBe(2);
  });

  it("cuts large JSON to fewer rows with a size hint and --full, which is not forwarded", async () => {
    const env = route("show volumes", {
      stdout: JSON.stringify(manyRows(300)),
    });
    const cut = await runCli(["raw", "show", "volumes"], { env });
    expect(cut.exitCode).toBe(0);
    expect(cut.stdout).toMatch(/truncated: showing \d+ of 300 rows/);
    expect(cut.stdout).toContain("Rerun with --full");
    expect(cut.stdout).toContain("vast-axi raw show volumes --full");
    expect(cut.stdout.length).toBeLessThan(RAW_MAX_CHARS + 600);

    const log = newCallLog();
    const all = await runCli(["raw", "show", "volumes", "--full"], {
      env: { ...env, FAKE_VASTAI_LOG: log },
    });
    expect(all.stdout).not.toContain("truncated");
    expect(all.stdout).toContain("volume-299");
    expect(readCallLog(log)[0]!.argv).not.toContain("--full");
  });

  it("cuts large text with [+N chars] and --full restores it", async () => {
    const env = route("show volumes", {
      stdout: "line of text\n".repeat(1000),
    });
    const cut = await runCli(["raw", "show", "volumes"], { env });
    expect(cut.stdout).toMatch(/\[\+\d+ chars\]/);
    expect(cut.stdout).toContain("truncated:");
    const all = await runCli(["raw", "show", "volumes", "--full"], { env });
    expect(all.stdout).not.toContain("truncated");
  });

  it("scrubs the configured API key from text and JSON output", async () => {
    const text = await runCli(["raw", "show", "volumes"], {
      env: route("show volumes", { stdout: "key is test-key-not-real ok" }),
    });
    expect(text.stdout).not.toContain("test-key-not-real");
    expect(text.stdout).toContain("<redacted>");
    const json = await runCli(["raw", "show", "volumes"], {
      env: route("show volumes", {
        stdout: '{"api_key": "test-key-not-real"}',
      }),
    });
    expect(json.stdout).not.toContain("test-key-not-real");
  });

  it("reports vastai as not installed when the binary is missing", async () => {
    const out = await runCli(["raw", "show", "volumes"], {
      env: { VAST_AXI_BIN: join(tmpdir(), "no-such-vastai.cjs") },
    });
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("code: VASTAI_NOT_INSTALLED");
  });

  it("`raw --help` is answered locally without calling vastai", async () => {
    const log = newCallLog();
    const out = await runCli(["raw", "--help"], {
      env: { FAKE_VASTAI_LOG: log },
    });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("usage: vast-axi raw");
    expect(readCallLog(log)).toEqual([]);
  });
});
