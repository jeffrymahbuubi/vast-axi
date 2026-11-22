import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AxiError } from "../src/errors.js";
import { buildSshArgs, requireTool } from "../src/transfer.js";

const REAL_PLATFORM = process.platform;
const SAVED = { PATH: process.env["PATH"], PATHEXT: process.env["PATHEXT"] };

afterEach(() => {
  Object.defineProperty(process, "platform", { value: REAL_PLATFORM });
  process.env["PATH"] = SAVED.PATH;
  if (SAVED.PATHEXT === undefined) delete process.env["PATHEXT"];
  else process.env["PATHEXT"] = SAVED.PATHEXT;
});

function pathWith(file: string, mode?: number): void {
  const dir = mkdtempSync(join(tmpdir(), "vast-axi-tools-"));
  writeFileSync(join(dir, file), "x");
  if (mode !== undefined) chmodSync(join(dir, file), mode);
  process.env["PATH"] = dir + delimiter;
}

function missing(fn: () => unknown): AxiError {
  try {
    fn();
  } catch (error) {
    return error as AxiError;
  }
  throw new Error("expected TRANSFER_TOOL_MISSING");
}

describe("E130: tools that spawn cannot start", () => {
  it("win32: an extensionless `ssh` on PATH is ignored (N2), with the .exe hint (N4)", () => {
    pathWith("ssh");
    Object.defineProperty(process, "platform", { value: "win32" });
    process.env["PATHEXT"] = ".EXE;.CMD;.BAT";
    const e = missing(() => requireTool("ssh"));
    expect(e.code).toBe("TRANSFER_TOOL_MISSING");
    expect(e.suggestions.join("\n")).toContain(
      "Or make sure a real ssh.exe is on PATH",
    );
  });

  // Real win32 only: pathWith() joins PATH with the host's delimiter, which a
  // stubbed win32 lookup on linux cannot split (ubuntu CI, 2026-11-22).
  it.skipIf(REAL_PLATFORM !== "win32")(
    "E190: win32 with only an ssh.cmd shim: the hint says to make sure a real ssh.exe is on PATH",
    () => {
      pathWith("ssh.cmd");
      Object.defineProperty(process, "platform", { value: "win32" });
      process.env["PATHEXT"] = ".EXE;.CMD;.BAT";
      const e = missing(() => requireTool("ssh"));
      expect(e.message).toContain("batch shim");
      expect(e.suggestions).toContain("Or make sure a real ssh.exe is on PATH");
    },
  );

  it("E189: buildSshArgs adds ConnectTimeout only when asked (I11)", () => {
    const ep = { host: "h.example.test", port: 22000 };
    const plain = buildSshArgs(ep, ["ls"]);
    expect(plain).toEqual([
      "-p",
      "22000",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "BatchMode=yes",
      "root@h.example.test",
      "ls",
    ]);
    expect(plain.join(" ")).not.toContain("ConnectTimeout");
    const timed = buildSshArgs(ep, ["true"], { connectTimeoutSec: 10 });
    expect(timed.slice(4, 8)).toEqual([
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
    ]);
  });

  it.skipIf(REAL_PLATFORM === "win32")(
    "posix: a non-executable `ssh` on PATH is TRANSFER_TOOL_MISSING (N3)",
    () => {
      pathWith("ssh", 0o644);
      expect(missing(() => requireTool("ssh")).code).toBe(
        "TRANSFER_TOOL_MISSING",
      );
    },
  );

  it.skipIf(REAL_PLATFORM === "win32")(
    "posix: an executable `ssh` is found",
    () => {
      pathWith("ssh", 0o755);
      expect(requireTool("ssh")).toMatch(/ssh$/);
    },
  );
});
