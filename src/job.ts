// Pure builders and parsers behind `run`, `job` and `finish` (Phase 1 plan):
// the remote job script, the launcher, the state probe and its output parser,
// fetch-spec parsing, remote-path resolution, durations and tail cleanup.
// Nothing here starts a process, so every function is unit-testable; the
// scripts are also run under a real local bash in tests/job-bash.test.ts.
import { randomBytes } from "node:crypto";
import { posix } from "node:path";
import { AxiError, redactSecrets } from "./errors.js";
import { formatDuration, truncate } from "./format.js";
import { assertSafeDestination } from "./transfer.js";

export const MARKER = "__VAST_AXI_EXIT__";
export const DEFAULT_NAME = "main";
export const DEFAULT_CWD = "/workspace";
export const TAIL_LINE_CAP = 400;
/** Windows caps a whole command line at about 32 KB; stay well under it. */
export const MAX_REMOTE_LINE = 24_000;
/** Prefix of every line the remote scripts print, so ssh banners are ignored. */
export const PREFIX = "@vaxi";
const P = PREFIX;

const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

function bad(message: string, hints: string[] = []): AxiError {
  return new AxiError(message, "VALIDATION_ERROR", hints);
}

/** `--name`: letters, digits, `_`, `.`, `-` (1-64); all-dots would escape the jobs dir. */
export function parseJobName(raw: string): string {
  if (!NAME_RE.test(raw) || /^\.+$/.test(raw)) {
    throw bad(`--name must match [A-Za-z0-9_.-]{1,64}, got "${raw}"`);
  }
  return raw;
}

/** `30s`, `15m`, `2h` to milliseconds; anything else, zero, or below `minMs` is a VALIDATION_ERROR. */
export function parseDuration(raw: string, flag: string, minMs = 1000): number {
  const m = /^(\d+)([smh])$/.exec(raw);
  const ms = m
    ? Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[m[2] as "s"]
    : 0;
  if (ms < minMs) {
    const floor =
      minMs > 1000 ? ` (minimum ${formatDuration(minMs / 1000)})` : "";
    throw bad(`${flag} must look like 30s, 15m or 2h, got "${raw}"${floor}`);
  }
  return ms;
}

/** Random per-run token; the exit marker only counts when it carries it (OQ17). */
export function newToken(): string {
  return randomBytes(12).toString("hex");
}

/** POSIX single-quote; the only quoting the remote scripts rely on. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function assertPlain(value: string, what: string): void {
  if (/[\0\r\n]/.test(value)) throw bad(`${what} must be a single line`);
  // Git Bash rewrites `/workspace/x` into `C:/Program Files/Git/workspace/x`
  // before we see it; a drive letter is never a valid instance path.
  if (/^[A-Za-z]:[\\/]/.test(value)) {
    throw bad(`${what} "${value}" is a Windows path, not an instance path`, [
      "In Git Bash, run with MSYS_NO_PATHCONV=1 so /workspace/... is not rewritten to a Windows path",
    ]);
  }
}

/** Resolve a remote path against the job's cwd. `~` is never expanded remotely, so it is refused. */
export function resolveRemotePath(path: string, cwd: string, what = "path") {
  assertPlain(path, what);
  if (path.trim() === "") throw bad(`${what} is empty`);
  if (path.startsWith("~")) {
    throw bad(`${what} "${path}": ~ is not expanded; use an absolute path`);
  }
  const abs = path.startsWith("/") ? path : posix.join(cwd, path);
  const flat = posix.normalize(abs);
  return flat.length > 1 ? flat.replace(/\/+$/, "") : flat;
}

/** `--cwd`: absolute, and never `/`, `/root`, `~` or empty (E33, same rule as copy). */
export function parseCwd(raw: string): string {
  assertPlain(raw, "--cwd");
  try {
    assertSafeDestination(raw);
  } catch {
    throw bad(
      `refusing --cwd "${raw || "(empty)"}": jobs must not run in / or /root`,
      [
        `Pick a project directory, for example \`--cwd ${DEFAULT_CWD}/myproject\``,
      ],
    );
  }
  if (!raw.startsWith("/")) {
    throw bad(`--cwd must be an absolute path, got "${raw}"`);
  }
  return resolveRemotePath(raw, "/", "--cwd");
}

/** Split `<remote>:<local>` at the FIRST colon so a Windows drive stays in the local part (E50). */
export function parseFetchSpec(spec: string): {
  remote: string;
  local: string;
} {
  const i = spec.indexOf(":");
  if (i <= 0 || i === spec.length - 1) {
    throw bad(`--fetch needs <remote>:<local>, got "${spec}"`, [
      "Example: --fetch out/model.pt:./model.pt or --fetch out/m.pt:C:\\res\\m.pt",
    ]);
  }
  return { remote: spec.slice(0, i), local: spec.slice(i + 1) };
}

