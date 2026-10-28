import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AxiError, exitCodeForError } from "../src/errors.js";
import { vastExec, vastJson, vastRaw, type VastRunner } from "../src/vastai.js";
import {
  fakeEnv,
  newCallLog,
  readCallLog,
  withEnv,
  type Env,
} from "./helpers/run-cli.js";

/** Run `fn` against the fake vastai with `extra` env on top of fakeEnv(). */
const withFake = <T>(extra: Env, fn: () => Promise<T>): Promise<T> =>
  withEnv(fakeEnv(extra), fn);

async function failure(fn: () => Promise<unknown>): Promise<AxiError> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AxiError);
    return error as AxiError;
  }
  throw new Error("expected the call to fail");
}

const searchOffers = () => vastJson<unknown[]>(["search", "offers"]);
const showInstances = () => vastJson<unknown[]>(["show", "instances"]);

describe("runner basics", () => {
  it("runs the fake under node and parses JSON from search offers", async () => {
    const offers = await withFake({}, searchOffers);
    expect(offers).toHaveLength(10);
  });

  it("prepends --raw --retry 1 and closes stdin so the child never waits", async () => {
    const log = newCallLog();
    const out = await withFake(
      { FAKE_VASTAI_LOG: log, FAKE_VASTAI_SCENARIO: "stdin" },
      () => vastJson<{ stdin_bytes: number }>(["show", "user"]),
    );
    expect(out.stdin_bytes).toBe(0);
    expect(readCallLog(log)[0]!.argv.slice(0, 3)).toEqual([
      "--raw",
      "--retry",
      "1",
    ]);
  });

  it("vastExec returns plain text from commands that do not print JSON", async () => {
    const text = await withFake({}, () =>
      vastExec(["stop", "instance", "42", "-y"]),
    );
    expect(text.trim()).toBe("stopping instance 42.");
  });

  it("E27: non-ASCII labels survive the subprocess pipe", async () => {
    const rows = await withFake({}, showInstances);
    expect((rows[1] as { label: string }).label).toBe("训练-ünï");
  });

  it("uses an injected runner without spawning anything", async () => {
    const runner: VastRunner = async (argv) => ({
      stdout: JSON.stringify({ argv }),
      stderr: "",
      exitCode: 0,
    });
    const out = await vastJson<{ argv: string[] }>(["show", "user"], {
      runner,
    });
    expect(out.argv).toEqual(["--raw", "--retry", "1", "show", "user"]);
  });

  it("scripted sequences answer the nth call with the nth entry", async () => {
    const log = newCallLog();
    const routes = JSON.stringify({
      "show instances": {
        sequence: [{ stdout: '["first"]' }, { stdout: '["second"]' }],
      },
    });
    const env = { FAKE_VASTAI_LOG: log, FAKE_VASTAI_ROUTES: routes };
    expect(await withFake(env, showInstances)).toEqual(["first"]);
    expect(await withFake(env, showInstances)).toEqual(["second"]);
    expect(await withFake(env, showInstances)).toEqual(["second"]);
  });
});

describe("auth and upstream errors", () => {
  it("E1: no key (401 on stderr, exit 0, empty stdout) becomes AUTH_REQUIRED, exit 1", async () => {
    const error = await failure(() =>
      withFake(
        { FAKE_VASTAI_SCENARIO: "auth401", VAST_API_KEY: undefined },
        searchOffers,
      ),
    );
    expect(error.code).toBe("AUTH_REQUIRED");
    expect(exitCodeForError(error)).toBe(1);
    expect(error.suggestions.join("\n")).toContain("vast-axi setup key <key>");
  });

  it("E2: an invalid key is AUTH_REQUIRED and the key value is never echoed", async () => {
    const key = "SECRETKEY123456";
    const error = await failure(() =>
      withFake(
        { FAKE_VASTAI_SCENARIO: "auth401", VAST_API_KEY: key },
        searchOffers,
      ),
    );
    expect(error.code).toBe("AUTH_REQUIRED");
    expect(JSON.stringify([error.message, error.suggestions])).not.toContain(
      key,
    );
  });

  it("E3: a 403 JSON object on stderr with exit 0 and empty stdout becomes AUTH_REQUIRED (AE1)", async () => {
    const error = await failure(() =>
      withFake({ FAKE_VASTAI_SCENARIO: "auth403" }, showInstances),
    );
    expect(error.code).toBe("AUTH_REQUIRED");
    expect(exitCodeForError(error)).toBe(1);
  });

  it("E10: HTTP 429 on stderr becomes RATE_LIMITED with a wait hint", async () => {
    const error = await failure(() =>
      withFake({ FAKE_VASTAI_SCENARIO: "rate429" }, searchOffers),
    );
    expect(error.code).toBe("RATE_LIMITED");
    expect(error.suggestions.join(" ")).toContain("60s");
  });

  it("E28: with VAST_API_KEY set, upstream text quoting the key is redacted", async () => {
    const key = "SECRETKEY123456";
    const routes = JSON.stringify({
      "search offers": {
        stderr: `{"error": true, "status_code": 500, "msg": "bad key ${key}"}`,
      },
    });
    const error = await failure(() =>
      withFake({ VAST_API_KEY: key, FAKE_VASTAI_ROUTES: routes }, searchOffers),
    );
    expect(error.code).toBe("UPSTREAM_ERROR");
    expect(error.message).toContain("<redacted>");
    expect(error.message).not.toContain(key);
  });

  it("a non-zero exit with plain stderr becomes UPSTREAM_ERROR", async () => {
    const error = await failure(() =>
      withFake({ FAKE_VASTAI_SCENARIO: "crash" }, () =>
        vastExec(["show", "user"]),
      ),
    );
    expect(error.code).toBe("UPSTREAM_ERROR");
    expect(error.message).toContain("Traceback");
  });

  it("maps an error object printed on stdout (success: false) like a stderr one", async () => {
    const routes = JSON.stringify({
      "create instance": {
        stdout:
          '{"success": false, "error": "insufficient_credit", "msg": "Not enough credit"}',
      },
    });
    const error = await failure(() =>
      withFake({ FAKE_VASTAI_ROUTES: routes }, () =>
        vastJson(["create", "instance", "1"]),
      ),
    );
    expect(error.code).toBe("INSUFFICIENT_CREDIT");
  });

  it("vastRaw reports the upstream error without throwing, even at exit 0", async () => {
    const result = await withFake({ FAKE_VASTAI_SCENARIO: "auth403" }, () =>
      vastRaw(["show", "user"]),
    );
    expect(result.exitCode).toBe(0);
    expect(result.upstreamError?.status).toBe(403);
  });
});

