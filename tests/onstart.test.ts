import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ONSTART_LIMIT,
  ONSTART_MARKER,
  buildOnstartLauncher,
  buildOnstartText,
  hasOnstartMarker,
  heredocDelimiter,
  onstartJobCommand,
  parsePipSpecs,
  pipCommand,
} from "../src/onstart.js";
import {
  newCallLog,
  readCallLog,
  runCli,
  type Env,
} from "./helpers/run-cli.js";

const dir = mkdtempSync(join(tmpdir(), "vaxi-onstart-"));
let n = 0;
/** Write a script file and return its path. */
function script(text: string, name = `setup${++n}.sh`): string {
  const file = join(dir, name);
  writeFileSync(file, text);
  return file;
}

const EMPTY: Env = {
  FAKE_VASTAI_ROUTES: JSON.stringify({ "show instances": { stdout: "[]" } }),
};
const IMG = ["--image", "vastai/base-image"];

async function rent(argv: string[], env: Env = {}) {
  const log = newCallLog();
  const { stdout, exitCode } = await runCli(["rent", "5001", ...IMG, ...argv], {
    env: { FAKE_VASTAI_LOG: log, ...EMPTY, ...env },
  });
  const calls = readCallLog(log);
  const created = calls.filter(
    (c) => c.tokens[0] === "create" && c.tokens[1] === "instance",
  );
  return { stdout, exitCode, calls, created };
}

/** The base64 launcher inside an onstart text. */
function launcherOf(text: string): string {
  const m =
    /^: __VAST_AXI_ONSTART__ v1; echo ([A-Za-z0-9+/=]+) \| base64 -d \| bash$/.exec(
      text,
    );
  if (!m) throw new Error(`unexpected onstart text: ${text.slice(0, 80)}`);
  return Buffer.from(m[1]!, "base64").toString("utf8");
}

describe("--pip specs (E76)", () => {
  it("splits on whitespace and keeps extras and version operators", () => {
    expect(
      parsePipSpecs("numpy  pandas==2.2.0\ttorch>=2.1,<3 uvicorn[standard]"),
    ).toEqual(["numpy", "pandas==2.2.0", "torch>=2.1,<3", "uvicorn[standard]"]);
  });

  it.each([
    ["numpy;rm", "numpy;rm"],
    ["pkg $(id)", "$(id)"],
    ["a `id`", "`id`"],
    ['"quoted"', '"quoted"'],
    ["ok 'x'", "'x'"],
    ["--index-url http://x", "--index-url"],
    ["numpy -r", "-r"],
    ["a|b", "a|b"],
    ["a&b", "a&b"],
    ["a/b", "a/b"],
  ])("E76: %s is refused, naming %s", (raw, bad) => {
    expect(() => parsePipSpecs(raw)).toThrowError(bad);
  });

  it("refuses an empty list", () => {
    expect(() => parsePipSpecs("   ")).toThrowError("at least one package");
  });

  it("single-quotes every spec and falls back to plain pip", () => {
    expect(pipCommand(["numpy", "pandas>=2"])).toBe(
      "python3 -m pip install --no-input 'numpy' 'pandas>=2' || pip install --no-input 'numpy' 'pandas>=2'",
    );
  });
});

describe("the onstart job command", () => {
  it("pip only, script only, and both with set -e between the steps", () => {
    expect(onstartJobCommand({ pip: ["numpy"] })).toBe(pipCommand(["numpy"]));
    expect(onstartJobCommand({ script: "echo hi\n" })).toBe(
      'bash "$HOME/.vast-axi/jobs/onstart/setup.sh"',
    );
    expect(onstartJobCommand({ pip: ["numpy"], script: "echo hi\n" })).toBe(
      `set -e; ${pipCommand(["numpy"])}; bash "$HOME/.vast-axi/jobs/onstart/setup.sh"`,
    );
  });
});

