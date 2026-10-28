import { AxiError } from "axi-sdk-js";

/**
 * What a command returns: a plain object (rendered as TOON, or JSON with
 * `--json`; an optional `help: string[]` key becomes the trailing `help[]`
 * block) or a ready-made string (plain text passthrough).
 */
export type VastOutput = string | Record<string, unknown>;

/** A command handler. `--json` is stripped before it is called; validate flags with assertKnownFlags. */
export type VastCommand = (args: string[]) => VastOutput | Promise<VastOutput>;

/**
 * The contract every file under src/commands/ fulfils:
 *   export const command: VastCommand
 *   export const help: string        // `<command> --help`; "" falls through to the handler
 * src/commands/index.ts imports each file as a namespace, so no registration edit is needed.
 */
export interface CommandModule {
  command: VastCommand;
  help: string;
}

/** Placeholder handler used by the stub modules until their unit lands. */
export function notImplemented(name: string): VastCommand {
  return () => {
    throw new AxiError(
      `\`${name}\` is not implemented yet`,
      "NOT_IMPLEMENTED",
      ["Run `vast-axi --help` to see the available commands"],
    );
  };
}
