import { describe, expect, it } from "vitest";
import {
  assertKnownFlags,
  takeBoolFlag,
  takeFlag,
  takeNumberFlag,
  takePositional,
} from "../src/args.js";
import {
  AxiError,
  errorFromBody,
  exitCodeForError,
  mapVastError,
  parseUpstreamError,
  redactSecrets,
  versionHint,
  type ErrorPattern,
} from "../src/errors.js";

describe("parseUpstreamError", () => {
  it("reads the whole stderr when it is one JSON error object", () => {
    expect(
      parseUpstreamError('{"error": true, "status_code": 403, "msg": "no"}'),
    ).toEqual({ status: 403, msg: "no" });
  });

  it("finds the JSON object on the last line after warnings", () => {
    const stderr =
      'warning: slow\n{"error": true, "status_code": 429, "msg": "slow down"}\n';
    expect(parseUpstreamError(stderr)?.status).toBe(429);
  });

  it("ignores plain text, empty text and non-error JSON", () => {
    expect(parseUpstreamError("")).toBeUndefined();
    expect(parseUpstreamError("Traceback: boom")).toBeUndefined();
    expect(parseUpstreamError('{"ok": true}')).toBeUndefined();
  });
});

describe("errorFromBody", () => {
  it("recognises an API failure body and keeps its machine code", () => {
    expect(
      errorFromBody({ success: false, error: "no_such_ask", msg: "gone" }),
    ).toEqual({ status: null, msg: "gone", code: "no_such_ask" });
  });

  it("does not treat lists or successful bodies as errors", () => {
    expect(errorFromBody([])).toBeUndefined();
    expect(errorFromBody({ success: true, new_contract: 1 })).toBeUndefined();
    expect(errorFromBody({ error: false })).toBeUndefined();
  });
});

describe("mapVastError", () => {
  const code = (status: number | null, msg: string, c?: string) =>
    mapVastError({ status, msg, ...(c ? { code: c } : {}) }).code;

  it("E2: the live API's 404 'Invalid user key' is AUTH_REQUIRED, not NOT_FOUND", () => {
    // Recorded from the real API on 2026-10-20 with a bogus key.
    const error = mapVastError({ status: 404, msg: "Invalid user key" });
    expect(error.code).toBe("AUTH_REQUIRED");
    expect(exitCodeForError(error)).toBe(1);
  });

  it("E3: 401 and 403 are AUTH_REQUIRED with the key-setup hint, exit 1", () => {
    for (const status of [401, 403]) {
      const error = mapVastError({ status, msg: "whatever the host said" });
      expect(error.code).toBe("AUTH_REQUIRED");
      expect(error.message).not.toContain("whatever");
      expect(error.suggestions[0]).toContain("setup key <key>");
      expect(exitCodeForError(error)).toBe(1);
    }
  });

  it("recognises a missing-key message with no status code", () => {
    expect(code(null, "No API key found")).toBe("AUTH_REQUIRED");
  });

  it("maps 429, credit, offer and not-found failures to their codes", () => {
    expect(code(429, "slow")).toBe("RATE_LIMITED");
    expect(code(400, "insufficient_credit")).toBe("INSUFFICIENT_CREDIT");
    expect(code(null, "x", "no_such_ask")).toBe("OFFER_UNAVAILABLE");
    expect(code(404, "gone")).toBe("NOT_FOUND");
  });

  it("falls back to UPSTREAM_ERROR with a server-error hint for 5xx", () => {
    const error = mapVastError({ status: 502, msg: "bad gateway" });
    expect(error.code).toBe("UPSTREAM_ERROR");
    expect(error.message).toBe("vast.ai error 502: bad gateway");
    expect(error.suggestions[0]).toContain("retry");
  });

  it("tries extra patterns first so a command can refine a code", () => {
    const extra: ErrorPattern[] = [
      {
        test: (e) => /insufficient/i.test(e.msg),
        code: "INSUFFICIENT_CREDIT",
        message: () => "Not enough credit (balance 0.12)",
      },
    ];
    expect(
      mapVastError({ status: 400, msg: "insufficient" }, extra).message,
    ).toBe("Not enough credit (balance 0.12)");
  });
});