// ---------------------------------------------------------------- remote scripts

/**
 * Shell library shared by the launcher and the probe. `vaxi_alive` guards pid
 * reuse (E42): the pid must exist AND, where /proc exposes it, carry this
 * run's token in its environment. Without /proc (Git Bash) it is kill -0 only.
 */
const LIB = String.raw`
vaxi_alive() {
  pid=$(cat "$1/pid" 2>/dev/null); tok=$(cat "$1/token" 2>/dev/null)
  case "$pid" in ''|*[!0-9]*|0) return 1;; esac
  kill -0 "$pid" 2>/dev/null || return 1
  if [ -r "/proc/$pid/environ" ]; then
    tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | grep -qxF "VAST_AXI_JOB=$tok" || return 1
  fi
  return 0
}
vaxi_probe_job() {
  d=$1; n=$2; tok=$(cat "$d/token" 2>/dev/null); log=$(cat "$d/log" 2>/dev/null)
  echo "${P} job $(basename "$d")"
  echo "${P} pid $(cat "$d/pid" 2>/dev/null)"
  if vaxi_alive "$d"; then echo "${P} alive yes"; else echo "${P} alive no"; fi
  echo "${P} start $(cat "$d/start" 2>/dev/null)"
  echo "${P} cwd $(cat "$d/cwd" 2>/dev/null)"
  echo "${P} log $log"
  echo "${P} cmd $(base64 < "$d/cmd" 2>/dev/null | tr -d '\n\r')"
  if [ -n "$log" ] && [ -f "$log" ]; then
    echo "${P} size $(wc -c < "$log" | tr -d ' ')"
    m=$(tail -c 1048576 "$log" | grep -a "^${MARKER} $tok code=[0-9][0-9]* end=" | tail -n 1 | tr -d '\r')
    [ -n "$m" ] && echo "${P} marker $m"
    [ "$n" -gt 0 ] && echo "${P} tail $(tail -c 65536 "$log" | tail -n "$n" | base64 | tr -d '\n\r')"
  else
    echo "${P} nolog"
  fi
  [ -f "$d/exit" ] && echo "${P} exitfile $(cat "$d/exit")"
  echo "${P} now $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  return 0
}
`;

const jobDir = (name: string): string => `"$HOME/.vast-axi/jobs/${name}"`;
const ISO_NOW = "$(date -u +%Y-%m-%dT%H:%M:%SZ)";

export interface JobSpec {
  name: string;
  token: string;
  cwd: string;
  log: string;
  command: string;
}

/**
 * The job wrapper (`run.sh`). It records its own metadata, runs the user
 * command with `bash -c` (so pipes, quotes and unicode arrive untouched), then
 * appends the token-carrying exit marker to the log and writes the `exit` file.
 */
export function buildRunScript(spec: JobSpec): string {
  const { name, token } = spec;
  const cwd = shellQuote(spec.cwd);
  const log = shellQuote(spec.log);
  const cmd = shellQuote(spec.command);
  return [
    "#!/bin/bash",
    `JOBDIR=${jobDir(name)}`,
    'mkdir -p "$JOBDIR"',
    'rm -f "$JOBDIR/exit"',
    'echo $$ > "$JOBDIR/pid"',
    `printf '%s\\n' ${token} > "$JOBDIR/token"`,
    `printf '%s\\n' ${cwd} > "$JOBDIR/cwd"`,
    `printf '%s\\n' ${log} > "$JOBDIR/log"`,
    `printf '%s\\n' ${cmd} > "$JOBDIR/cmd"`,
    `echo ${ISO_NOW} > "$JOBDIR/start"`,
    `export VAST_AXI_JOB=${token}`,
    `if cd ${cwd}; then`,
    `  bash -c ${cmd} >> ${log} 2>&1 < /dev/null`,
    "  code=$?",
    "else",
    "  code=97",
    "fi",
    `end=${ISO_NOW}`,
    `printf '\\n${MARKER} %s code=%s end=%s\\n' ${token} "$code" "$end" >> ${log}`,
    'echo "$code $end" > "$JOBDIR/exit"',
    "",
  ].join("\n");
}

