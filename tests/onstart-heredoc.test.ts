// The heredoc payload under a REAL local bash: setup.sh and run.sh must land on
// disk byte for byte, whatever the script holds. Skipped when no bash exists.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildRunScript } from "../src/job.js";
import {
  buildOnstartLauncher,
  buildOnstartText,
  heredocDelimiter,
  onstartJobCommand,
} from "../src/onstart.js";
import { prepareOnstart } from "../src/rent-onstart.js";
import { WIN, bashPath, findBash } from "./helpers/bash.js";

const bash = findBash();
const suite = bash ? describe : describe.skip;

const TOKEN = "aabbccddeeff00112233aabb";
/** The delimiter these tests' token gets first; scripts below try to collide with it. */
const FIRST = heredocDelimiter(TOKEN, []);
/** Every case starts with `exit 0` so the detached job never runs the odd lines. */
const INERT = "exit 0\n";

suite("E90: the heredoc payload round trip under real bash", () => {
  let shim: string;
  let home: string;
  let n = 0;

  beforeAll(() => {
    shim = mkdtempSync(join(tmpdir(), "vaxi-heredoc-shim-"));
    writeFileSync(join(shim, "setsid"), '#!/bin/bash\nexec "$@"\n');
    chmodSync(join(shim, "setsid"), 0o755);
  });

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
  const sh = (code: string) =>
    spawnSync(bash!, ["-c", code], { encoding: "utf8", env: env() });
  const fresh = () => {
    home = mkdtempSync(join(tmpdir(), `vaxi-heredoc-home${++n}-`));
  };
  const jobPath = (f: string) => join(home, ".vast-axi/jobs/onstart", f);
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  async function untilExit(): Promise<void> {
    for (let i = 0; i < 80 && !existsSync(jobPath("exit")); i++) {
      await wait(100);
    }
    expect(existsSync(jobPath("exit"))).toBe(true);
  }

  /** Boot the launcher for `script`, then compare setup.sh and run.sh with the input bytes. */
  function roundTrip(script: string, pip?: string[]): void {
    fresh();
    const spec = {
      script,
      token: TOKEN,
      home: bashPath(home),
      ...(pip ? { pip } : {}),
    };
    expect(
      spawnSync(bash!, ["-n"], {
        input: buildOnstartLauncher(spec),
        encoding: "utf8",
      }).status,
    ).toBe(0);
    const r = sh(buildOnstartText(spec));
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    const written = readFileSync(jobPath("setup.sh"));
    expect(written.equals(Buffer.from(script, "utf8"))).toBe(true);
    const run = buildRunScript({
      name: "onstart",
      token: TOKEN,
      cwd: bashPath(home),
      log: `${bashPath(home)}/.vast-axi/jobs/onstart/onstart.log`,
      command: onstartJobCommand({ script, ...(pip ? { pip } : {}) }),
    });
    expect(readFileSync(jobPath("run.sh")).equals(Buffer.from(run))).toBe(true);
  }

  const nasty = [
    "'single' \"double\" it's",
    "$VAR ${VAR:-x} $(cmd) `backtick` $((1+2)) !history",
    "back\\slash \\n \\\\ \\$ trailing\\",
    "  leading spaces\tand\ttabs\t",
    "",
    "   ",
    "EOF",
    "'EOF'",
    "<<EOF",
    "VAXI",
    `${FIRST} `,
    ` ${FIRST}`,
    `x${FIRST}`,
    "ünïcöde ☃ \u{1F600} 中文",
  ];

  // Git Bash (MSYS) drops a bare CR from heredoc text; Linux bash, where the
  // onstart runs, keeps it. CRLF pairs are converted to LF before this point.
  (WIN ? it.skip : it)("a bare CR inside a line survives (Linux bash)", () => {
    roundTrip(`${INERT}lone cr\rhere\n`);
  });

  it("keeps quotes, expansions, backslashes, whitespace, EOF lines and unicode byte for byte", () => {
    roundTrip(`${INERT}${nasty.join("\n")}\n`);
  });

  it("E90: no trailing newline is preserved exactly", () => {
    roundTrip(`${INERT}echo end`);
    roundTrip("exit 0");
    roundTrip(`${INERT}echo backslash-last\\`);
    roundTrip(`${INERT}${nasty.join("\n")}`);
  });

  it("E90: trailing and leading blank lines survive", () => {
    roundTrip(`${INERT}echo x\n\n\n`);
    roundTrip(`\n\n${INERT}echo x\n`);
    roundTrip(`${INERT}echo x\n\n`);
  });

  it("E90: a line equal to the first-choice delimiter moves the launcher to the next one", () => {
    for (const script of [
      `${INERT}${FIRST}\necho after\n`,
      `${INERT}echo before\n${FIRST}`,
      `${INERT}${FIRST}\n${FIRST}1\n${FIRST}2\nrest\n`,
    ]) {
      expect(buildOnstartLauncher({ script, token: TOKEN })).not.toContain(
        `<<'${FIRST}'`,
      );
      roundTrip(script);
    }
  });

  it("E90: a 2.5 KB script of varied lines round-trips", () => {
    const lines = Array.from(
      { length: 50 },
      (_, i) => `echo "step ${i}: $HOME 'q' \\\`x\\\` é"; # ${"y".repeat(20)}`,
    );
    const script = `${INERT}${lines.join("\n")}\n`;
    expect(script.length).toBeGreaterThan(2500);
    roundTrip(script);
    roundTrip(script.slice(0, -1));
  });

  it("E90: with --pip the script still arrives intact", () => {
    roundTrip(`${INERT}echo "$HOME"\n`, ["numpy", "pandas>=2"]);
  });

  it("E90: CRLF input is converted to LF by rent and the converted bytes land on disk", () => {
    fresh();
    const file = join(home, "in.sh");
    writeFileSync(file, "echo one\r\necho two\r\necho three");
    const plan = prepareOnstart({ file, allowSecrets: false });
    expect(plan).toBeDefined();
    // Re-home the launcher: the plan's text uses /root, so build from the same bytes.
    const lf = "echo one\necho two\necho three";
    const text = buildOnstartText({
      script: lf,
      token: TOKEN,
      home: bashPath(home),
    });
    expect(sh(text).status).toBe(0);
    expect(readFileSync(jobPath("setup.sh"), "utf8")).toBe(lf);
    expect(plan!.text).not.toContain("\r");
  });

  it("E90: the whole text is one line and passes `bash -n`", () => {
    const text = buildOnstartText({
      script: `${INERT}${nasty.join("\n")}`,
      pip: ["numpy"],
      token: TOKEN,
    });
    expect(text).not.toMatch(/[\r\n]/);
    expect(
      spawnSync(bash!, ["-n"], { input: text, encoding: "utf8" }).status,
    ).toBe(0);
  });

  it("E92: restarting with a newline-less script yields one fresh record and the same bytes", async () => {
    fresh();
    const script = `echo x >> "$HOME/boots"\necho done`;
    const text = buildOnstartText({
      script,
      token: TOKEN,
      home: bashPath(home),
    });
    expect(sh(text).status).toBe(0);
    await untilExit();
    expect(readFileSync(jobPath("onstart.log"), "utf8")).toContain("done");
    // Same stored text runs again on container restart.
    expect(sh(text).status).toBe(0);
    await untilExit();
    expect(readFileSync(jobPath("setup.sh"), "utf8")).toBe(script);
    expect(readFileSync(join(home, "boots"), "utf8")).toBe("x\nx\n");
    const log = readFileSync(jobPath("onstart.log"), "utf8");
    expect(log.match(/__VAST_AXI_EXIT__/g)).toHaveLength(1);
    expect(log.match(/done/g)).toHaveLength(1);
  });
});
