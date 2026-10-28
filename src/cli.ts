import { runAxiCli, type AxiCliCommand } from "axi-sdk-js";
import { takeBoolFlag } from "./args.js";
import { REGISTRY, type Registry } from "./commands/index.js";
import type { CommandModule } from "./commands/types.js";
import { AxiError, exitCodeForError, redactSecrets } from "./errors.js";
import { DESCRIPTION, TOP_HELP } from "./help.js";
import { renderError, renderOutput } from "./toon.js";
import { VERSION } from "./version.js";

export interface MainOptions {
  argv?: string[];
  stdout?: { write: (chunk: string) => unknown };
  /** Override the command registry (tests); defaults to the real one. */
  registry?: Registry;
}

/**
 * Wrap a command module for the SDK: strip the global `--json` flag, run the
 * handler, and render its output (TOON by default, JSON with `--json`).
 */
function adapt(mod: CommandModule): AxiCliCommand<undefined> {
  return async (args) => {
    const rest = [...args];
    const json = takeBoolFlag(rest, "--json");
    return renderOutput(await mod.command(rest), { json });
  };
}

export async function main(options: MainOptions = {}): Promise<void> {
  const registry = options.registry ?? REGISTRY;
  const commands: Record<string, AxiCliCommand<undefined>> = Object.create(
    null,
  );
  for (const [name, mod] of Object.entries(registry.commands)) {
    commands[name] = adapt(mod);
  }

  await runAxiCli({
    ...(options.argv ? { argv: options.argv } : {}),
    ...(options.stdout ? { stdout: options.stdout } : {}),
    description: DESCRIPTION,
    version: VERSION,
    topLevelHelp: TOP_HELP,
    // A string return makes the SDK print its `bin`/`description` header, then this.
    home: async () => renderOutput(await registry.home.command([])),
    commands,
    getCommandHelp: (command) => registry.commands[command]?.help,
    renderUnknownCommand: (command) =>
      `${renderError(`Unknown command: ${command}`, "VALIDATION_ERROR", [
        "Run `vast-axi --help` to see available commands",
      ])}\n`,
    // Same shape as the SDK default, but with the multi-line help block and
    // secrets scrubbed from anything an upstream message might have quoted.
    formatError: (error) => {
      const axiError =
        error instanceof AxiError
          ? error
          : new AxiError(
              error instanceof Error ? error.message : String(error),
              "UNKNOWN",
            );
      return {
        output: `${renderError(redactSecrets(axiError.message), axiError.code, axiError.suggestions)}\n`,
        exitCode: exitCodeForError(axiError),
      };
    },
  });
}
