// Runs the generated onstart text under a REAL local bash with HOME pointed at
// a temp dir (Git Bash on Windows). python3/pip/setsid are shims; no ssh,
// scp or vastai, and nothing is installed.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  buildProbeScript,
  buildRemoteCommand,
  jobStatus,
  parseProbeOutput,
  type JobRecord,
} from "../src/job.js";
import { buildOnstartText, type OnstartSpec } from "../src/onstart.js";
import { WIN, bashPath, findBash, heredocBody } from "./helpers/bash.js";

const bash = findBash();
const suite = bash ? describe : describe.skip;
if (!bash) {
  console.warn(
    "onstart-bash tests skipped: no usable bash found (set VAST_AXI_TEST_BASH)",
  );
}

const TOKEN = "aabbccddeeff00112233aabb";

suite("the onstart text under real bash", () => {
  let shim: string;
  let home: string;
  let n = 0;

  beforeAll(() => {
    shim = mkdtempSync(join(tmpdir(), "vaxi-onstart-shim-"));
    const write = (name: string, body: string) => {
      writeFileSync(join(shim, name), `#!/bin/bash\n${body}\n`);
      chmodSync(join(shim, name), 0o755);
    };
    // Git Bash has no setsid; a pass-through stand-in keeps the launcher testable.
    write("setsid", 'exec "$@"');
    // python3 / pip record their argv and exit with the code in $HOME/pip-rc.
    const pip =
      'echo "$(basename "$0") $*" >> "$HOME/pip.log"; echo pip >> "$HOME/order.log"; exit "$(cat "$HOME/pip-rc" 2>/dev/null || echo 0)"';
    write("python3", pip);
    write("pip", pip);
  });

  function fresh(): void {
    home = mkdtempSync(join(tmpdir(), `vaxi-onstart-home${++n}-`));
  }

  const env = (): NodeJS.ProcessEnv => {
    const e: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k.toLowerCase() !== "path") e[k] = v;
    }
    e["PATH"] = [shim, WIN ? dirname(bash!) : "", process.env["PATH"] ?? ""]
      .filter(Boolean)
      .join(delimiter);
    e["HOME"] = home;
    return e;
  };
  const sh = (script: string) =>
    spawnSync(bash!, ["-c", script], { encoding: "utf8", env: env() });

  const spec = (over: Partial<OnstartSpec>): OnstartSpec => ({
    token: TOKEN,
    home: bashPath(home),
    ...over,
  });
  const boot = (over: Partial<OnstartSpec>) => sh(buildOnstartText(spec(over)));

  const probe = (): JobRecord | undefined => {
    const r = parseProbeOutput(
      sh(
        buildRemoteCommand(
          buildProbeScript({ kind: "name", name: "onstart" }, 50),
        ),
      ).stdout,
    );
    return r.kind === "jobs" ? r.jobs[0] : undefined;
  };
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  /**
   * Poll the way `status --wait` does until the onstart job is no longer
   * running. A `lost` reading only counts after it persists, because the
   * wrapper needs a few ms to write its pid after the launcher returns.
   */
  async function settled(): Promise<JobRecord> {
    let lost = 0;
    for (let i = 0; i < 80; i++) {
      const rec = probe();
      const state = rec ? jobStatus(rec).state : "running";
      lost = state === "lost" ? lost + 1 : 0;
      if (rec && (state === "finished" || state === "failed" || lost >= 8)) {
        return rec;
      }
      await wait(250);
    }
    throw new Error("the onstart job never finished");
  }
  /** Wait until the freshly started job is reported running. */
  async function running(): Promise<JobRecord> {
    for (let i = 0; i < 40; i++) {
      const rec = probe();
      if (rec && jobStatus(rec).state === "running") return rec;
      await wait(100);
    }
    throw new Error("the onstart job never showed as running");
  }
  const read = (rel: string) => readFileSync(join(home, rel), "utf8");
  const jobFile = (f: string) => read(`.vast-axi/jobs/onstart/${f}`);

  it("the text, its launcher and run.sh all pass `bash -n`", () => {
    fresh();
    const text = buildOnstartText(
      spec({ pip: ["numpy", "pandas>=2"], script: "echo hi\nls | wc -l\n" }),
    );
    const check = (code: string) =>
      spawnSync(bash!, ["-n"], { input: code, encoding: "utf8" });
    expect(check(text).status).toBe(0);
    const launcher = Buffer.from(
      /echo (\S+) \| base64/.exec(text)![1]!,
      "base64",
    ).toString("utf8");
    expect(check(launcher).status).toBe(0);
    const run = heredocBody(launcher, "run.sh");
    expect(run).toContain("#!/bin/bash");
    expect(check(run).status).toBe(0);
  });

  it("script only: runs in the home dir, keeps the script byte for byte, job finished", async () => {
    fresh();
    const script = `echo "start $PWD"\nprintf '%s\\n' "it's $HOME" '$(no)' "\u00fcn\u00ef \u2603"\n`;
    const r = boot({ script });
    expect(r.status).toBe(0);
    const rec = await settled();
    expect(jobStatus(rec)).toMatchObject({ state: "finished", exitCode: 0 });
    expect(rec.log).toBe(
      `${bashPath(home)}/.vast-axi/jobs/onstart/onstart.log`,
    );
    expect(jobFile("setup.sh")).toBe(script);
    const log = jobFile("onstart.log");
    expect(log).toContain(`start ${bashPath(home)}`);
    expect(log).toContain("it's ");
    expect(log).toContain("$(no)\n");
    expect(log).toContain("\u00fcn\u00ef \u2603\n");
    expect(log).toContain(`__VAST_AXI_EXIT__ ${TOKEN} code=0 end=`);
  });

  it("pip only: python3 -m pip install with the quoted specs, job finished", async () => {
    fresh();
    boot({ pip: ["numpy==1.26.4", "uvicorn[standard]>=0.30"] });
    const rec = await settled();
    expect(jobStatus(rec).state).toBe("finished");
    expect(read("pip.log")).toBe(
      "python3 -m pip install --no-input numpy==1.26.4 uvicorn[standard]>=0.30\n",
    );
    expect(existsSync(join(home, ".vast-axi/jobs/onstart/setup.sh"))).toBe(
      false,
    );
  });

  it("both: pip runs first, then the script", async () => {
    fresh();
    boot({
      pip: ["numpy"],
      script: `echo setup >> "$HOME/order.log"\necho script-output\n`,
    });
    const rec = await settled();
    expect(jobStatus(rec).state).toBe("finished");
    expect(read("order.log")).toBe("pip\nsetup\n");
    expect(jobFile("onstart.log")).toContain("script-output");
  });

  it("both: a failing pip step fails the job and the script never runs", async () => {
    fresh();
    writeFileSync(join(home, "pip-rc"), "1");
    boot({
      pip: ["numpy"],
      script: `echo setup >> "$HOME/order.log"\n`,
    });
    const rec = await settled();
    expect(jobStatus(rec)).toMatchObject({ state: "failed", exitCode: 1 });
    // python3 and the pip fallback both ran, the script did not.
    expect(read("order.log")).toBe("pip\npip\n");
    expect(read("pip.log")).toContain("pip install --no-input numpy");
  });

  it("both: a failing script fails the job with its exit code", async () => {
    fresh();
    boot({ pip: ["numpy"], script: "echo before\nexit 3\n" });
    const rec = await settled();
    expect(jobStatus(rec)).toMatchObject({ state: "failed", exitCode: 3 });
    expect(jobFile("onstart.log")).toContain("before");
  });

  it("E78: a second start replaces the record, so job and status see the latest boot", async () => {
    fresh();
    const script = `echo x >> "$HOME/boots"\necho "boot $(wc -l < "$HOME/boots" | tr -d ' ')"\n`;
    boot({ script });
    const first = await settled();
    expect(jobStatus(first).state).toBe("finished");
    expect(jobFile("onstart.log")).toContain("boot 1");

    // The container restarts: vast.ai runs the same stored text again.
    boot({ script });
    const second = await settled();
    expect(jobStatus(second).state).toBe("finished");
    const log = jobFile("onstart.log");
    expect(log).toContain("boot 2");
    expect(log).not.toContain("boot 1");
    expect(log.match(/__VAST_AXI_EXIT__/g)).toHaveLength(1);
    expect(second.start! >= first.start!).toBe(true);
    expect(second.markerLine).toBeDefined();
  });

  it("E78: while the restarted job runs it is running with no marker, not the old finished one", async () => {
    fresh();
    const go = join(home, "GO");
    const script = `while [ ! -f '${bashPath(go)}' ]; do sleep 0.2; done
echo late
`;
    writeFileSync(go, "");
    boot({ script });
    expect(jobStatus(await settled()).state).toBe("finished");
    rmSync(go);
    boot({ script });
    const during = await running();
    expect(during.markerLine).toBeUndefined();
    expect(during.exitFile).toBeUndefined();
    writeFileSync(go, "");
    expect(jobStatus(await settled()).state).toBe("finished");
  });

  it("creates the job dir and cwd layout the `job` probe reads", async () => {
    fresh();
    boot({ script: "true\n" });
    const rec = await settled();
    expect(rec.name).toBe("onstart");
    expect(rec.cwd).toBe(bashPath(home));
    expect(rec.cmd).toBe('bash "$HOME/.vast-axi/jobs/onstart/setup.sh"');
  });
});
