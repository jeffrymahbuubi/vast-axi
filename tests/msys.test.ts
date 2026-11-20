import { afterEach, describe, expect, it } from "vitest";
import { AxiError } from "../src/errors.js";
import { MSYS_HINT, assertNotMangled, findMangled } from "../src/msys.js";

const saved = process.env["EXEPATH"];
afterEach(() => {
  if (saved === undefined) delete process.env["EXEPATH"];
  else process.env["EXEPATH"] = saved;
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

  it("E120: the EXEPATH root is refused, other drive paths are not", () => {
    process.env["EXEPATH"] = "D:\\Tools\\Git\\bin";
    expect(findMangled(["D:/Tools/Git/workspace"])).toBe(
      "D:/Tools/Git/workspace",
    );
    expect(findMangled(["d:\\tools\\git\\workspace"])).toBeDefined();
    expect(findMangled(["C:/Users/x"])).toBeUndefined();
  });

  it("I9: MSYS_HINT is the sentence job.ts gives", () => {
    expect(MSYS_HINT).toContain("MSYS_NO_PATHCONV=1");
  });
});
