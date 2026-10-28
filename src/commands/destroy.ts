import { assertKnownFlags, takeBoolFlag, takePositional } from "../args.js";
import { cleanupDestroyTimers } from "../destroy-timer.js";
import { assertNoExtra, fetchInstance, parseInstanceId } from "../endpoint.js";
import { AxiError, errorFromBody, mapVastError } from "../errors.js";
import { buildHelp } from "../help.js";
import { vastExec, vastJson } from "../vastai.js";
import type { VastCommand } from "./types.js";

const USAGE = "vast-axi destroy <id> | vast-axi destroy --all --yes";

export const help = buildHelp({
  usage: USAGE,
  summary:
    "Destroy an instance (irreversible, deletes its data). Destroying a missing instance is a no-op (exit 0).",
  flags: [
    "--all   destroy every instance on the account",
    "--yes   required with --all; destroy <id> runs immediately without it",
  ],
  notes: [
    "Never prompts: vastai is always run with -y and a closed stdin.",
    "Also removes the server-side destroy timer that `rent --max-hours` set (destroy_timer: removed job <id>); a failed removal is a warning, not an error.",
    "To keep the data, `vast-axi stop <id>` instead (storage still bills).",
  ],
  examples: ["vast-axi destroy 42", "vast-axi destroy --all --yes"],
});

/**
 * Upstream prints `destroying instance N.`, or under --raw a JSON body, and
 * reports failures as a message with exit 0. Anything that is not clearly an
 * acceptance is an error, so a refused destroy is never reported as done.
 */
export function assertAccepted(output: string): void {
  const text = output.trim();
  if (text === "") return;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    if (/destroying instance/i.test(text)) return;
    throw mapVastError({ status: null, msg: text });
  }
  const failure = errorFromBody(body);
  if (failure) throw mapVastError(failure);
}

/** Destroy one instance (`-y`, never prompts) and fail unless upstream clearly accepted it; `finish --destroy` reuses this. */
export async function destroyInstance(id: number): Promise<void> {
  assertAccepted(await vastExec(["destroy", "instance", String(id), "-y"]));
}

async function destroyAll(): Promise<Record<string, unknown>> {
  const rows = await vastJson<Array<{ id: number }>>(["show", "instances"]);
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) {
    return { destroyed: "0 instances (no-op)" };
  }
  // -y: never let upstream prompt; the runner also closes stdin.
  assertAccepted(
    await vastExec(["destroy", "instances", ...ids.map(String), "-y"]),
  );
  const left = await vastJson<Array<{ id: number }>>(["show", "instances"])
    .then((r) => r.filter((row) => ids.includes(row.id)).length)
    .catch(() => undefined);
  const timers = await cleanupDestroyTimers(ids);
  return {
    destroyed: `${ids.length} instance${ids.length > 1 ? "s" : ""}`,
    ids: ids.map((id) => `#${id}`).join(" "),
    ...(left ? { still_listed: left } : {}),
    ...timers.fields,
    help: ["`vast-axi` shows the account state", ...timers.help],
  };
}

export const command: VastCommand = async (args) => {
  assertKnownFlags(args, ["--all", "--yes"], "destroy");
  const all = takeBoolFlag(args, "--all");
  const yes = takeBoolFlag(args, "--yes");

  if (all) {
    assertNoExtra(args, USAGE);
    if (!yes) {
      throw new AxiError(
        "`destroy --all` deletes every instance and its data; add --yes to confirm",
        "VALIDATION_ERROR",
        [
          "Run `vast-axi destroy --all --yes`, or `vast-axi status` to review first",
        ],
      );
    }
    return destroyAll();
  }

  const id = parseInstanceId(takePositional(args, "id", `usage: ${USAGE}`));
  assertNoExtra(args, USAGE);
  const existing = await fetchInstance(id);
  if (!existing) {
    // A destroy timer may outlive its instance (E58): remove it here too.
    const timers = await cleanupDestroyTimers([id]);
    return {
      instance: `#${id} not found, already destroyed (no-op)`,
      ...timers.fields,
      help: ["`vast-axi status` lists your instances", ...timers.help],
    };
  }

  await destroyInstance(id);

  // Best-effort confirmation: the destroy is accepted even if this read fails.
  const after = await fetchInstance(id).catch(() => existing);
  const timers = await cleanupDestroyTimers([id]);
  return {
    instance: after ? `#${id} destroying` : `#${id} destroyed`,
    ...(after ? { state: after.actual_status ?? "unknown" } : {}),
    ...timers.fields,
    help: [
      "`vast-axi` shows the remaining instances and burn rate",
      ...timers.help,
    ],
  };
};
