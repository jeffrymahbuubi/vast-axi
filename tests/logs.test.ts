import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MAX_BUFFER_BYTES } from "../src/vastai.js";
import { newCallLog, readCallLog, runCli } from "./helpers/run-cli.js";

const dir = mkdtempSync(join(tmpdir(), "vast-axi-logs-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function writeLog(name: string, text: string): string {
  const file = join(dir, name);
  writeFileSync(file, text);
  return file;
}

describe("logs", () => {
  it("returns the log text and asks upstream for the last 200 lines", async () => {
    const log = newCallLog();
    const out = await runCli(["logs", "42"], { env: { FAKE_VASTAI_LOG: log } });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("pulling image");
    expect(out.stdout).not.toContain("help[");
    const argv = readCallLog(log)[0]!.argv;
    expect(argv.slice(3)).toEqual(["logs", "42", "--tail", "200"]);
  });

  it("passes --tail and --filter through", async () => {
    const log = newCallLog();
    await runCli(["logs", "42", "--tail", "5", "--filter", "error"], {
      env: { FAKE_VASTAI_LOG: log },
    });
    expect(readCallLog(log)[0]!.argv.slice(3)).toEqual([
      "logs",
      "42",
      "--tail",
      "5",
      "--filter",
      "error",
    ]);
  });

  it("keeps only the last --tail lines when upstream sends more", async () => {
    const file = writeLog("five.txt", "l1\nl2\nl3\nl4\nl5\n");
    const out = await runCli(["logs", "42", "--tail", "2"], {
      env: { FAKE_U6_LOG_FILE: file },
    });
    expect(out.stdout).toContain("l4\nl5");
    expect(out.stdout).not.toContain("l3");
    expect(out.stdout).toContain("last 2 of 5 lines");
  });

  it("states an empty log definitively", async () => {
    const file = writeLog("empty.txt", "\n\n");
    const out = await runCli(["logs", "42"], {
      env: { FAKE_U6_LOG_FILE: file },
    });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("#42 has no log lines");
  });

  it("redacts the API key if the log quotes it", async () => {
    const file = writeLog("key.txt", "token=test-key-not-real done\n");
    const out = await runCli(["logs", "42"], {
      env: { FAKE_U6_LOG_FILE: file },
    });
    expect(out.stdout).toContain("token=<redacted> done");
  });

  it("E21: a 10 MB log prints 200 capped lines, a size hint and a --full hint", async () => {
    // 21,000 lines of 520 chars is about 10.9 MB, over the 10 MB default buffer.
    const line = "x".repeat(520);
    const text = Array.from({ length: 21_000 }, (_, i) => `${i} ${line}`).join(
      "\n",
    );
    expect(Buffer.byteLength(text)).toBeGreaterThan(MAX_BUFFER_BYTES);
    const file = writeLog("big.txt", text);

    const out = await runCli(["logs", "42"], {
      env: { FAKE_U6_LOG_FILE: file },
    });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).not.toContain("OUTPUT_TOO_LARGE");
    const [body = "", helpBlock = ""] = out.stdout.split("\nhelp[");
    const lines = body.split("\n");
    expect(lines).toHaveLength(200);
    expect(lines[0]).toMatch(/^20800 x+\[\+\d+ chars\]$/);
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThan(430);
    expect(helpBlock).toMatch(/last 200 of 21000 lines \(1\d\.\d MB fetched\)/);
    expect(helpBlock).toContain("vast-axi logs 42 --full");
  });

  it("--full keeps long lines whole", async () => {
    const file = writeLog("long.txt", `${"y".repeat(900)}\n`);
    const out = await runCli(["logs", "42", "--full"], {
      env: { FAKE_U6_LOG_FILE: file },
    });
    expect(out.stdout).toContain("y".repeat(900));
    expect(out.stdout).not.toContain("[+");
  });

  it("--json wraps the text", async () => {
    const out = await runCli(["logs", "42", "--json"]);
    const body = JSON.parse(out.stdout) as { output: string };
    expect(body.output).toContain("pulling image");
  });

  it("validates --tail and the id", async () => {
    expect((await runCli(["logs", "42", "--tail", "0"])).exitCode).toBe(2);
    expect((await runCli(["logs", "x"])).exitCode).toBe(2);
    expect((await runCli(["logs"])).exitCode).toBe(2);
  });

  it("maps an upstream error object", async () => {
    const out = await runCli(["logs", "42"], {
      env: { FAKE_VASTAI_SCENARIO: "auth401" },
    });
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("code: AUTH_REQUIRED");
  });

  it("E20: an unknown flag exits 2 and lists the valid flags", async () => {
    const out = await runCli(["logs", "42", "--tails", "5"]);
    expect(out.exitCode).toBe(2);
    expect(out.stdout).toContain("--tail");
    expect(out.stdout).toContain("--full");
  });

  it("has --help", async () => {
    const out = await runCli(["logs", "--help"]);
    expect(out.stdout).toContain("usage: vast-axi logs");
  });
});
