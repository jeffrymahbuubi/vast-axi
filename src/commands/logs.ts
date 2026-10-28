import {
  assertKnownFlags,
  takeBoolFlag,
  takeFlag,
  takeNumberFlag,
  takePositional,
} from "../args.js";
import { assertNoExtra, parseInstanceId } from "../endpoint.js";
import { redactSecrets } from "../errors.js";
import { byteSize, truncate } from "../format.js";
import { buildHelp } from "../help.js";
import { renderHelp } from "../toon.js";
import { vastExec } from "../vastai.js";
import type { VastCommand } from "./types.js";

const USAGE = "vast-axi logs <id> [--tail <n>] [--filter <text>] [--full]";
const DEFAULT_TAIL = 200;
const LINE_CAP = 400;
/** Upstream returns the whole fetched log; a progress-bar log can exceed the 10 MB default. */
const LOG_MAX_BUFFER = 64 * 1024 * 1024;

export const help = buildHelp({
  usage: USAGE,
  summary: `Last ${DEFAULT_TAIL} log lines of an instance, each cut to ${LINE_CAP} characters.`,
  flags: [
    `--tail <n>      lines to show (default ${DEFAULT_TAIL})`,
    "--filter <text>  only lines matching this grep filter (passed to vastai)",
    "--full          do not cut long lines",
  ],
  notes: [
    "This is the instance's container log. For a program started with `vast-axi run`, use `vast-axi job <id>` for its state and output.",
  ],
  examples: [
    "vast-axi logs 42",
    "vast-axi logs 42 --tail 50 --filter error",
    "vast-axi logs 42 --full",
  ],
});

/** Raw container log text from upstream (`vastai logs`); the caller cleans it. */
export function fetchLogText(
  id: number,
  tail: number,
  filter?: string,
): Promise<string> {
  return vastExec(
    [
      "logs",
      String(id),
      "--tail",
      String(tail),
      ...(filter ? ["--filter", filter] : []),
    ],
    { maxBuffer: LOG_MAX_BUFFER },
  );
}

export const command: VastCommand = async (args) => {
  assertKnownFlags(args, ["--tail", "--filter", "--full"], "logs");
  const tail =
    takeNumberFlag(args, "--tail", { min: 1, integer: true }) ?? DEFAULT_TAIL;
  const filter = takeFlag(args, "--filter");
  const full = takeBoolFlag(args, "--full");
  const id = parseInstanceId(takePositional(args, "id", `usage: ${USAGE}`));
  assertNoExtra(args, USAGE);

  const text = await fetchLogText(id, tail, filter);

  // Keep only the last `tail` lines even if upstream sent more, then cap each line.
  const all = text.split(/\r?\n/);
  while (all.length > 0 && all[all.length - 1]!.trim() === "") all.pop();
  if (all.length === 0) {
    return {
      logs: `#${id} has no log lines${filter ? ` matching "${filter}"` : ""}`,
      help: [`Run \`vast-axi status ${id}\` to check the instance has started`],
    };
  }
  const shown = all.slice(-tail);
  let cut = 0;
  const lines = shown.map((line) => {
    if (full || line.length <= LINE_CAP) return line;
    cut++;
    return truncate(line, LINE_CAP);
  });

  const hints: string[] = [];
  if (all.length > shown.length) {
    hints.push(
      `Showing the last ${shown.length} of ${all.length} lines (${byteSize(Buffer.byteLength(text))} fetched); use --tail <n> for more or --filter <text> to narrow`,
    );
  }
  if (cut > 0) {
    hints.push(
      `${cut} line${cut > 1 ? "s" : ""} cut to ${LINE_CAP} characters; run \`vast-axi logs ${id} --full\` for whole lines`,
    );
  }
  const body = redactSecrets(lines.join("\n"));
  return hints.length > 0 ? `${body}\n${renderHelp(hints)}` : body;
};
