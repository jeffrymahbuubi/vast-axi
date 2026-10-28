import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startFakeRest, type RestHandler } from "./helpers/fake-rest.js";
import {
  IMG,
  INSTANCE,
  KEY,
  closeRest,
  created,
  destroyed,
  emptyHome,
  rent,
  routes,
  serve,
  upstreamFailure,
  withBurn,
  withTimer,
  type Run,
} from "./helpers/max-hours-world.js";
import type { Env } from "./helpers/run-cli.js";

// rent --max-hours when the destroy timer cannot be set (rollback) and key safety.
afterEach(closeRest);

describe("schedule failure rolls the rental back", () => {
  const run = (env: Env = {}) =>
    rent(["5001", ...IMG, "--max-hours", "12"], {
      ...withBurn,
      VAST_API_KEY: KEY,
      ...env,
    });

  it("E54: success without a scheduled_job_id destroys the new instance, exit 1", async () => {
    await serve(() => ({ status: 200, body: { success: true } }));
    const r = await run();
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("SCHEDULE_FAILED");
    expect(r.stdout).toContain("destroyed because its destroy timer");
    expect(r.stdout).toContain("no integer scheduled_job_id");
    expect(destroyed(r)).toHaveLength(1);
    expect(destroyed(r)[0]!.tokens[2]).toBe(String(INSTANCE));
    expect(r.stdout).not.toContain("destroy_timer:");
  });

  it("E54: a non-integer scheduled_job_id counts as no id", async () => {
    await serve(() => ({
      status: 200,
      body: { success: true, scheduled_job_id: "5081" },
    }));
    const r = await run();
    expect(r.exitCode).toBe(1);
    expect(destroyed(r)).toHaveLength(1);
  });

  it("success false with HTTP 200 is a failure", async () => {
    await serve(() => ({
      status: 200,
      body: { success: false, msg: "start_time in the past" },
    }));
    const r = await run();
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("start_time in the past");
    expect(destroyed(r)).toHaveLength(1);
  });

  it("E54b: if the rollback destroy fails too, it says the instance is STILL RUNNING", async () => {
    await serve(() => ({ status: 200, body: { success: true } }));
    const r = await run(
      routes({ "destroy instance": upstreamFailure("backend down") }),
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("SCHEDULE_FAILED");
    expect(r.stdout).toContain(`Instance ${INSTANCE} is STILL RUNNING`);
    expect(r.stdout).toContain("billing");
    expect(r.stdout).toMatch(
      new RegExp(
        `help\\[\\d+\\]:\\n\\s+Run \`vast-axi destroy ${INSTANCE}\` NOW`,
      ),
    );
  });

  it("E69: REST 401 rolls back", async () => {
    await serve(() => ({ status: 401, body: { error: "unauthorized" } }));
    const r = await run();
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("SCHEDULE_FAILED");
    expect(r.stdout).toContain("HTTP 401");
    expect(destroyed(r)).toHaveLength(1);
  });

  it("a 500 with an HTML body rolls back", async () => {
    await serve(() => ({ status: 500, body: "<html>oops</html>" }));
    const r = await run();
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("HTTP 500");
    expect(destroyed(r)).toHaveLength(1);
  });

  it("a network error rolls back", async () => {
    const dead = await startFakeRest();
    const url = dead.url;
    await dead.close();
    const r = await run({ VAST_AXI_API_URL: url });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("network error");
    expect(destroyed(r)).toHaveLength(1);
  });

  it("a timeout rolls back", async () => {
    await serve(() => ({ hang: true }));
    const r = await run({ VAST_AXI_REST_TIMEOUT_MS: "150" });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("no answer from the vast.ai API within 150 ms");
    expect(destroyed(r)).toHaveLength(1);
  });

  it.each([
    "https://evil.example.com",
    "http://console.vast.ai",
    "https://vast.ai.evil.example.com",
    "not a url",
  ])("E72: VAST_AXI_API_URL=%s is refused before any rent", async (bad) => {
    const r = await run({ VAST_AXI_API_URL: bad });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("CONFIG_ERROR");
    expect(r.stdout).not.toContain(KEY);
    expect(destroyed(r)).toHaveLength(0);
    expect(created(r)).toHaveLength(0);
  });

  it("a failed create never reaches the REST API", async () => {
    const fake = await serve();
    const r = await rent(["5007", ...IMG, "--max-hours", "12"], {
      ...withBurn,
      VAST_API_KEY: KEY,
    });
    expect(r.exitCode).toBe(1);
    expect(fake.requests).toHaveLength(0);
    expect(destroyed(r)).toHaveLength(0);
  });
});

describe("E62: the key never leaks", () => {
  /** A server that echoes the Authorization header back in its error body. */
  const echo: RestHandler = (req) => ({
    status: 401,
    body: {
      error: "invalid_key",
      msg: `bad credentials: ${String(req.headers["authorization"])}`,
      detail: `Authorization was ${String(req.headers["authorization"])}`,
    },
  });
  const assertClean = (r: Run) => {
    expect(r.stdout).not.toContain(KEY);
    expect(r.stdout).not.toContain("sekrit");
    expect(r.stdout).not.toMatch(/Bearer\s+(?!<redacted>)\S/);
    expect(JSON.stringify(r.calls)).not.toContain(KEY);
  };

  it("key from the environment is scrubbed from an echoing error body", async () => {
    const fake = await serve(echo);
    const r = await rent(["5001", ...IMG, "--max-hours", "12"], {
      ...withBurn,
      VAST_API_KEY: KEY,
    });
    expect(fake.requests[0]!.headers["authorization"]).toBe(`Bearer ${KEY}`);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("SCHEDULE_FAILED");
    assertClean(r);
  });

  it("key from a file (invisible to redactSecrets) is scrubbed too", async () => {
    const fake = await serve(echo);
    const home = emptyHome();
    mkdirSync(join(home["XDG_CONFIG_HOME"]!, "vastai"), { recursive: true });
    writeFileSync(
      join(home["XDG_CONFIG_HOME"]!, "vastai", "vast_api_key"),
      KEY,
    );
    const r = await rent(["5001", ...IMG, "--max-hours", "12", "--json"], {
      ...withBurn,
      ...home,
    });
    expect(fake.requests[0]!.headers["authorization"]).toBe(`Bearer ${KEY}`);
    expect(r.exitCode).toBe(1);
    assertClean(r);
  });

  it("the key echoed in a 200 success=false body is scrubbed", async () => {
    await serve((req) => ({
      status: 200,
      body: {
        success: false,
        msg: `rejected ${String(req.headers["authorization"])}`,
      },
    }));
    const r = await rent(["5001", ...IMG, "--max-hours", "12"], {
      ...withBurn,
      VAST_API_KEY: KEY,
    });
    expect(r.exitCode).toBe(1);
    assertClean(r);
  });

  it("the key is not in the output when the rollback destroy fails either", async () => {
    await serve(echo);
    const r = await rent(["5001", ...IMG, "--max-hours", "12"], {
      ...routes({
        "destroy instance": upstreamFailure(`failed for key ${KEY}`),
      }),
      VAST_API_KEY: KEY,
    });
    expect(r.stdout).toContain("STILL RUNNING");
    assertClean(r);
  });

  it("the success output never contains the key", async () => {
    await serve();
    const r = await rent(["5001", ...IMG, "--max-hours", "12"], {
      ...withTimer(4),
      VAST_API_KEY: KEY,
    });
    expect(r.exitCode).toBe(0);
    assertClean(r);
  });

  it("a redirect is refused, so the key cannot be forwarded", async () => {
    const other = await startFakeRest();
    try {
      await serve(() => ({
        status: 307,
        headers: { Location: `${other.url}/stolen` },
      }));
      const r = await rent(["5001", ...IMG, "--max-hours", "12"], {
        ...withBurn,
        VAST_API_KEY: KEY,
      });
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain("SCHEDULE_FAILED");
      expect(other.requests).toHaveLength(0);
      assertClean(r);
    } finally {
      await other.close();
    }
  });
});
