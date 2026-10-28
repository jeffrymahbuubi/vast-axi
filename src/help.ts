export const DESCRIPTION =
  "Agent ergonomic wrapper around the vast.ai CLI. Prefer this over `vastai` for finding, renting and tearing down GPU instances.";

export const TOP_HELP = `usage: vast-axi [command] [args] [flags]
commands[16]:
  (none)=dashboard, search, rent, status, ssh, logs, stop, destroy, copy, run, job, finish, raw, setup, update, update --check
flags[3]:
  --json (after command; same structure as JSON), --help, -v/-V/--version
examples:
  vast-axi
  vast-axi search --gpu RTX_4090 --limit 10
  vast-axi rent <offer-id> --image <image>
  vast-axi status <id> --wait
  vast-axi run <id> --cwd /workspace/x -- python train.py
  vast-axi finish <id> --wait --fetch out/model.pt:./model.pt --destroy
  vast-axi destroy <id>
  vast-axi update --check
`;

/** Section layout shared by every per-command help string. */
export interface HelpSpec {
  /** `usage:` line without the leading label, for example `vast-axi stop <id>`. */
  usage: string;
  summary?: string;
  /** One line per flag, for example `--limit <n>  rows to show (default 10)`. */
  flags?: string[];
  notes?: string[];
  examples: string[];
}

/**
 * Build a `<command> --help` string in the same TOON-ish layout as TOP_HELP.
 * Command modules export the result as their `help`.
 */
export function buildHelp(spec: HelpSpec): string {
  const lines = [`usage: ${spec.usage}`];
  if (spec.summary) lines.push(spec.summary);
  if (spec.flags?.length) {
    lines.push(
      `flags[${spec.flags.length}]:`,
      ...spec.flags.map((f) => `  ${f}`),
    );
  }
  if (spec.notes?.length)
    lines.push("note:", ...spec.notes.map((n) => `  ${n}`));
  lines.push("examples:", ...spec.examples.map((e) => `  ${e}`));
  return `${lines.join("\n")}\n`;
}
