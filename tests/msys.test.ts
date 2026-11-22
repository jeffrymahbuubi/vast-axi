import { afterEach, describe, expect, it } from "vitest";
import { AxiError } from "../src/errors.js";
import { MSYS_HINT, assertNotMangled, findMangled } from "../src/msys.js";

const REAL_PLATFORM = process.platform;
const KEYS = ["EXEPATH", "MSYSTEM", "MSYS_NO_PATHCONV"] as const;
const saved = KEYS.map((k) => [k, process.env[k]] as const);
function setPlatform(p: string): void {
  Object.defineProperty(process, "platform", { value: p });
}
afterEach(() => {
  setPlatform(REAL_PLATFORM);
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("msys", () => {
  it("E119: the default Git root and a --flag=<mangled> word are found", () => {
    expect(findMangled(["ls", "C:/Program Files/Git/workspace/x"])).toBe(
      "C:/Program Files/Git/workspace/x",
    );
    expect(findMangled(["--out=C:/Program Files/Git/w"])).toBe(
      "--out=C:/Program Files/Git/w",
    );
    expect(findMangled(["ls", "/workspace/x"])).toBeUndefined();
    try {
      assertNotMangled(["C:/Program Files/Git/x"], "x");
      expect.unreachable();
    } catch (e) {
      expect((e as AxiError).suggestions).toContain(MSYS_HINT);
    }
  });

  it("E120: the EXEPATH root is refused; other drive paths only without MSYSTEM", () => {
    setPlatform("win32");
    delete process.env["MSYSTEM"];
    delete process.env["MSYS_NO_PATHCONV"];
    process.env["EXEPATH"] = "D:\\Tools\\Git\\bin";
    expect(findMangled(["D:/Tools/Git/workspace"])).toBe(
      "D:/Tools/Git/workspace",
    );
    expect(findMangled(["d:\\tools\\git\\workspace"])).toBeDefined();
    expect(findMangled(["C:/Users/x"])).toBeUndefined();
    // OQ62: under Git Bash (MSYSTEM set) any drive-letter word is refused.
    process.env["MSYSTEM"] = "MINGW64";
    expect(findMangled(["C:/Users/x"])).toBe("C:/Users/x");
  });

  it("E184: on linux an EXEPATH root is ignored", () => {
    setPlatform("linux");
    process.env["EXEPATH"] = "/usr";
    expect(findMangled(["/usr/local/x"])).toBeUndefined();
  });

  it("E185: win32 + MSYSTEM, no EXEPATH: drive words and --out=D:/x are refused", () => {
    setPlatform("win32");
    process.env["MSYSTEM"] = "MINGW64";
    delete process.env["MSYS_NO_PATHCONV"];
    delete process.env["EXEPATH"];
    expect(findMangled(["C:/msys64/workspace/x"])).toBe(
      "C:/msys64/workspace/x",
    );
    expect(findMangled(["--out=D:/x"])).toBe("--out=D:/x");
    try {
      assertNotMangled(["C:/msys64/workspace/x"], "x");
      expect.unreachable();
    } catch (e) {
      expect((e as AxiError).suggestions).toContain(MSYS_HINT);
    }
  });

  it("E186: MSYS_NO_PATHCONV=1, or no MSYSTEM, leaves C:/Users/x alone", () => {
    setPlatform("win32");
    process.env["MSYSTEM"] = "MINGW64";
    process.env["MSYS_NO_PATHCONV"] = "1";
    expect(findMangled(["C:/Users/x"])).toBeUndefined();
    delete process.env["MSYS_NO_PATHCONV"];
    delete process.env["MSYSTEM"];
    expect(findMangled(["C:/Users/x"])).toBeUndefined();
  });

  it("I9: MSYS_HINT is the sentence job.ts gives", () => {
    expect(MSYS_HINT).toContain("MSYS_NO_PATHCONV=1");
  });
});
