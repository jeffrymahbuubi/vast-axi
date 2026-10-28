// `rent --onstart / --pip`: the onstart text vast.ai runs on every container
// start, and the helpers `status` uses to recognise and describe it (Phase 3,
// feature 7). The text starts a detached Phase 1 job named `onstart`, so
// `job --name onstart` and `status --wait` read it like any other job.
// Pure builders only; tests/onstart-bash.test.ts also runs the text under bash.
import { AxiError } from "./errors.js";
import {
  buildRunScript,
  jobStatus,
  shellQuote,
  type JobRecord,
} from "./job.js";

/** Literal that marks a vast-axi onstart in the instance's stored `onstart` field. */
export const ONSTART_MARKER = "__VAST_AXI_ONSTART__";
export const ONSTART_JOB = "onstart";
/** vast.ai rejects an onstart script longer than this (characters). */
export const ONSTART_LIMIT = 4048;
export const DEFAULT_HOME = "/root";

// Letters, digits and the version/extras punctuation of a pip requirement;
// never whitespace, quotes, `;`, `$`, backticks or a leading `-` (an option).
const PIP_SPEC_RE = /^[A-Za-z0-9._\-[\],<>=!~+]+$/;

function bad(message: string, hints: string[] = []): AxiError {
  return new AxiError(message, "VALIDATION_ERROR", hints);
}

/** Split `--pip` on whitespace and check every spec; the first bad token is named (E76). */
export function parsePipSpecs(raw: string): string[] {
  const specs = raw.split(/\s+/).filter((s) => s !== "");
  if (specs.length === 0) throw bad("--pip needs at least one package");
  for (const spec of specs) {
    if (spec.startsWith("-") || !PIP_SPEC_RE.test(spec)) {
      throw bad(
        `--pip: "${spec.length > 60 ? `${spec.slice(0, 60)}...` : spec}" is not a plain package spec`,
        [
          "Allowed: letters, digits and . _ - [ ] , < > = ! ~ + (for example numpy==1.26.4 or 'uvicorn[standard]>=0.30')",
          "pip options, quotes, ; $ ` and spaces inside a spec are refused; put anything else in --onstart <file>",
        ],
      );
    }
  }
  return specs;
}

/** The pip step: `python3 -m pip` first, plain `pip` as the fallback. */
export function pipCommand(specs: string[]): string {
  const q = specs.map(shellQuote).join(" ");
  return `python3 -m pip install --no-input ${q} || pip install --no-input ${q}`;
}

export interface OnstartSpec {
  /** Validated pip specs, or none. */
  pip?: string[];
  /** Text of the user's script, or none. */
  script?: string;
  /** Job token; each container start rewrites the record, so one token per rent is enough. */
  token: string;
  /** Home directory on the instance; tests point it at a temp dir. */
  home?: string;
}

/**
 * The command the `onstart` job runs: pip first, then the user script under
 * `bash <file>`, with `set -e` between the steps so either failing fails the job.
 */
export function onstartJobCommand(spec: Pick<OnstartSpec, "pip" | "script">) {
  const steps: string[] = [];
  if (spec.pip && spec.pip.length > 0) steps.push(pipCommand(spec.pip));
  if (spec.script !== undefined) {
    steps.push(`bash "$HOME/.vast-axi/jobs/${ONSTART_JOB}/setup.sh"`);
  }
  return steps.length > 1 ? `set -e; ${steps.join("; ")}` : (steps[0] ?? "");
}

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");

/**
 * The quoted-heredoc delimiter for one rent: `VAXI_` plus 12 letters/digits of
 * the per-rent token. A delimiter ends a heredoc only as a WHOLE line, so if
 * it equals a line of any payload (astronomically unlikely) a numbered one is
 * used instead; the result is verified against every payload.
 */
export function heredocDelimiter(token: string, payloads: string[]): string {
  const base = `VAXI_${token.replace(/[^A-Za-z0-9]/g, "").slice(0, 12)}`;
  const lines = new Set(payloads.flatMap((p) => p.split("\n")));
  for (let i = 0; ; i++) {
    const delim = i === 0 ? base : `${base}${i}`;
    if (!lines.has(delim)) return delim;
  }
}

