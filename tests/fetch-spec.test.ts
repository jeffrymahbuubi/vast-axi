// G11: `--fetch o:/tmp/x` is only a rewritten path on Windows or under MSYS.
import { afterEach, describe, expect, it } from "vitest";
import { parseFetchSpec } from "../src/job.js";

const REAL_PLATFORM = process.platform;
const SAVED_MSYSTEM = process.env["MSYSTEM"];

afterEach(() => {
  Object.defineProperty(process, "platform", { value: REAL_PLATFORM });
  if (SAVED_MSYSTEM === undefined) delete process.env["MSYSTEM"];
  else process.env["MSYSTEM"] = SAVED_MSYSTEM;
});

function setEnv(platform: string, msystem?: string): void {
  Object.defineProperty(process, "platform", { value: platform });
  if (msystem === undefined) delete process.env["MSYSTEM"];
  else process.env["MSYSTEM"] = msystem;
}

describe("parseFetchSpec portability (G11)", () => {
  it("E187: on linux, o:/tmp/x is remote `o`, local `/tmp/x`", () => {
    setEnv("linux");
    expect(parseFetchSpec("o:/tmp/x")).toEqual({
      remote: "o",
      local: "/tmp/x",
    });
  });

  it("E188: on win32 both rewritten forms are refused with the MSYS hint", () => {
    setEnv("win32");
    for (const spec of ["o:/tmp/x", "out\\run;C:\\tmp"]) {
      let err: unknown;
      try {
        parseFetchSpec(spec);
      } catch (e) {
        err = e;
      }
      expect(JSON.stringify(err), spec).toMatch(/MSYS_NO_PATHCONV=1/);
    }
  });

  it("E188: with MSYSTEM set on linux both forms are refused too", () => {
    setEnv("linux", "MINGW64");
    for (const spec of ["o:/tmp/x", "out\\run;C:\\tmp"]) {
      let err: unknown;
      try {
        parseFetchSpec(spec);
      } catch (e) {
        err = e;
      }
      expect(JSON.stringify(err), spec).toMatch(/MSYS_NO_PATHCONV=1/);
      expect(JSON.stringify(err), spec).toMatch(/VALIDATION_ERROR/);
    }
  });
});
