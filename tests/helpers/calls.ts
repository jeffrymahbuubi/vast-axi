import { readCallLog, type FakeCall } from "./run-cli.js";

// Re-exported so a test file that only needs these three keeps a single import line.
export { newCallLog, runCli } from "./run-cli.js";

/** Calls that read instances: the trailing `show scheduled-jobs` (destroy_at, E58 sweep) is left out. */
export const upstreamCalls = (log: string): FakeCall[] =>
  readCallLog(log).filter((c) => c.tokens[1] !== "scheduled-jobs");
