import { encode } from "@toon-format/toon";
import type { VastOutput } from "./commands/types.js";

/**
 * Render help suggestions. Written by hand because encode() inlines
 * primitive arrays on one line, which hides commas inside commands.
 */
export function renderHelp(lines: string[]): string {
  if (lines.length === 0) return "";
  return `help[${lines.length}]:\n${lines.map((l) => `  ${l}`).join("\n")}`;
}

/** Join non-empty TOON blocks with newlines. */
export function renderBlocks(
  blocks: Array<string | false | null | undefined>,
): string {
  return blocks.filter(Boolean).join("\n");
}

/**
 * Render a command's output. Objects become TOON (or compact JSON with
 * `json`), with the reserved `help` key emitted as the trailing `help[]`
 * block; strings pass through as text (`{"output": ...}` under `json`).
 */
export function renderOutput(
  output: VastOutput,
  opts: { json?: boolean } = {},
): string {
  if (typeof output === "string") {
    return opts.json ? JSON.stringify({ output }) : output;
  }
  if (opts.json) return JSON.stringify(output);
  const { help, ...data } = output;
  const lines =
    typeof help === "string"
      ? [help]
      : Array.isArray(help)
        ? help.filter((h): h is string => typeof h === "string")
        : [];
  return renderBlocks([
    Object.keys(data).length > 0 && encode(data),
    renderHelp(lines),
  ]);
}

/** Render a structured error: `error`, `code`, then the help block. */
export function renderError(
  message: string,
  code: string,
  suggestions: string[] = [],
): string {
  return renderBlocks([
    encode({ error: message, code }),
    renderHelp(suggestions),
  ]);
}

/**
 * Definitive empty state (AXI principle 5): `{ offers: "0 matching offers" }`
 * plus optional help, returned as a normal command output.
 */
export function emptyState(
  label: string,
  message: string,
  help: string[] = [],
): Record<string, unknown> {
  return { [label]: message, ...(help.length > 0 ? { help } : {}) };
}