/**
 * Shell lines that write `body` to `target` byte for byte through a quoted
 * heredoc (no expansion of any kind). A heredoc body always ends with a
 * newline, so a body without one is read whole with `read -rd ''` and printed
 * minus that one newline; a body that ends in a newline goes through `cat`.
 */
function writeFileLines(target: string, body: string, delim: string): string[] {
  if (body.endsWith("\n")) {
    return [`cat > ${target} <<'${delim}'`, body.slice(0, -1), delim];
  }
  return [
    `IFS= read -rd '' b <<'${delim}'`,
    body,
    delim,
    "printf %s \"${b%$'\\n'}\" > " + target,
  ];
}

/**
 * What runs on the instance at every start (before base64): write the
 * script and the Phase 1 `run.sh` wrapper into the job dir, drop the previous
 * boot's pid/exit/start and truncate its log, then start the wrapper detached.
 * Rewriting the record each boot is what makes `job` and `status` report the
 * latest start (E78). A slimmer launcher than `run`'s: no probe library, and
 * the two files travel in quoted heredocs instead of a second base64 layer,
 * so more of the 4048 characters are left for the user's script.
 */
export function buildOnstartLauncher(spec: OnstartSpec): string {
  const home = spec.home ?? DEFAULT_HOME;
  const dir = `${home}/.vast-axi/jobs/${ONSTART_JOB}`;
  const run = buildRunScript({
    name: ONSTART_JOB,
    token: spec.token,
    cwd: home,
    log: `${dir}/onstart.log`,
    command: onstartJobCommand(spec),
  });
  const delim = heredocDelimiter(
    spec.token,
    spec.script !== undefined ? [spec.script, run] : [run],
  );
  return [
    `export HOME=${shellQuote(home)}`,
    `d=${shellQuote(dir)}`,
    'mkdir -p "$d" || exit 0',
    'rm -f "$d/pid" "$d/exit" "$d/start"',
    ...(spec.script !== undefined
      ? writeFileLines('"$d/setup.sh"', spec.script, delim)
      : []),
    ...writeFileLines('"$d/run.sh"', run, delim),
    ': > "$d/onstart.log"',
    "S=; command -v setsid >/dev/null 2>&1 && S=setsid",
    `VAST_AXI_JOB=${spec.token} nohup $S bash "$d/run.sh" </dev/null >/dev/null 2>&1 &`,
    "",
  ].join("\n");
}

/**
 * The text for `create instance --onstart-cmd`: one line, a no-op carrying the
 * marker, then the base64-transported launcher (same transport as `run`).
 */
export function buildOnstartText(spec: OnstartSpec): string {
  return `: ${ONSTART_MARKER} v1; echo ${b64(buildOnstartLauncher(spec))} | base64 -d | bash`;
}

/** True when the instance row's stored `onstart` was written by vast-axi. */
export function hasOnstartMarker(onstart: unknown): boolean {
  return typeof onstart === "string" && onstart.includes(ONSTART_MARKER);
}

export interface OnstartView {
  state: "running" | "finished" | "failed";
  /** The `onstart:` value, for example `finished (exit 0, 3 min)`. */
  line: string;
}

/** Turn the `onstart` job's probe record into the one-line status (a lost job counts as failed). */
export function describeOnstart(rec: JobRecord): OnstartView {
  const s = jobStatus(rec);
  if (s.state === "running") return { state: "running", line: "running" };
  if (s.state === "lost") {
    return { state: "failed", line: "failed (lost: no exit recorded)" };
  }
  const secs = (Date.parse(s.ended ?? "") - Date.parse(rec.start ?? "")) / 1000;
  const took = Number.isFinite(secs)
    ? `, ${secs < 60 ? "<1" : Math.round(secs / 60)} min`
    : "";
  return s.state === "finished"
    ? { state: "finished", line: `finished (exit 0${took})` }
    : { state: "failed", line: `failed (exit ${s.exitCode})` };
}
