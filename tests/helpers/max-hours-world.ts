// Shared setup for the `rent --max-hours` tests: the fake vastai (offer 5001 at
// 0.50 $/hr, `create instance` answers 7835610, default balance 12.3456), a local
// fake REST server, and a pinned clock (2026-10-20T16:40:00Z).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeRest, type FakeRest, type RestHandler } from "./fake-rest.js";
import {
  newCallLog,
  readCallLog,
  runCli,
  type Env,
  type FakeCall,
} from "./run-cli.js";

export const NOW = "1792514400";
export const IMG = ["--image", "vastai/base-image"];
export const KEY = "sekrit-key-ABC123xyz";
export const INSTANCE = 7835610;

/** No instances on the account, so burn is 0. */
export const withBurn: Env = {
  FAKE_VASTAI_ROUTES: JSON.stringify({ "show instances": { stdout: "[]" } }),
};

/** Merge FAKE_VASTAI_ROUTES overrides into one env. */
export const routes = (
  over: Record<string, unknown>,
  base: Env = withBurn,
): Env => ({
  ...base,
  FAKE_VASTAI_ROUTES: JSON.stringify({
    ...JSON.parse(base["FAKE_VASTAI_ROUTES"] ?? "{}"),
    ...over,
  }),
});

/** The offer lookup rent does, with a contract of `durationSec` seconds left. */
export const offerWithContract = (durationSec: number) => ({
  "search offers ask_contract_id=5001": {
    stdout: JSON.stringify([
      {
        id: 5001,
        ask_contract_id: 5001,
        dph_total: 0.5,
        rentable: true,
        duration: durationSec,
      },
    ]),
  },
});

/** An upstream error object on stderr (what `vastai --raw` prints). */
export const upstreamFailure = (msg: string) => ({
  stderr: JSON.stringify({ error: true, status_code: 500, msg }) + "\n",
});

let rest: FakeRest | undefined;

/** Start the fake REST server for this test; call `closeRest` in afterEach. */
export async function serve(handler?: RestHandler): Promise<FakeRest> {
  rest = await startFakeRest(handler);
  return rest;
}

export async function closeRest(): Promise<void> {
  await rest?.close();
  rest = undefined;
}

export interface Run {
  stdout: string;
  exitCode: number;
  calls: FakeCall[];
  tokens: string[];
  json: Record<string, unknown>;
}

/** Run `vast-axi rent <argv>` against the fakes; VAST_AXI_API_URL points at the server from `serve`. */
export async function rent(argv: string[], env: Env = {}): Promise<Run> {
  const log = newCallLog();
  const { stdout, exitCode } = await runCli(["rent", ...argv], {
    env: {
      FAKE_VASTAI_LOG: log,
      VAST_AXI_NOW: NOW,
      VAST_AXI_API_URL: rest?.url,
      ...env,
    },
  });
  const calls = readCallLog(log);
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    // text output
  }
  return {
    stdout,
    exitCode,
    calls,
    tokens: calls.map((c) => c.tokens.join(" ")),
    json,
  };
}

export const created = (r: Run) =>
  r.calls.filter((c) => c.tokens[0] === "create" && c.tokens[1] === "instance");

export const destroyed = (r: Run) =>
  r.calls.filter(
    (c) => c.tokens[0] === "destroy" && c.tokens[1] === "instance",
  );

/** A scheduled-jobs row as `show scheduled-jobs` lists a DAILY destroy timer of `INSTANCE`. */
export const dailyJob = (
  id: number,
  hour: number,
  over: Record<string, unknown> = {},
) => ({
  id,
  api_endpoint: `/api/v0/instances/${INSTANCE}/`,
  request_body: {},
  request_method: "DELETE",
  instance_id: INSTANCE,
  start_time: Number(NOW),
  end_time: Number(NOW) + 2 * 86400,
  frequency: "DAILY",
  day_of_the_week: null,
  hour_of_the_day: hour,
  last_executed_around: null,
  status: null,
  ...over,
});

/** `show scheduled-jobs` answering with exactly `jobs`. */
export const jobsRoute = (jobs: unknown[]) => ({
  "show scheduled-jobs": { stdout: JSON.stringify(jobs) },
});

/**
 * The account as the verification read-back sees it after a successful POST:
 * job `jobId` is listed as a DAILY destroy timer at UTC hour `hour`.
 */
export const withTimer = (
  hour: number,
  jobId = 5081,
  over: Record<string, unknown> = {},
): Env => routes(jobsRoute([dailyJob(jobId, hour, over)]));

/** Calls to `delete scheduled-job`. */
export const jobDeletes = (r: Run) =>
  r.calls.filter(
    (c) => c.tokens[0] === "delete" && c.tokens[1] === "scheduled-job",
  );

/** A HOME with no key anywhere (the developer's real key file is never read). */
export function emptyHome(): Env {
  const dir = mkdtempSync(join(tmpdir(), "vast-axi-home-"));
  return {
    VAST_API_KEY: undefined,
    HOME: dir,
    USERPROFILE: dir,
    XDG_CONFIG_HOME: join(dir, "xdg"),
  };
}