describe("the onstart text", () => {
  const text = buildOnstartText({
    pip: ["numpy"],
    script: "echo one\necho two\n",
    token: "aabbccddeeff00112233aabb",
  });

  it("is one line, carries the marker and fits the limit", () => {
    expect(text).not.toContain("\n");
    expect(text).toContain(ONSTART_MARKER);
    expect(hasOnstartMarker(text)).toBe(true);
    expect(text.length).toBeLessThan(ONSTART_LIMIT);
  });

  it("E78: every start rewrites the record and truncates the log before launching", () => {
    const launcher = launcherOf(text);
    expect(launcher).toContain('rm -f "$d/pid" "$d/exit" "$d/start"');
    expect(launcher).toContain(': > "$d/onstart.log"');
    expect(launcher.indexOf("rm -f")).toBeLessThan(launcher.indexOf("nohup"));
    expect(launcher).toContain("VAST_AXI_JOB=aabbccddeeff00112233aabb nohup");
  });

  it("transports the script and run.sh in quoted heredocs, one base64 layer only", () => {
    const launcher = buildOnstartLauncher({
      script: "echo LITERAL-$HOME\n",
      token: "aabbccddeeff00112233aabb",
    });
    expect(launcher).toContain(
      `cat > "$d/setup.sh" <<'VAXI_aabbccddeeff'\necho LITERAL-$HOME\nVAXI_aabbccddeeff\n`,
    );
    expect(launcher).toContain(`cat > "$d/run.sh" <<'VAXI_aabbccddeeff'\n`);
    expect(launcher).not.toContain("base64");
    // The text handed to --onstart-cmd stays one line with the marker first.
    const text = buildOnstartText({
      script: "echo hi\n",
      token: "aabbccddeeff00112233aabb",
    });
    expect(text).toMatch(/^: __VAST_AXI_ONSTART__ v1; echo [A-Za-z0-9+/=]+ \|/);
  });

  it("E90: a script without a trailing newline is read whole and printed minus the heredoc's newline", () => {
    const launcher = buildOnstartLauncher({
      script: "echo a",
      token: "aabbccddeeff00112233aabb",
    });
    expect(launcher).toContain(
      "IFS= read -rd '' b <<'VAXI_aabbccddeeff'\necho a\nVAXI_aabbccddeeff\n" +
        'printf %s "${b%$\'\\n\'}" > "$d/setup.sh"\n',
    );
  });

  it("E90: the delimiter is letters and digits only, differs per token and dodges whole-line collisions", () => {
    const a = heredocDelimiter("aabbccddeeff00112233aabb", ["x"]);
    const b = heredocDelimiter("112233445566778899aabbcc", ["x"]);
    expect(a).toMatch(/^VAXI_[A-Za-z0-9]+$/);
    expect(b).toMatch(/^VAXI_[A-Za-z0-9]+$/);
    expect(a).not.toBe(b);
    expect(heredocDelimiter("a-b_c!d", ["x"])).toBe("VAXI_abcd");
    // A whole-line match in the script or in run.sh moves to the next candidate...
    expect(heredocDelimiter("aabbccddeeff00112233aabb", ["x\n" + a])).toBe(
      `${a}1`,
    );
    expect(
      heredocDelimiter("aabbccddeeff00112233aabb", ["x", `${a}\n${a}1\n`]),
    ).toBe(`${a}2`);
    // ...a mere substring or an indented copy does not count as a terminator.
    expect(
      heredocDelimiter("aabbccddeeff00112233aabb", [` ${a}\n${a} x`]),
    ).toBe(a);
    const launcher = buildOnstartLauncher({
      script: `echo 1\n${a}\n`,
      token: "aabbccddeeff00112233aabb",
    });
    expect(launcher).toContain(`<<'${a}1'`);
  });

  it("E90: the final line of a newline-less script counts for the collision check", () => {
    const a = heredocDelimiter("aabbccddeeff00112233aabb", []);
    expect(heredocDelimiter("aabbccddeeff00112233aabb", [`echo\n${a}`])).toBe(
      `${a}1`,
    );
  });

  it("recognises only a string holding the marker", () => {
    expect(hasOnstartMarker(null)).toBe(false);
    expect(hasOnstartMarker("None")).toBe(false);
    expect(hasOnstartMarker(undefined)).toBe(false);
    expect(hasOnstartMarker("env | sort")).toBe(false);
  });
});

