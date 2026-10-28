import { assertKnownFlags, takePositional } from "../args.js";
import {
  assertNoExtra,
  fetchInstance,
  isStopped,
  parseInstanceId,
} from "../endpoint.js";
import { AxiError, mapVastError } from "../errors.js";
import { buildHelp } from "../help.js";
import { vastExec } from "../vastai.js";
import type { VastCommand } from "./types.js";

const USAGE = "vast-axi stop <id>";

export const help = buildHelp({
  usage: USAGE,
  summary:
    "Stop a running instance. Stopping a stopped instance is a no-op (exit 0).",
  notes: [
    "A stopped instance keeps its data and keeps billing for storage; destroy it to end all charges.",
  ],
  examples: ["vast-axi stop 42"],
});

export const command: VastCommand = async (args) => {
  assertKnownFlags(args, [], "stop");
  const id = parseInstanceId(takePositional(args, "id", `usage: ${USAGE}`));
  assertNoExtra(args, USAGE);

  const before = await fetchInstance(id);
  if (!before) {
    throw new AxiError(`Instance #${id} not found`, "NOT_FOUND", [
      "Run `vast-axi status` to list your instances",
    ]);
  }
  const billing = `Storage still bills while stopped; \`vast-axi destroy ${id}\` ends all charges (deletes data)`;
  if (isStopped(before)) {
    return {
      instance: `#${id} already stopped (no-op)`,
      help: [billing, `\`vast-axi status ${id}\` shows its state`],
    };
  }

  // Under --raw, stop prints plain text: "stopping instance 42." on success,
  // the upstream message (still exit 0) otherwise.
  const text = (await vastExec(["stop", "instance", String(id)])).trim();
  if (!/stopping instance/i.test(text)) {
    throw mapVastError({ status: null, msg: text || "stop was not accepted" });
  }

  // Best-effort confirmation: the stop is accepted even if this read fails.
  const after = await fetchInstance(id).catch(() => undefined);
  return {
    instance: `#${id} stopping`,
    state: after?.actual_status ?? "unknown",
    help: [billing, `\`vast-axi status ${id}\` shows when it has stopped`],
  };
};
