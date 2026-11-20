import { describe, expect, it } from "vitest";
import { joinRemoteArgv } from "../src/remote-argv.js";
import { findBash, runBash } from "./helpers/bash.js";

const bash = findBash();

describe("joinRemoteArgv", () => {
  it("E111: a word with spaces and quotes stays one remote argument", () => {
    expect(joinRemoteArgv(["python", "-c", "import a; print(f('x'))"])).toBe(
      `python -c 'import a; print(f('\\''x'\\''))'`,
    );
  });

  it("E112: one word is sent unchanged", () => {
    expect(joinRemoteArgv(["cd /w && ls | head"])).toBe("cd /w && ls | head");
  });

  it("E113: plain words stay unquoted", () => {
    expect(joinRemoteArgv(["ls", "/w/*.pt"])).toBe("ls /w/*.pt");
    expect(joinRemoteArgv(["echo", "$HOME"])).toBe("echo $HOME");
    expect(joinRemoteArgv(["ls", "~/x"])).toBe("ls ~/x");
  });

  it("E115: an empty word and a word with a newline are quoted", () => {
    expect(joinRemoteArgv(["echo", ""])).toBe("echo ''");
    expect(joinRemoteArgv(["echo", "a\nb"])).toBe("echo 'a\nb'");
  });

  it.skipIf(!bash)(
    "E114: `bash -c 'a && b'` runs both parts under real bash",
    async () => {
      const cmd = joinRemoteArgv(["bash", "-c", "echo one && echo two"]);
      expect(cmd).toBe("bash -c 'echo one && echo two'");
      const r = await runBash(bash!, ["-c", cmd]);
      expect(r.stdout.replace(/\r/g, "")).toBe("one\ntwo\n");
      const arg = await runBash(bash!, [
        "-c",
        joinRemoteArgv(["printf", "%s|", "a b", "c;d", "it's"]),
      ]);
      expect(arg.stdout).toBe("a b|c;d|it's|");
    },
  );
});