/** Wrap a script into the one remote command line: tool check, then `echo <base64> | base64 -d | bash`. */
export function buildRemoteCommand(script: string): string {
  const b64 = Buffer.from(script, "utf8").toString("base64");
  const line =
    `command -v base64 >/dev/null 2>&1 && command -v bash >/dev/null 2>&1 || { echo '${P} missing base64-or-bash'; exit 0; }; ` +
    `echo ${b64} | base64 -d | bash`;
  if (line.length > MAX_REMOTE_LINE) {
    throw bad(
      `the command is too long to send (${line.length} > ${MAX_REMOTE_LINE} characters encoded)`,
      ["Put the command in a script file on the instance and run that file"],
    );
  }
  return line;
}

/**
 * The launcher: checks tools, cwd, a running job and the log, writes run.sh
 * and starts it with `nohup setsid`, stdin from /dev/null (E39). The token is
 * also in the launched process's environment so /proc/<pid>/environ shows it.
 * It then waits for the wrapper to record itself, sleeps ~1s and prints the
 * probe record, so an instant failure shows up in the same ssh call (E38).
 */
export function buildLaunchScript(
  spec: JobSpec & { overwrite: boolean },
  tailLines: number,
): string {
  const { name, token } = spec;
  const runB64 = Buffer.from(buildRunScript(spec), "utf8").toString("base64");
  return [
    'for t in setsid nohup base64 bash; do command -v $t >/dev/null 2>&1 || { echo "' +
      P +
      ' missing $t"; exit 0; }; done',
    LIB,
    `d=${jobDir(name)}`,
    `CWD=${shellQuote(spec.cwd)}`,
    `LOG=${shellQuote(spec.log)}`,
    `[ -d "$CWD" ] || { echo '${P} nocwd'; exit 0; }`,
    `if [ -d "$d" ] && vaxi_alive "$d"; then echo '${P} running'; exit 0; fi`,
    ...(spec.overwrite
      ? []
      : [`[ -e "$LOG" ] && { echo '${P} logexists'; exit 0; }`]),
    'mkdir -p "$(dirname "$LOG")" 2>/dev/null',
    `: > "$LOG" 2>/dev/null || { echo '${P} logunwritable'; exit 0; }`,
    'mkdir -p "$d"',
    'rm -f "$d/pid" "$d/exit" "$d/start" "$d/token"',
    `printf %s ${runB64} | base64 -d > "$d/run.sh"`,
    `VAST_AXI_JOB=${token} nohup setsid bash "$d/run.sh" </dev/null >/dev/null 2>&1 &`,
    'i=0; while [ ! -f "$d/start" ] && [ $i -lt 20 ]; do sleep 0.2; i=$((i+1)); done',
    "sleep 1",
    `vaxi_probe_job "$d" ${tailLines + 3}`,
    "exit 0",
    "",
  ].join("\n");
}

export type Selector =
  | { kind: "name"; name: string }
  | { kind: "log"; log: string }
  | { kind: "all" };

/** The state probe: prints one record per selected job (`all` skips the tail). */
export function buildProbeScript(sel: Selector, tailLines: number): string {
  const n = tailLines + 3;
  const loop = (test: string, tail: number, none: string) =>
    [
      "found=0",
      'for d in "$HOME"/.vast-axi/jobs/*/; do',
      '  [ -f "$d/log" ] || continue',
      ...(test ? [`  l=$(cat "$d/log"); c=$(cat "$d/cwd" 2>/dev/null)`] : []),
      `  ${test || "true"} && { vaxi_probe_job "$d" ${tail}; found=1; }`,
      "done",
      `[ $found = 1 ] || echo '${P} ${none}'`,
    ].join("\n");
  let body: string;
  if (sel.kind === "name") {
    body = `d=${jobDir(sel.name)}\nif [ -d "$d" ]; then vaxi_probe_job "$d" ${n}; else echo '${P} notfound'; fi`;
  } else if (sel.kind === "log") {
    body =
      `SEL=${shellQuote(sel.log)}\n` +
      loop('{ [ "$l" = "$SEL" ] || [ "$l" = "$c/$SEL" ]; }', n, "notfound");
  } else {
    body = loop("", 0, "nojobs");
  }
  return `${LIB}\n${body}\nexit 0\n`;
}

// ---------------------------------------------------------------- parsing

export interface JobRecord {
  name: string;
  pid?: number;
  alive: boolean;
  start?: string;
  cwd?: string;
  log?: string;
  cmd?: string;
  size?: number;
  hasLog: boolean;
  /** The token-carrying marker line, verbatim. */
  markerLine?: string;
  marker?: { code: number; end: string };
  exitFile?: { code: number; end: string };
  tailText?: string;
  now?: string;
}