describe("rent --onstart / --pip", () => {
  it("E73: a missing, unreadable or blank script exits 2 and runs nothing", async () => {
    for (const file of [join(dir, "no-such-file.sh"), dir, script(" \n\t\n")]) {
      const r = await rent(["--onstart", file]);
      expect(r.exitCode).toBe(2);
      expect(r.stdout).toContain("VALIDATION_ERROR");
      expect(r.stdout).toContain("--onstart");
      expect(r.calls).toHaveLength(0);
    }
  });

  it("E76: a bad --pip token exits 2, names it and runs nothing", async () => {
    const r = await rent(["--pip", "numpy;curl evil"]);
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain("numpy;curl");
    expect(r.calls).toHaveLength(0);
    const opt = await rent(["--pip", "numpy --index-url http://x"]);
    expect(opt.exitCode).toBe(2);
    expect(opt.stdout).toContain("--index-url");
    expect(opt.calls).toHaveLength(0);
  });

  it("E74: an over-long script is refused before renting, with size, limit and the copy+run suggestion", async () => {
    const big = script(
      Array.from(
        { length: 80 },
        (_, i) => `echo "step ${i}: ${"x".repeat(40)}"`,
      ).join("\n"),
    );
    const r = await rent(["--onstart", big]);
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toMatch(/onstart text is \d+ characters/);
    expect(r.stdout).toContain(String(ONSTART_LIMIT));
    expect(r.stdout).toContain("vast-axi copy");
    expect(r.stdout).toContain("vast-axi run");
    expect(r.calls).toHaveLength(0);
  });

  it("E74: a huge file is refused without being read into the text", async () => {
    const huge = script("echo x\n".repeat(20_000));
    const r = await rent(["--onstart", huge]);
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain("vast-axi copy");
    expect(r.calls).toHaveLength(0);
  });

  it("E75: a secret in the script exits 2 with pattern names and line numbers, never the secret", async () => {
    const secret = `hf_${"A1b2C3d4E5".repeat(4)}`;
    const file = script(`echo ok\nexport HF_TOKEN=${secret}\n`);
    const r = await rent(["--onstart", file]);
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain("Hugging Face token");
    expect(r.stdout).toContain("line 2");
    expect(r.stdout).toContain("instance record");
    expect(r.stdout).toContain("--allow-secrets");
    expect(r.stdout).not.toContain(secret);
    expect(r.calls).toHaveLength(0);
  });

  it("E75: a secret-shaped --pip text is refused the same way", async () => {
    const key = `sk-${"abcdefghij".repeat(3)}`;
    const r = await rent(["--pip", `numpy ${key}`]);
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain("OpenAI/Anthropic-style key");
    expect(r.stdout).not.toContain(key);
    expect(r.calls).toHaveLength(0);
  });

  it("E75: --allow-secrets rents anyway and reports the allowed pattern names", async () => {
    const secret = `hf_${"A1b2C3d4E5".repeat(4)}`;
    const file = script(`export HF_TOKEN=${secret}\n`);
    const r = await rent(["--onstart", file, "--allow-secrets"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("allowed_secrets: Hugging Face token");
    expect(r.stdout).not.toContain(secret);
    expect(r.created).toHaveLength(1);
  });

  it("rents with --pip and --onstart: --onstart-cmd carries the marker, output names the job", async () => {
    const file = script("echo one\necho two\n", "setup.sh");
    const r = await rent(["--pip", "numpy", "--onstart", file]);
    expect(r.exitCode).toBe(0);
    expect(r.created).toHaveLength(1);
    const argv = r.created[0]!.argv;
    const text = argv[argv.indexOf("--onstart-cmd") + 1]!;
    expect(text).toContain(ONSTART_MARKER);
    expect(text.length).toBeLessThanOrEqual(ONSTART_LIMIT);
    expect(r.stdout).toContain('onstart: "job onstart (pip, then setup.sh)"');
    expect(r.stdout).toContain("vast-axi status 7835610 --wait");
    expect(r.stdout).toContain("vast-axi job 7835610 --name onstart");
    expect(r.stdout).not.toContain("allowed_secrets");
    const launcher = launcherOf(text);
    expect(launcher).toContain("setup.sh");
  });

  it("describes pip-only and script-only jobs", async () => {
    const pip = await rent(["--pip", "numpy pandas"]);
    expect(pip.stdout).toContain("onstart: job onstart (pip)");
    const only = await rent(["--onstart", script("echo hi\n", "go.sh")]);
    expect(only.stdout).toContain("onstart: job onstart (go.sh)");
    for (const r of [pip, only]) {
      expect(r.created[0]!.argv).toContain("--onstart-cmd");
    }
  });

  it("without the flags no --onstart-cmd is sent", async () => {
    const r = await rent([]);
    expect(r.created[0]!.argv).not.toContain("--onstart-cmd");
    expect(r.stdout).not.toContain("onstart");
  });

  it("the guard still runs: a refused rent with --onstart creates nothing", async () => {
    const log = newCallLog();
    const { exitCode } = await runCli(
      ["rent", "5004", ...IMG, "--pip", "numpy"],
      { env: { FAKE_VASTAI_LOG: log, ...EMPTY } },
    );
    expect(exitCode).toBe(2);
    expect(
      readCallLog(log).filter((c) => c.tokens[0] === "create"),
    ).toHaveLength(0);
  });

  it("help lists the new flags", async () => {
    const { stdout } = await runCli(["rent", "--help"]);
    for (const f of ["--onstart", "--pip", "--allow-secrets"]) {
      expect(stdout).toContain(f);
    }
  });

  it("help states the measured capacity, not the old 1 KB", async () => {
    const { stdout } = await runCli(["rent", "--help"]);
    expect(stdout).toContain("1.7 KB");
    expect(stdout).toContain("1.5 KB with --pip");
    expect(stdout).not.toContain("about 1 KB at most");
  });
});

describe("E91: capacity is the final text length against the 4048 limit", () => {
  const TOKEN = "aabbccddeeff00112233aabb";
  /** A valid script of exactly n bytes: a comment, no trailing newline. */
  const sized = (n: number): string => `#${"a".repeat(n - 1)}`;
  const fits = (n: number, pip?: string[]): boolean =>
    buildOnstartText({
      script: sized(n),
      token: TOKEN,
      ...(pip ? { pip } : {}),
    }).length <= ONSTART_LIMIT;
  /** Largest script size that fits, found by search (the text grows monotonically). */
  function capacity(pip?: string[]): number {
    let n = 1;
    while (fits(n + 1, pip)) n++;
    return n;
  }

  it("measures over 1.7 KB for a script alone and over 1.5 KB with --pip numpy", () => {
    expect(capacity()).toBeGreaterThan(1700);
    expect(capacity(["numpy"])).toBeGreaterThan(1500);
    expect(capacity(["numpy"])).toBeLessThan(capacity());
  });

  it.each([
    ["script only", undefined, []],
    ["with --pip numpy", ["numpy"], ["--pip", "numpy"]],
  ] as const)(
    "%s: the largest script fits and rents, one more byte exits 2 before any create",
    async (_label, pip, flags) => {
      const max = capacity(pip as string[] | undefined);
      for (const size of [max - 1, max]) {
        const ok = await rent(["--onstart", script(sized(size)), ...flags]);
        expect(ok.exitCode).toBe(0);
        expect(ok.created).toHaveLength(1);
        const argv = ok.created[0]!.argv;
        const text = argv[argv.indexOf("--onstart-cmd") + 1]!;
        expect(text.length).toBeLessThanOrEqual(ONSTART_LIMIT);
      }
      const over = await rent(["--onstart", script(sized(max + 1)), ...flags]);
      expect(over.exitCode).toBe(2);
      expect(over.stdout).toMatch(/onstart text is \d+ characters/);
      expect(over.stdout).toContain(String(ONSTART_LIMIT));
      expect(over.calls).toHaveLength(0);
    },
  );
});
