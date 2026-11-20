import { describe, expect, it } from "vitest";
import {
  newCallLog,
  readCallLog,
  runCli,
  type Env,
} from "./helpers/run-cli.js";

type Row = Record<string, unknown>;

async function search(args: string[], env: Env = {}) {
  const log = newCallLog();
  const { stdout, exitCode } = await runCli(["search", ...args, "--json"], {
    env: { FAKE_VASTAI_LOG: log, ...env },
  });
  const calls = readCallLog(log).filter((c) => c.tokens[0] === "search");
  return { stdout, exitCode, calls };
}

/** The built query token of the first `search offers` call. */
const queryOf = (calls: Array<{ argv: string[] }>): string =>
  calls[0]!.argv[calls[0]!.argv.indexOf("offers") + 1]!;

describe("search --min-driver / --min-cuda (#7)", () => {
  it.each([
    ["555", "driver_version>=555.0.0"],
    ["535.86", "driver_version>=535.86.0"],
    ["535.86.05", "driver_version>=535.86.05"],
  ])("E150: --min-driver %s builds %s", async (value, term) => {
    const r = await search(["--min-driver", value]);
    expect(r.exitCode).toBe(0);
    expect(queryOf(r.calls)).toContain(term);
  });

  it.each(["5555", "a.b", "1.2.3.4"])(
    "E150: --min-driver %j exits 2 before any call",
    async (value) => {
      const r = await search(["--min-driver", value]);
      expect(r.exitCode).toBe(2);
      expect(r.stdout).toContain("VALIDATION_ERROR");
      expect(r.calls).toHaveLength(0);
    },
  );

  it.each(["driver_version>=555.0", "driver_version>=555"])(
    "E151: --query '%s' exits 2 before any call and shows X.X.X",
    async (query) => {
      const r = await search(["--query", query]);
      expect(r.exitCode).toBe(2);
      expect(r.stdout).toContain("X.X.X");
      expect(r.calls).toHaveLength(0);
    },
  );

  it("E151: a three-part driver_version term goes through", async () => {
    const r = await search(["--query", "driver_version>=555.0.0"]);
    expect(r.exitCode).toBe(0);
    expect(queryOf(r.calls)).toContain("driver_version>=555.0.0");
  });

  it("E152: --min-cuda 12.5 builds cuda_max_good>=12.5", async () => {
    const r = await search(["--min-cuda", "12.5"]);
    expect(queryOf(r.calls)).toContain("cuda_max_good>=12.5");
  });

  it("E152: --min-cuda x exits 2", async () => {
    const r = await search(["--min-cuda", "x"]);
    expect(r.exitCode).toBe(2);
    expect(r.calls).toHaveLength(0);
  });

  it("E152: a flag plus the same field in --query exits 2", async () => {
    const a = await search([
      "--min-cuda",
      "12",
      "--query",
      "cuda_max_good>=12.5",
    ]);
    expect(a.exitCode).toBe(2);
    const b = await search([
      "--min-driver",
      "555",
      "--query",
      "driver_version>=555.0.0",
    ]);
    expect(b.exitCode).toBe(2);
    expect(a.calls).toHaveLength(0);
    expect(b.calls).toHaveLength(0);
  });

  it("E153: driver and cuda columns appear only in driver mode", async () => {
    const plain = JSON.parse((await search([])).stdout) as { offers: Row[] };
    expect(Object.keys(plain.offers[0]!)).not.toContain("driver");
    expect(Object.keys(plain.offers[0]!)).not.toContain("cuda");

    const both = JSON.parse(
      (await search(["--min-driver", "555", "--min-cuda", "12"])).stdout,
    ) as { offers: Row[] };
    const row = both.offers[0]!;
    expect(row["driver"]).toEqual(expect.any(String));
    expect(row["cuda"]).toEqual(expect.any(Number));

    const onlyCuda = JSON.parse(
      (await search(["--query", "cuda_vers>=12"])).stdout,
    ) as { offers: Row[] };
    expect(Object.keys(onlyCuda.offers[0]!)).toContain("cuda");
    expect(Object.keys(onlyCuda.offers[0]!)).not.toContain("driver");
  });
});

describe("search query errors from vastai (E154)", () => {
  const printed = (exit: number): Env => ({
    FAKE_VASTAI_ROUTES: JSON.stringify({
      "search offers": {
        stdout:
          "Error:  Unconsumed text. Did you forget to quote your query? 'a' != 'a b'\n",
        exit,
      },
    }),
  });

  it.each([0, 1])(
    "E154: upstream query error text (exit %i) is a VALIDATION_ERROR, exit 2",
    async (exit) => {
      const r = await search(["--query", "reliability>0.9"], printed(exit));
      expect(r.exitCode).toBe(2);
      expect(r.stdout).toContain("VALIDATION_ERROR");
      expect(r.stdout).toContain("could not parse the query");
      expect(r.stdout).toContain("Unconsumed text");
      expect(r.stdout).toContain("reliability>0.9");
    },
  );

  it("E154: other garbage stays UPSTREAM_PARSE_ERROR", async () => {
    const r = await search([], { FAKE_VASTAI_SCENARIO: "garbage" });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("UPSTREAM_PARSE_ERROR");
  });
});
