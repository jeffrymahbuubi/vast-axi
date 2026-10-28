import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_REMOTE_LINE,
  buildLaunchScript,
  buildProbeScript,
  buildRemoteCommand,
  buildRunScript,
  cleanTail,
  jobStatus,
  newToken,
  parseCwd,
  parseDuration,
  parseFetchSpec,
  parseJobName,
  parseProbeOutput,
  resolveRemotePath,
  shellQuote,
  type JobRecord,
} from "../src/job.js";
import {
  buildListScript,
  expectedLocalFiles,
  parseListOutput,
  verifyFetch,
} from "../src/job-fetch.js";
import {
  decodeRemote,
  embeddedRunScript,
  record,
} from "./helpers/job-records.js";

function only(stdout: string): JobRecord {
  const r = parseProbeOutput(stdout);
  if (r.kind !== "jobs") throw new Error(`expected jobs, got ${r.kind}`);
  return r.jobs[0]!;
}

describe("validation helpers", () => {
  it("E52: parseDuration accepts 30s/15m/2h and rejects the rest", () => {
    expect(parseDuration("30s", "--poll")).toBe(30_000);
    expect(parseDuration("15m", "--poll")).toBe(900_000);
    expect(parseDuration("2h", "--timeout")).toBe(7_200_000);
    for (const bad of [
      "",
      "15",
      "m",
      "1.5h",
      "-5m",
      "0s",
      "10 m",
      "5d",
      "abc",
    ]) {
      expect(() => parseDuration(bad, "--poll")).toThrow(
        /--poll must look like/,
      );
    }
  });

  it("E52: --poll below 30s is refused (OQ23)", () => {
    expect(() => parseDuration("10s", "--poll", 30_000)).toThrow(/minimum 30s/);
    expect(parseDuration("30s", "--poll", 30_000)).toBe(30_000);
  });

  it("E52: parseJobName allows [A-Za-z0-9_.-]{1,64} and refuses path tricks", () => {
    for (const good of ["main", "train-1", "a.b_c", "x".repeat(64)]) {
      expect(parseJobName(good)).toBe(good);
    }
    for (const bad of [
      "",
      "a b",
      "a/b",
      "..",
      ".",
      "x".repeat(65),
      "\u00e4",
      "a;b",
    ]) {
      expect(() => parseJobName(bad)).toThrow(/--name/);
    }
  });

  it("E33: parseCwd refuses /, /root, ~, empty and relative paths", () => {
    for (const bad of [
      "/",
      "/root",
      "/root/",
      "~",
      "",
      "//",
      "/root/.",
      ".",
      "work",
    ]) {
      expect(() => parseCwd(bad), bad).toThrow();
    }
    expect(parseCwd("/workspace/proj/")).toBe("/workspace/proj");
    expect(parseCwd("/root/proj")).toBe("/root/proj");
    expect(() => parseCwd("/a\nb")).toThrow(/single line/);
  });

  it("resolveRemotePath resolves against cwd, normalises, and refuses ~", () => {
    expect(resolveRemotePath("out/m.pt", "/workspace/p")).toBe(
      "/workspace/p/out/m.pt",
    );
    expect(resolveRemotePath("/abs/x/", "/workspace")).toBe("/abs/x");
    expect(resolveRemotePath("../x", "/workspace/p")).toBe("/workspace/x");
    expect(() => resolveRemotePath("~/x", "/w")).toThrow(/not expanded/);
    expect(() => resolveRemotePath("", "/w")).toThrow(/empty/);
  });

  it("E53: a Git Bash-rewritten path (C:/Program Files/Git/...) is refused with the MSYS hint", () => {
    const msys = "C:/Program Files/Git/workspace/x";
    expect(() => parseCwd(msys)).toThrow(/Windows path/);
    expect(() => resolveRemotePath(msys, "/workspace", "--log")).toThrow(
      /Windows path/,
    );
    try {
      parseCwd(msys);
    } catch (e) {
      expect(JSON.stringify(e)).toMatch(/MSYS_NO_PATHCONV=1/);
    }
  });

  it("E50: parseFetchSpec splits at the first colon", () => {
    expect(parseFetchSpec("out/m.pt:C:\\res\\m.pt")).toEqual({
      remote: "out/m.pt",
      local: "C:\\res\\m.pt",
    });
    expect(parseFetchSpec("/w/out:./out")).toEqual({
      remote: "/w/out",
      local: "./out",
    });
  });

  it("E50: a spec without a colon or with an empty side is a validation error", () => {
    for (const bad of ["out/m.pt", ":local", "remote:", ""]) {
      expect(() => parseFetchSpec(bad), bad).toThrow(
        /--fetch needs <remote>:<local>/,
      );
    }
  });

  it("newToken is 24 hex characters and differs per call", () => {
    expect(newToken()).toMatch(/^[0-9a-f]{24}$/);
    expect(newToken()).not.toBe(newToken());
  });

  it("shellQuote single-quotes and escapes embedded quotes", () => {
    expect(shellQuote("a b")).toBe("'a b'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote("")).toBe("''");
  });
});

describe("generated scripts (text)", () => {
  const spec = {
    name: "train",
    token: "aabbccddeeff00112233aabb",
    cwd: "/workspace/my proj",
    log: "/workspace/my proj/run.log",
    command: `python t.py --msg "it's | $HOME" \u00fc`,
  };

  it("OQ17: run.sh writes the marker line with the run's token and code", () => {
    const s = buildRunScript(spec);
    expect(s).toContain("__VAST_AXI_EXIT__ %s code=%s end=%s");
    expect(s).toContain(`export VAST_AXI_JOB=${spec.token}`);
    expect(s).toContain(
      `printf '\\n__VAST_AXI_EXIT__ %s code=%s end=%s\\n' ${spec.token} "$code" "$end"`,
    );
    expect(s).toContain('"$HOME/.vast-axi/jobs/train"');
    expect(s).toContain("code=97");
  });

  it("E37: the command appears only as a single-quoted bash -c argument", () => {
    const s = buildRunScript(spec);
    expect(s).toContain(
      `bash -c ${shellQuote(spec.command)} >> ${shellQuote(spec.log)} 2>&1 < /dev/null`,
    );
  });

  it("E37: the remote line is plain ASCII with no double quotes or backslashes", () => {
    const line = buildRemoteCommand(
      buildLaunchScript({ ...spec, overwrite: false }, 10),
    );
    expect(line).toMatch(/^[\x20-\x7e]+$/);
    expect(line).not.toMatch(/["\\]/);
    expect(line).not.toContain("python");
    expect(embeddedRunScript(decodeRemote([line]))).toBe(buildRunScript(spec));
  });

  it("E39: the launcher detaches with nohup, setsid, stdin /dev/null and no output", () => {
    const l = buildLaunchScript({ ...spec, overwrite: false }, 10);
    expect(l).toContain(
      `VAST_AXI_JOB=${spec.token} nohup setsid bash "$d/run.sh" </dev/null >/dev/null 2>&1 &`,
    );
  });

  it("E35 and OQ19: the launcher refuses an existing log only without overwrite", () => {
    expect(buildLaunchScript({ ...spec, overwrite: false }, 5)).toContain(
      "logexists",
    );
    expect(buildLaunchScript({ ...spec, overwrite: true }, 5)).not.toContain(
      "logexists",
    );
  });

  it("E34 and OQ20: the launcher checks the cwd and never creates it", () => {
    const l = buildLaunchScript({ ...spec, overwrite: false }, 5);
    expect(l).toContain("nocwd");
    expect(l).not.toContain('mkdir -p "$CWD"');
  });

  it("E36: the launcher checks for a running job before touching anything", () => {
    const l = buildLaunchScript({ ...spec, overwrite: false }, 5);
    expect(l.indexOf("@vaxi running")).toBeGreaterThan(0);
    expect(l.indexOf("@vaxi running")).toBeLessThan(l.indexOf("run.sh"));
  });

  it("E42: the alive check compares the pid's environment with the token", () => {
    const p = buildProbeScript({ kind: "all" }, 0);
    expect(p).toContain("kill -0");
    expect(p).toContain("/proc/$pid/environ");
    expect(p).toContain('grep -qxF "VAST_AXI_JOB=$tok"');
    expect(p).toMatch(/\[ -r "\/proc\/\$pid\/environ" \]/);
  });

  it("E44: the probe never reads more than 64 KB of the log for the tail", () => {
    const p = buildProbeScript({ kind: "name", name: "main" }, 20);
    expect(p).toContain("tail -c 65536");
    expect(p).toContain('tail -n "$n"');
  });

  it("E40: the probe matches the marker with the job's own token only", () => {
    const p = buildProbeScript({ kind: "name", name: "main" }, 20);
    expect(p).toContain(
      'grep -a "^__VAST_AXI_EXIT__ $tok code=[0-9][0-9]* end="',
    );
  });

  it("buildRemoteCommand refuses a command that would overflow the command line", () => {
    const huge = { ...spec, command: "x".repeat(MAX_REMOTE_LINE) };
    expect(() =>
      buildRemoteCommand(buildLaunchScript({ ...huge, overwrite: false }, 5)),
    ).toThrow(/too long/);
  });

  it("selector probes: by log compares the path and cwd/path; unknown selector kinds are listed", () => {
    const byLog = buildProbeScript({ kind: "log", log: "two.log" }, 5);
    expect(byLog).toContain("SEL='two.log'");
    expect(byLog).toContain('"$l" = "$c/$SEL"');
    expect(buildProbeScript({ kind: "all" }, 0)).toContain("nojobs");
  });
});

describe("parseProbeOutput", () => {
  it("parses a full record and ignores banner lines", () => {
    const out =
      "Welcome to the box\n" +
      record({
        alive: true,
        cmd: "python a.py | tee x",
        size: 1536,
        tail: "line1\nline2\n",
      });
    const r = only(out);
    expect(r).toMatchObject({
      name: "main",
      pid: 4242,
      alive: true,
      cwd: "/workspace",
      log: "/workspace/run.log",
      cmd: "python a.py | tee x",
      size: 1536,
      hasLog: true,
    });
    expect(r.tailText).toBe("line1\nline2\n");
    expect(r.marker).toBeUndefined();
  });

  it("parses the marker, the exit file and a missing log", () => {
    const r = only(
      record({ marker: { code: 3, end: "2026-10-20T11:00:00Z" } }),
    );
    expect(r.marker).toEqual({ code: 3, end: "2026-10-20T11:00:00Z" });
    const g = only(record({ nolog: true, exitfile: "0 2026-10-20T11:00:00Z" }));
    expect(g.hasLog).toBe(false);
    expect(g.exitFile).toEqual({ code: 0, end: "2026-10-20T11:00:00Z" });
  });

  it("recognises the early-exit statuses and no output", () => {
    expect(parseProbeOutput("@vaxi nocwd\n").kind).toBe("nocwd");
    expect(parseProbeOutput("@vaxi running\n").kind).toBe("running");
    expect(parseProbeOutput("@vaxi logexists\n").kind).toBe("logexists");
    expect(parseProbeOutput("@vaxi notfound\n").kind).toBe("notfound");
    expect(parseProbeOutput("@vaxi missing setsid\n")).toEqual({
      kind: "missing",
      tool: "setsid",
    });
    expect(parseProbeOutput("bash: base64: command not found\n").kind).toBe(
      "empty",
    );
  });

  it("tolerates CRLF line endings", () => {
    const r = only(record().replace(/\n/g, "\r\n"));
    expect(r.name).toBe("main");
    expect(r.cwd).toBe("/workspace");
  });
});

describe("jobStatus", () => {
  it("a marker means finished (code 0) or failed (other code), with elapsed", () => {
    const done = jobStatus(
      only(record({ marker: { code: 0, end: "2026-10-20T10:30:00Z" } })),
    );
    expect(done).toMatchObject({
      state: "finished",
      exitCode: 0,
      ended: "2026-10-20T10:30:00Z",
      elapsed: "30m",
    });
    const failed = jobStatus(
      only(record({ marker: { code: 2, end: "2026-10-20T10:00:09Z" } })),
    );
    expect(failed).toMatchObject({
      state: "failed",
      exitCode: 2,
      elapsed: "9s",
    });
  });

  it("E41: no marker and not alive is lost; alive is running", () => {
    expect(jobStatus(only(record({ alive: false }))).state).toBe("lost");
    const running = jobStatus(only(record({ alive: true })));
    expect(running.state).toBe("running");
    expect(running.elapsed).toBe("5m");
  });

  it("E40: a record without the matching marker stays running", () => {
    // The shell filters by token, so an other-token marker never reaches the record.
    expect(
      jobStatus(
        only(
          record({
            alive: true,
            tail: "__VAST_AXI_EXIT__ other code=0 end=x\n",
          }),
        ),
      ).state,
    ).toBe("running");
  });

  it("the exit file stands in when the log has no marker", () => {
    const s = jobStatus(
      only(record({ nolog: true, exitfile: "5 2026-10-20T10:10:00Z" })),
    );
    expect(s).toMatchObject({ state: "failed", exitCode: 5 });
  });
});

describe("cleanTail", () => {
  const rec = (tail: string, marker?: boolean): JobRecord =>
    only(
      record({
        tail,
        ...(marker ? { marker: { code: 0, end: "2026-10-20T10:30:00Z" } } : {}),
      }),
    );

  it("E43: tqdm carriage returns collapse to the last segment", () => {
    const text =
      "x\r 10%|#         | 1/10\r 50%|#####     | 5/10\r100%|##########| 10/10\ndone\n";
    expect(cleanTail(rec(text), 10)).toEqual([
      "100%|##########| 10/10",
      "done",
    ]);
  });

  it("E51: secrets are redacted", () => {
    const hex = "0123456789abcdef".repeat(3);
    expect(cleanTail(rec(`key ${hex} end\n`), 5)).toEqual([
      "key <redacted> end",
    ]);
  });

  it("each line is cut to 400 characters with a marker of what is missing", () => {
    const [line] = cleanTail(rec(`${"z".repeat(1000)}\n`), 5);
    expect(line).toBe(`${"z".repeat(400)}[+600 chars]`);
  });

  it("drops this run's marker line and trailing blanks, then keeps the last n lines", () => {
    const tail =
      "a\nb\nc\nd\n\n__VAST_AXI_EXIT__ aabbccddeeff00112233aabb code=0 end=2026-10-20T10:30:00Z\n";
    expect(cleanTail(rec(tail, true), 2)).toEqual(["c", "d"]);
  });

  it("returns nothing for n = 0 or no tail", () => {
    expect(cleanTail(rec("a\n"), 0)).toEqual([]);
    expect(cleanTail(only(record()), 5)).toEqual([]);
  });
});

describe("fetch helpers", () => {
  it("buildListScript lists each path and parseListOutput reads sizes and absent paths", () => {
    const script = buildListScript(["/w/out", "/w/it's"]);
    expect(script).toContain("find -H '/w/out' -type f -printf '%s %p\\n'");
    expect(script).toContain(`'/w/it'\\''s'`);
    const out = [
      "@vaxi spec 0",
      "10 /w/out/a.txt",
      "2048 /w/out/sub/b bin.dat",
      "@vaxi end",
      "@vaxi spec 1",
      "@vaxi absent",
    ].join("\n");
    expect(parseListOutput(out, 2)).toEqual([
      {
        absent: false,
        files: [
          { size: 10, path: "/w/out/a.txt" },
          { size: 2048, path: "/w/out/sub/b bin.dat" },
        ],
      },
      { absent: true, files: [] },
    ]);
  });

  it("a single remote file lands on the local path, or inside an existing local directory", () => {
    const files = [{ size: 5, path: "/w/out/m.pt" }];
    expect(
      expectedLocalFiles("/w/out/m.pt", files, join("r", "m.pt"), false),
    ).toEqual([{ local: join("r", "m.pt"), size: 5 }]);
    expect(expectedLocalFiles("/w/out/m.pt", files, "res", true)).toEqual([
      { local: join("res", "m.pt"), size: 5 },
    ]);
  });

  it("a remote directory maps relative paths under the local dir (or under local/<basename> when it exists)", () => {
    const files = [
      { size: 1, path: "/w/out/a" },
      { size: 2, path: "/w/out/d/b" },
    ];
    expect(
      expectedLocalFiles("/w/out", files, "res", false).map((e) => e.local),
    ).toEqual([join("res", "a"), join("res", "d", "b")]);
    expect(
      expectedLocalFiles("/w/out", files, "res", true).map((e) => e.local),
    ).toEqual([join("res", "out", "a"), join("res", "out", "d", "b")]);
  });

  it("OQ22: verifyFetch needs every file present with the same size and more than 0 bytes", () => {
    const want = [
      { local: "a", size: 3 },
      { local: "b", size: 4 },
    ];
    const stat = (sizes: Record<string, number>) => (p: string) =>
      p in sizes ? { size: sizes[p]!, isDirectory: false } : undefined;
    expect(verifyFetch(want, stat({ a: 3, b: 4 }))).toMatchObject({
      ok: true,
      files: 2,
      bytes: 7,
    });
    expect(verifyFetch(want, stat({ a: 3 }))).toMatchObject({
      ok: false,
      note: expect.stringContaining("missing locally: b"),
    });
    expect(verifyFetch(want, stat({ a: 3, b: 9 }))).toMatchObject({
      ok: false,
      note: expect.stringContaining("size 9 != 4"),
    });
    expect(
      verifyFetch([{ local: "z", size: 0 }], stat({ z: 0 })),
    ).toMatchObject({ ok: false, note: "0 bytes fetched" });
    expect(verifyFetch([], stat({}))).toMatchObject({ ok: false });
  });
});
