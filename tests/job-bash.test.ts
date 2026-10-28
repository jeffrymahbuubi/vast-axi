// Runs the generated launcher, run.sh and probe under a REAL local bash with
// HOME pointed at a temp dir (Git Bash on Windows). No ssh, scp or vastai.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  buildLaunchScript,
  buildProbeScript,
  buildRemoteCommand,
  cleanTail,
  jobStatus,
  newToken,
  parseProbeOutput,
  type JobRecord,
  type JobSpec,
  type ProbeResult,
  type Selector,
} from "../src/job.js";
import { findOnPath } from "../src/transfer.js";

const WIN = process.platform === "win32";

/** Git Bash on Windows (never System32\bash.exe, the WSL launcher); bash on PATH elsewhere. */
function findBash(): string | undefined {
  const env = process.env["VAST_AXI_TEST_BASH"];
  const candidates: string[] = env ? [env] : [];
  if (WIN) {
    const git = findOnPath("git");
    if (git)
      candidates.push(join(dirname(git), "..", "usr", "bin", "bash.exe"));
    candidates.push("C:\\Program Files\\Git\\usr\\bin\\bash.exe");
  } else {
    const found = findOnPath("bash");
    if (found) candidates.push(found);
  }
  return candidates.find((c) => {
    const r = spawnSync(c, ["-c", "echo ok"], {
      encoding: "utf8",
      env: bashEnv(c, ""),
    });
    return r.status === 0 && r.stdout.trim() === "ok";
  });
}

function bashEnv(
  bash: string,
  home: string,
  extraPath = "",
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.toLowerCase() !== "path") env[k] = v;
  }
  const parts = [
    extraPath,
    WIN ? dirname(bash) : "",
    process.env["PATH"] ?? "",
  ];
  env["PATH"] = parts.filter(Boolean).join(delimiter);
  if (home) env["HOME"] = home;
  return env;
}

/** `C:\a\b` to `/c/a/b` for Git Bash; unchanged elsewhere. */
function bashPath(p: string): string {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  return WIN && m ? `/${m[1]!.toLowerCase()}/${m[2]!.replace(/\\/g, "/")}` : p;
}

const bash = findBash();
const suite = bash ? describe : describe.skip;
if (!bash) {
  console.warn(
    "job-bash tests skipped: no usable bash found (set VAST_AXI_TEST_BASH)",
  );
}

