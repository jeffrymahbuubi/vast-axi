// Programmatic surface: the CLI entry plus the shared helpers commands build on.
export { main, type MainOptions } from "./cli.js";
export { VERSION } from "./version.js";
export { AxiError, exitCodeForError, mapVastError } from "./errors.js";
export { vastExec, vastJson, vastRaw, type VastRunner } from "./vastai.js";
export { loadConfig, type Config } from "./config.js";
export type {
  CommandModule,
  VastCommand,
  VastOutput,
} from "./commands/types.js";