export type ProbeResult =
  | { kind: "jobs"; jobs: JobRecord[] }
  | { kind: "empty" }
  | { kind: "missing"; tool: string }
  | { kind: "notfound" | "nojobs" | "nocwd" | "running" }
  | { kind: "logexists" | "logunwritable" };

const MARKER_RE = new RegExp(`^${MARKER} \\S+ code=(\\d+) end=(\\S+)$`);

function fromB64(b64: string): string {
  return Buffer.from(b64, "base64").toString("utf8");
}

/** Parse the `@vaxi` lines a probe or launcher printed; every other line (a shell banner) is ignored. */
export function parseProbeOutput(stdout: string): ProbeResult {
  const jobs: JobRecord[] = [];
  let cur: JobRecord | undefined;
  for (const raw of stdout.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.startsWith(`${P} `)) continue;
    const rest = line.slice(P.length + 1);
    const sp = rest.indexOf(" ");
    const key = sp < 0 ? rest : rest.slice(0, sp);
    const val = sp < 0 ? "" : rest.slice(sp + 1);
    if (key === "job") {
      cur = { name: val, alive: false, hasLog: true };
      jobs.push(cur);
    } else if (!cur) {
      if (key === "missing") return { kind: "missing", tool: val };
      if (
        [
          "notfound",
          "nojobs",
          "nocwd",
          "running",
          "logexists",
          "logunwritable",
        ].includes(key)
      ) {
        return { kind: key } as ProbeResult;
      }
    } else if (key === "pid") {
      if (/^\d+$/.test(val)) cur.pid = Number(val);
    } else if (key === "alive") cur.alive = val === "yes";
    else if (key === "start") cur.start = val || undefined;
    else if (key === "cwd") cur.cwd = val || undefined;
    else if (key === "log") cur.log = val || undefined;
    else if (key === "cmd") cur.cmd = fromB64(val).replace(/\n$/, "");
    else if (key === "size") cur.size = Number(val);
    else if (key === "nolog") cur.hasLog = false;
    else if (key === "tail") cur.tailText = fromB64(val);
    else if (key === "now") cur.now = val;
    else if (key === "marker") {
      const m = MARKER_RE.exec(val);
      if (m) {
        cur.markerLine = val;
        cur.marker = { code: Number(m[1]), end: m[2]! };
      }
    } else if (key === "exitfile") {
      const m = /^(\d+) (\S+)$/.exec(val);
      if (m) cur.exitFile = { code: Number(m[1]), end: m[2]! };
    }
  }
  return jobs.length > 0 ? { kind: "jobs", jobs } : { kind: "empty" };
}

export type JobState = "running" | "finished" | "failed" | "lost";

export interface JobStatus {
  state: JobState;
  exitCode?: number;
  ended?: string;
  elapsed?: string;
}

function seconds(from?: string, to?: string): number | undefined {
  const a = Date.parse(from ?? "");
  const b = Date.parse(to ?? "");
  return Number.isNaN(a) || Number.isNaN(b) ? undefined : (b - a) / 1000;
}

/**
 * Finished means this run's marker is in the log (or, if the log has no
 * marker, the wrapper's `exit` file exists). Otherwise alive means running and
 * not alive means lost (E41); the ssh echo is never consulted.
 */
export function jobStatus(rec: JobRecord): JobStatus {
  const done = rec.marker ?? rec.exitFile;
  if (done) {
    const secs = seconds(rec.start, done.end);
    return {
      state: done.code === 0 ? "finished" : "failed",
      exitCode: done.code,
      ended: done.end,
      ...(secs !== undefined ? { elapsed: formatDuration(secs) } : {}),
    };
  }
  const secs = seconds(rec.start, rec.now);
  const elapsed = secs !== undefined ? { elapsed: formatDuration(secs) } : {};
  return { state: rec.alive ? "running" : "lost", ...elapsed };
}

/**
 * Clean the raw tail for display: drop this run's marker line, collapse tqdm
 * `\r` progress to the last segment (E43), redact secrets (E51), cut each
 * line to 400 characters and keep the last `n` lines.
 */
export function cleanTail(rec: JobRecord, n: number): string[] {
  if (n <= 0 || !rec.tailText) return [];
  const lines = rec.tailText
    .split("\n")
    .filter((l) => l.replace(/\r$/, "") !== rec.markerLine)
    .map((l) => {
      const segments = l.split("\r").filter((s) => s !== "");
      return segments[segments.length - 1] ?? "";
    });
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "")
    lines.pop();
  return lines.slice(-n).map((l) => truncate(redactSecrets(l), TAIL_LINE_CAP));
}