describe("process failures", () => {
  it("E6: a missing binary becomes VASTAI_NOT_INSTALLED with the install hint", async () => {
    const missing = join(tmpdir(), "vast-axi-no-such-vastai.exe");
    const error = await failure(() =>
      withFake({ VAST_AXI_BIN: missing }, searchOffers),
    );
    expect(error.code).toBe("VASTAI_NOT_INSTALLED");
    expect(error.suggestions.join(" ")).toContain("uv tool install vastai");
  });

  it("E6: a missing script target and an empty PATH are VASTAI_NOT_INSTALLED too", async () => {
    const script = await failure(() =>
      withFake(
        { VAST_AXI_BIN: join(tmpdir(), "no-such-fake.cjs") },
        searchOffers,
      ),
    );
    expect(script.code).toBe("VASTAI_NOT_INSTALLED");

    const emptyDir = mkdtempSync(join(tmpdir(), "vast-axi-empty-path-"));
    const onPath = await failure(() =>
      withFake({ VAST_AXI_BIN: undefined, PATH: emptyDir }, searchOffers),
    );
    expect(onPath.code).toBe("VASTAI_NOT_INSTALLED");
  });

  it("E5: truncated JSON becomes UPSTREAM_PARSE_ERROR quoting the output and naming raw", async () => {
    const error = await failure(() =>
      withFake({ FAKE_VASTAI_SCENARIO: "garbage" }, showInstances),
    );
    expect(error.code).toBe("UPSTREAM_PARSE_ERROR");
    expect(error.message).toContain("gpu_name");
    expect(error.suggestions.join(" ")).toContain("vast-axi raw");
  });

  it("E5: empty stdout from a JSON command is also UPSTREAM_PARSE_ERROR", async () => {
    const error = await failure(() =>
      withFake({ FAKE_VASTAI_SCENARIO: "empty" }, showInstances),
    );
    expect(error.code).toBe("UPSTREAM_PARSE_ERROR");
  });

  it("E7: a parse failure probes --version once and adds the VASTAI_VERSION hint; the happy path never probes", async () => {
    const happyLog = newCallLog();
    await withFake({ FAKE_VASTAI_LOG: happyLog }, searchOffers);
    expect(readCallLog(happyLog).map((c) => c.route)).toEqual([
      "search offers",
    ]);

    const log = newCallLog();
    const env = { FAKE_VASTAI_LOG: log, FAKE_VASTAI_VERSION: "1.7.2" };
    const error = await failure(() =>
      withFake({ ...env, FAKE_VASTAI_SCENARIO: "garbage" }, showInstances),
    );
    const hint = error.suggestions.find((s) => s.startsWith("VASTAI_VERSION"));
    expect(hint).toContain("1.7.2");
    expect(hint).toContain("1.8.3");
    expect(hint).toContain("older");
    expect(readCallLog(log).map((c) => c.route)).toEqual([
      "show instances",
      "--version",
    ]);
  });

  it("E8: a hung child is killed at the timeout and reported as TIMEOUT", async () => {
    const started = Date.now();
    const error = await failure(() =>
      withFake(
        { FAKE_VASTAI_SCENARIO: "hang", VAST_AXI_TIMEOUT_MS: "500" },
        searchOffers,
      ),
    );
    expect(error.code).toBe("TIMEOUT");
    expect(exitCodeForError(error)).toBe(1);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("output larger than the buffer is OUTPUT_TOO_LARGE, not a crash", async () => {
    const error = await failure(() =>
      withFake({}, () => vastExec(["search", "offers"], { maxBuffer: 1000 })),
    );
    expect(error.code).toBe("OUTPUT_TOO_LARGE");
  });
});