describe("redactSecrets", () => {
  it("removes the configured key and long hex tokens", () => {
    const saved = process.env["VAST_API_KEY"];
    process.env["VAST_API_KEY"] = "abcd1234secret";
    try {
      expect(redactSecrets("key abcd1234secret used")).toBe(
        "key <redacted> used",
      );
      expect(redactSecrets(`tok ${"a1".repeat(30)}`)).toBe("tok <redacted>");
    } finally {
      if (saved === undefined) delete process.env["VAST_API_KEY"];
      else process.env["VAST_API_KEY"] = saved;
    }
  });
});

describe("versionHint", () => {
  it("says older below 1.8 and just names the tested version otherwise", () => {
    expect(versionHint("1.7.9")).toContain("older than the tested 1.8.3");
    expect(versionHint("1.9.0")).not.toContain("older");
  });
});

describe("assertKnownFlags", () => {
  it("E20: rejects an unknown flag with VALIDATION_ERROR, exit 2, listing the valid ones", () => {
    let caught: unknown;
    try {
      assertKnownFlags(["--stat"], ["--state"], "list");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AxiError);
    const error = caught as AxiError;
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(exitCodeForError(error)).toBe(2);
    expect(error.message).toContain("--stat");
    expect(error.suggestions.join("\n")).toContain("--state");
  });

  it("lets known flags, --flag=value, positionals, --help and -h through", () => {
    expect(() =>
      assertKnownFlags(
        ["42", "--state=open", "--limit", "3", "--help", "-h"],
        ["--state", "--limit"],
      ),
    ).not.toThrow();
  });

  it("stops scanning at --", () => {
    expect(() => assertKnownFlags(["--", "--whatever"], [])).not.toThrow();
  });

  it("names every offending flag once", () => {
    expect(() => assertKnownFlags(["--a", "--b", "--a"], [])).toThrow(
      /--a, --b/,
    );
  });
});

describe("flag helpers", () => {
  it("takeFlag reads both forms and removes them", () => {
    const args = ["--gpu", "RTX_4090", "--limit=3", "x"];
    expect(takeFlag(args, "--gpu")).toBe("RTX_4090");
    expect(takeFlag(args, "--limit")).toBe("3");
    expect(takeFlag(args, "--gpu")).toBeUndefined();
    expect(args).toEqual(["x"]);
  });

  it("takeFlag rejects a missing value", () => {
    expect(() => takeFlag(["--gpu"], "--gpu")).toThrow(/requires a value/);
    expect(() => takeFlag(["--gpu", "--limit", "3"], "--gpu")).toThrow(
      /requires a value/,
    );
  });

  it("takeBoolFlag removes the flag", () => {
    const args = ["--full", "x"];
    expect(takeBoolFlag(args, "--full")).toBe(true);
    expect(takeBoolFlag(args, "--full")).toBe(false);
    expect(args).toEqual(["x"]);
  });

  it("takeNumberFlag validates numbers, integers and minimums", () => {
    expect(takeNumberFlag(["--limit", "5"], "--limit", { integer: true })).toBe(
      5,
    );
    expect(takeNumberFlag([], "--limit")).toBeUndefined();
    expect(() => takeNumberFlag(["--limit", "abc"], "--limit")).toThrow(
      /must be a number/,
    );
    expect(() =>
      takeNumberFlag(["--limit", "1.5"], "--limit", { integer: true }),
    ).toThrow(/an integer/);
    expect(() =>
      takeNumberFlag(["--limit", "0"], "--limit", { min: 1 }),
    ).toThrow(/>= 1/);
  });

  it("takePositional removes the first non-flag token or fails with usage", () => {
    const args = ["--x", "42"];
    expect(takePositional(args, "id")).toBe("42");
    try {
      takePositional([], "id", "vast-axi stop <id>");
      expect.unreachable();
    } catch (error) {
      expect((error as AxiError).code).toBe("VALIDATION_ERROR");
      expect((error as AxiError).suggestions).toEqual(["vast-axi stop <id>"]);
    }
  });
});
