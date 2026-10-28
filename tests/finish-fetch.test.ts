import { describe, expect, it } from "vitest";
import { decodeRemote, ok, type SpawnCall } from "./helpers/job-records.js";
import { runCli } from "./helpers/run-cli.js";
import {
  build,
  finished,
  listing,
  vastCalls,
  withLog,
} from "./helpers/finish-world.js";

describe("finish: fetching and verifying", () => {
  const place =
    (size: number) =>
    (call: SpawnCall, put: (p: string, s: number) => void) => {
      put(call.args[call.args.length - 1]!, size);
      return ok();
    };

  it("fetches a file with scp -r, resolving a relative remote against the job cwd", async () => {
    const w = build({
      probes: [finished({ cwd: "/workspace/proj" })],
      list: listing([5, "/workspace/proj/out/m.pt"]),
      scp: place(5),
    });
    const out = await runCli(
      ["finish", "42", "--fetch", "out/m.pt:./res/m.pt"],
      { registry: w.registry },
    );
    expect(out.exitCode).toBe(0);
    expect(w.scpCalls).toHaveLength(1);
    expect(w.scpCalls[0]!.file).toBe("scp");
    expect(w.scpCalls[0]!.args).toEqual([
      "-P",
      "2222",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "BatchMode=yes",
      "-r",
      "root@1.2.3.4:/workspace/proj/out/m.pt",
      "./res/m.pt",
    ]);
    expect(out.stdout).toContain("fetch[1]{remote,local,files,bytes,ok,note}:");
    expect(out.stdout).toContain("/workspace/proj/out/m.pt,./res/m.pt,1,5,yes");
    expect(decodeRemote(w.listCalls[0]!.args)).toContain(
      "find -H '/workspace/proj/out/m.pt'",
    );
  });

  it("E50: a Windows drive in the local part is kept (first-colon split)", async () => {
    const w = build({
      probes: [finished()],
      list: listing([7, "/workspace/out/m.pt"]),
      scp: place(7),
    });
    const out = await runCli(
      ["finish", "42", "--fetch", "out/m.pt:C:\\res\\m.pt"],
      { registry: w.registry },
    );
    expect(out.exitCode).toBe(0);
    expect(w.scpCalls[0]!.args.slice(-2)).toEqual([
      "root@1.2.3.4:/workspace/out/m.pt",
      "C:\\res\\m.pt",
    ]);
  });

  it("E50: a fetch spec without a colon exits 2 before any ssh", async () => {
    const w = build({ probes: [finished()] });
    const out = await runCli(["finish", "42", "--fetch", "out/m.pt"], {
      registry: w.registry,
    });
    expect(out.exitCode).toBe(2);
    expect(out.stdout).toContain("--fetch needs <remote>:<local>");
    expect(w.calls).toHaveLength(0);
  });

  it("fetches several specs and a directory with every file verified", async () => {
    const w = build({
      probes: [finished()],
      list:
        "@vaxi spec 0\n3 /workspace/out/a\n4 /workspace/out/d/b\n@vaxi end\n" +
        "@vaxi spec 1\n9 /workspace/log.txt\n@vaxi end\n",
      scp: (call, put) => {
        const local = call.args[call.args.length - 1]!;
        if (call.args.includes("root@1.2.3.4:/workspace/out")) {
          put(`${local}/a`, 3);
          put(`${local}/d/b`, 4);
        } else put(local, 9);
        return ok();
      },
    });
    const out = await runCli(
      [
        "finish",
        "42",
        "--fetch",
        "out:./o",
        "--fetch",
        "/workspace/log.txt:./l.txt",
      ],
      { registry: w.registry },
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("fetch[2]");
    expect(out.stdout).toContain("/workspace/out,./o,2,7,yes");
    expect(out.stdout).toContain("/workspace/log.txt,./l.txt,1,9,yes");
    expect(w.scpCalls).toHaveLength(2);
  });

  it("E47: a target missing remotely is ok: no, nothing is copied, the instance is kept", async () => {
    const { log, env } = withLog();
    const w = build({
      probes: [finished()],
      list: "@vaxi spec 0\n@vaxi absent\n",
    });
    const out = await runCli(
      ["finish", "42", "--fetch", "nope:./n", "--destroy"],
      { registry: w.registry, env },
    );
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("not found on the instance");
    expect(out.stdout).toContain(",no,");
    expect(out.stdout).toContain("kept #42");
    expect(out.stdout).toContain("fetch(es) not verified");
    expect(w.scpCalls).toHaveLength(0);
    expect(vastCalls(log, "destroy")).toHaveLength(0);
  });

  it("E48: a local size mismatch is ok: no and the instance is kept", async () => {
    const { log, env } = withLog();
    const w = build({
      probes: [finished()],
      list: listing([10, "/workspace/out/m.pt"]),
      scp: place(6),
    });
    const out = await runCli(
      ["finish", "42", "--fetch", "out/m.pt:./m.pt", "--destroy"],
      { registry: w.registry, env },
    );
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("size 6 != 10");
    expect(out.stdout).toContain("kept #42");
    expect(vastCalls(log, "destroy")).toHaveLength(0);
  });

  it("E48: an empty target (0 bytes on both sides) is ok: no", async () => {
    const w = build({
      probes: [finished()],
      list: listing([0, "/workspace/out/empty"]),
      scp: place(0),
    });
    const out = await runCli(["finish", "42", "--fetch", "out/empty:./e"], {
      registry: w.registry,
    });
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("0 bytes fetched");
  });

  it("E48: a file scp claims to have copied but that is absent locally is ok: no", async () => {
    const w = build({
      probes: [finished()],
      list: listing([4, "/workspace/out/m.pt"]),
      scp: () => ok(),
    });
    const out = await runCli(["finish", "42", "--fetch", "out/m.pt:./m.pt"], {
      registry: w.registry,
    });
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("missing locally");
  });

  it("a failing scp is a row with the reason, not a crash", async () => {
    const w = build({
      probes: [finished()],
      list: listing([4, "/workspace/out/m.pt"]),
      scp: () => ({ exitCode: 1, stdout: "", stderr: "Permission denied" }),
    });
    const out = await runCli(["finish", "42", "--fetch", "out/m.pt:./m.pt"], {
      registry: w.registry,
    });
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("scp failed: Permission denied");
  });
});
