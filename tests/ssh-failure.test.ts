import { describe, expect, it } from "vitest";
import { AxiError } from "../src/errors.js";
import { classifySshFailure, failureHints } from "../src/ssh-failure.js";
import { runSsh, type ToolSpawner } from "../src/transfer.js";

const EP = { host: "1.2.3.4", port: 2222 };

describe("classifySshFailure", () => {
  it.each([
    ["@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @", "hostkey"],
    ["Host key verification failed.", "hostkey"],
    ["root@h: Permission denied (publickey).", "auth"],
    ["ssh: connect to host h port 22: Connection refused", "unreachable"],
    ["Connection reset by peer", "unreachable"],
    ["Connection timed out during banner exchange", "unreachable"],
    ["kex_exchange_identification: read: Connection reset", "unreachable"],
    ["ssh: Could not resolve hostname h", "unreachable"],
    ["No route to host", "unreachable"],
    ["scp: /x: No such file or directory", "path"],
    ["scp: path canonicalization failed", "path"],
    ["scp: /x: Not a directory", "path"],
    ["something odd", "unknown"],
    ["", "unknown"],
  ] as const)("%j is %s", (stderr, kind) => {
    expect(classifySshFailure(stderr)).toBe(kind);
  });

  it("the first matching kind wins", () => {
    expect(
      classifySshFailure("Permission denied; No such file or directory"),
    ).toBe("auth");
  });
});

describe("E127: ssh exit 255 gives hints per kind", () => {
  async function failWith(stderr: string): Promise<AxiError> {
    const spawn: ToolSpawner = () =>
      Promise.resolve({ exitCode: 255, stdout: "", stderr });
    try {
      await runSsh(spawn, "ssh", 7, EP, ["true"]);
    } catch (error) {
      return error as AxiError;
    }
    throw new Error("expected SSH_FAILED");
  }

  it("auth: key hint then the boot hint", async () => {
    const e = await failWith("Permission denied (publickey).");
    expect(e.code).toBe("SSH_FAILED");
    expect(e.message).toContain("ssh could not connect to #7");
    expect(e.suggestions[0]).toContain("ssh key attached on vast.ai");
    expect(e.suggestions[1]).toContain("vast-axi status 7 --wait");
  });

  it("unreachable: wait hint then status hint, no key hint", async () => {
    const e = await failWith("Connection refused");
    expect(e.suggestions[0]).toContain("sshd on #7 is not answering");
    expect(e.suggestions[1]).toContain("vast-axi status 7`");
    expect(e.suggestions.join("\n")).not.toContain("ssh key");
  });

  it("hostkey: the ssh-keygen -R command for this host and port", async () => {
    const e = await failWith("Host key verification failed.");
    expect(e.suggestions).toEqual([
      expect.stringContaining('ssh-keygen -R "[1.2.3.4]:2222"'),
    ]);
  });

  it("unknown: status hint then the connection test", async () => {
    const e = await failWith("weird");
    expect(e.suggestions[0]).toContain("vast-axi status 7");
    expect(e.suggestions[1]).toContain("vast-axi ssh 7 --exec -- true");
    expect(failureHints("unknown", 7, EP)).toEqual(e.suggestions);
  });
});