suite("generated scripts under real bash", () => {
  let home: string;
  let work: string;
  let shim: string;
  let n = 0;

  beforeAll(() => {
    shim = mkdtempSync(join(tmpdir(), "vaxi-shim-"));
    // Git Bash has no setsid; a pass-through stand-in keeps the launcher testable.
    writeFileSync(join(shim, "setsid"), '#!/bin/bash\nexec "$@"\n');
    chmodSync(join(shim, "setsid"), 0o755);
  });

  /** A fresh HOME and work dir per test so job names and logs never collide. */
  function fresh(): void {
    home = mkdtempSync(join(tmpdir(), `vaxi-home${++n}-`));
    work = join(home, "work");
    mkdirSync(work);
  }

  const sh = (script: string) =>
    spawnSync(bash!, ["-c", script], {
      encoding: "utf8",
      env: bashEnv(bash!, home, shim),
    });

  const spec = (command: string, over: Partial<JobSpec> = {}): JobSpec => ({
    name: "main",
    token: newToken(),
    cwd: bashPath(work),
    log: `${bashPath(work)}/run.log`,
    command,
    ...over,
  });

  const launch = (s: JobSpec, overwrite = false): ProbeResult =>
    parseProbeOutput(
      sh(buildRemoteCommand(buildLaunchScript({ ...s, overwrite }, 20))).stdout,
    );

  const probe = (sel: Selector): ProbeResult =>
    parseProbeOutput(sh(buildRemoteCommand(buildProbeScript(sel, 20))).stdout);

  const only = (r: ProbeResult): JobRecord => {
    if (r.kind !== "jobs")
      throw new Error(`expected a job record, got ${r.kind}`);
    return r.jobs[0]!;
  };
  const logText = (): string => readFileSync(join(work, "run.log"), "utf8");
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  /** Run `command` only after release(): keeps a job alive for exactly as long as a test needs, however slow the machine. */
  const hold = (command: string) =>
    `while [ ! -f '${bashPath(work)}/GO' ]; do sleep 0.2; done; ${command}`;
  const release = () => {
    if (work) writeFileSync(join(work, "GO"), "");
  };
  afterEach(release);
  const MARKER_LINE =
    /^__VAST_AXI_EXIT__ [0-9a-f]{24} code=0 end=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/m;

  it("run.sh appends the marker line with this run's token and the right code", () => {
    fresh();
    const s = spec("echo hello; echo oops >&2");
    const rec = only(launch(s));
    expect(jobStatus(rec)).toMatchObject({ state: "finished", exitCode: 0 });
    const log = logText();
    expect(log).toContain("hello\n");
    expect(log).toContain("oops\n");
    expect(log).toMatch(MARKER_LINE);
    expect(log).toContain(`__VAST_AXI_EXIT__ ${s.token} code=0 end=`);
    const exit = readFileSync(join(home, ".vast-axi/jobs/main/exit"), "utf8");
    expect(exit).toMatch(/^0 \d{4}-/);
  });

  it("a non-zero exit code becomes state failed with that code", () => {
    fresh();
    const rec = only(launch(spec("exit 7")));
    expect(jobStatus(rec)).toMatchObject({ state: "failed", exitCode: 7 });
  });

  it("E38: a command that fails at once is reported failed with its tail", () => {
    fresh();
    const rec = only(launch(spec("definitely-not-a-command-xyz")));
    const status = jobStatus(rec);
    expect(status).toMatchObject({ state: "failed", exitCode: 127 });
    expect(cleanTail(rec, 5).join("\n")).toContain(
      "definitely-not-a-command-xyz",
    );
  });

  it("E37: pipes, quotes, $VAR and unicode reach bash unchanged", () => {
    fresh();
    const command = `printf '%s\\n' "a | b" 'it'"'"'s $HOME' "\u00fcn\u00ef \u2603" | cat; echo "$ZZZ-unset"; echo '$(echo no)'`;
    const rec = only(launch(spec(command)));
    expect(jobStatus(rec).state).toBe("finished");
    const log = logText();
    expect(log).toContain("a | b\n");
    expect(log).toContain("it's $HOME\n");
    expect(log).toContain("\u00fcn\u00ef \u2603\n");
    expect(log).toContain("-unset\n");
    expect(log).toContain("$(echo no)\n");
    expect(readFileSync(join(home, ".vast-axi/jobs/main/cmd"), "utf8")).toBe(
      `${command}\n`,
    );
    expect(rec.cmd).toBe(command);
  });

  it("E39: the launcher returns while the job keeps running, and it finishes later", async () => {
    fresh();
    const rec = only(launch(spec(hold("echo done-later"))));
    expect(jobStatus(rec).state).toBe("running");
    expect(rec.alive).toBe(true);
    release();
    let later = rec;
    for (let i = 0; i < 20 && jobStatus(later).state === "running"; i++) {
      await wait(500);
      later = only(probe({ kind: "name", name: "main" }));
    }
    expect(jobStatus(later)).toMatchObject({ state: "finished", exitCode: 0 });
    expect(logText()).toContain("done-later");
  });

  it("E40: marker text without this run's token does not finish the job", () => {
    fresh();
    const fake = `printf '\\n__VAST_AXI_EXIT__ deadbeefdeadbeefdeadbeef code=0 end=2020-01-01T00:00:00Z\\n'; ${hold("true")}`;
    const rec = only(launch(spec(fake)));
    expect(rec.marker).toBeUndefined();
    expect(jobStatus(rec).state).toBe("running");
    expect(logText()).toContain("__VAST_AXI_EXIT__ deadbeef");
  });

  it("E41: a killed wrapper is lost, not running or finished", () => {
    fresh();
    const rec = only(launch(spec(hold("true"))));
    expect(jobStatus(rec).state).toBe("running");
    sh(`kill -9 ${rec.pid}`);
    const after = only(probe({ kind: "name", name: "main" }));
    expect(after.alive).toBe(false);
    expect(jobStatus(after)).toMatchObject({ state: "lost" });
    expect(jobStatus(after).exitCode).toBeUndefined();
  });

  it("E42: a live pid that does not carry the run's token is not alive", () => {
    fresh();
    const rec = only(launch(spec(hold("true"))));
    expect(rec.alive).toBe(true);
    // Simulates pid reuse: the pid is alive but belongs to another run.
    writeFileSync(
      join(home, ".vast-axi/jobs/main/token"),
      "feedfacefeedfacefeedface\n",
    );
    const after = only(probe({ kind: "name", name: "main" }));
    const procEnviron = sh("[ -r /proc/$$/environ ]").status === 0;
    if (procEnviron) {
      expect(after.alive).toBe(false);
      expect(jobStatus(after).state).toBe("lost");
    } else {
      // No /proc: the check degrades to kill -0 alone.
      expect(after.alive).toBe(true);
    }
  });

  it("E34: a missing cwd is reported by the launcher and no job starts", () => {
    fresh();
    const r = launch(spec("echo x", { cwd: `${bashPath(work)}/nope` }));
    expect(r.kind).toBe("nocwd");
    expect(existsSync(join(home, ".vast-axi/jobs/main/run.sh"))).toBe(false);
  });

  it("E35: an existing log is refused unless overwrite, which truncates it", () => {
    fresh();
    writeFileSync(join(work, "run.log"), "old content\n");
    expect(launch(spec("echo new")).kind).toBe("logexists");
    expect(logText()).toBe("old content\n");
    const rec = only(launch(spec("echo new"), true));
    expect(jobStatus(rec).state).toBe("finished");
    expect(logText()).not.toContain("old content");
    expect(logText()).toContain("new\n");
  });

  it("E36: a name that is still running is refused", () => {
    fresh();
    only(launch(spec(hold("true"))));
    const second = launch(
      spec("echo again", { log: `${bashPath(work)}/other.log` }),
    );
    expect(second.kind).toBe("running");
  });

  it("E43: tqdm carriage-return progress shows only the last segment", () => {
    fresh();
    const rec = only(
      launch(spec("printf 'ep 1/3\\rep 2/3\\rep 3/3\\ndone\\n'")),
    );
    expect(cleanTail(rec, 10)).toEqual(["ep 3/3", "done"]);
  });

  it("E44: only the requested tail crosses the wire for a huge log", () => {
    fresh();
    const rec = only(launch(spec("seq 1 200000"), false));
    expect(rec.size).toBeGreaterThan(1_000_000);
    expect(rec.tailText!.length).toBeLessThan(2_000);
    expect(cleanTail(rec, 3)).toEqual(["199998", "199999", "200000"]);
  });

  it("E51: a secret printed by the job is redacted in the tail", () => {
    fresh();
    const hex = "ab".repeat(24);
    const rec = only(launch(spec(`echo token=${hex}`)));
    expect(cleanTail(rec, 5).join("\n")).not.toContain(hex);
    expect(cleanTail(rec, 5).join("\n")).toContain("<redacted>");
  });

  it("selects by --log (absolute and cwd-relative), lists all, and reports unknown names", () => {
    fresh();
    only(launch(spec("echo a")));
    only(
      launch(
        spec("exit 2", { name: "second", log: `${bashPath(work)}/two.log` }),
      ),
    );
    const byLog = only(
      probe({ kind: "log", log: `${bashPath(work)}/two.log` }),
    );
    expect(byLog.name).toBe("second");
    expect(only(probe({ kind: "log", log: "two.log" })).name).toBe("second");
    const all = probe({ kind: "all" });
    expect(all.kind === "jobs" && all.jobs.map((j) => j.name).sort()).toEqual([
      "main",
      "second",
    ]);
    expect(probe({ kind: "name", name: "ghost" }).kind).toBe("notfound");
    expect(probe({ kind: "log", log: "/nowhere.log" }).kind).toBe("notfound");
  });

  it("an empty jobs dir lists as nojobs", () => {
    fresh();
    expect(probe({ kind: "all" }).kind).toBe("nojobs");
  });

  it("the exit file stands in when the log is deleted", () => {
    fresh();
    only(launch(spec("exit 4")));
    writeFileSync(join(work, "run.log"), "");
    sh(`rm -f '${bashPath(work)}/run.log'`);
    const rec = only(probe({ kind: "name", name: "main" }));
    expect(rec.hasLog).toBe(false);
    expect(jobStatus(rec)).toMatchObject({ state: "failed", exitCode: 4 });
  });
});
