// `status --live`: read real GPU use over ssh (moved out of commands/status.ts).
import type { StatusDeps, StatusInstance } from "./commands/status.js";
import { resolveEndpoint } from "./endpoint.js";
import { AxiError } from "./errors.js";
import { truncate } from "./format.js";
import { nextSteps, type InstanceState } from "./instance-state.js";
import { NVIDIA_SMI_ARGS, parseNvidiaSmi } from "./live-gpu.js";
import { requireTool, runSsh, spawnTool } from "./transfer.js";

/** `--live`: ask the GPUs themselves. Never falls back to the delayed upstream value. */
export async function liveStatus(
  inst: StatusInstance,
  state: InstanceState,
  deps: StatusDeps,
): Promise<Record<string, unknown>> {
  const id = inst.id;
  if (state.class !== "running") {
    throw new AxiError(
      `--live needs a running instance; #${id} is ${state.class}`,
      "VALIDATION_ERROR",
      nextSteps(id, state),
    );
  }
  const endpoint = resolveEndpoint(inst);
  if (!endpoint) {
    throw new AxiError(
      `Instance #${id} has no ssh endpoint yet`,
      "NOT_RUNNING",
      [`Run \`vast-axi status ${id}\` again in a minute`],
    );
  }
  const { run } = await runSsh(
    deps.spawn ?? spawnTool,
    (deps.resolveTool ?? requireTool)("ssh"),
    id,
    endpoint,
    NVIDIA_SMI_ARGS,
  );
  if (run.exitCode !== 0) {
    throw new AxiError(
      `nvidia-smi failed on #${id} (exit ${run.exitCode}): ${truncate(run.stderr.trim(), 300) || "no output"}`,
      "SSH_FAILED",
      [
        "The image may have no NVIDIA driver tools; the delayed gpu_util is not a substitute",
        `Run \`vast-axi ssh ${id} --exec -- nvidia-smi\` to see the raw error`,
      ],
    );
  }
  const live = parseNvidiaSmi(id, run.stdout);
  return {
    id,
    class: state.class,
    gpu_util_source: "nvidia-smi over ssh (live)",
    gpus: live.gpus,
    gpu_util_live: live.gpu_util_live,
    power_w: live.power_w,
    mem_used_mib: live.mem_used_mib,
    idle_live: live.idle_live,
    help:
      live.idle_live === "yes"
        ? [
            `Every GPU is under 5% right now. If a job should be running, check it with \`vast-axi job ${id}\` (a job that never reaches the GPU shows gpu_warning); if nothing should run, \`vast-axi stop ${id}\``,
            "A job between steps can read 0 briefly; run --live again to be sure",
          ]
        : ["GPUs are busy; leave the instance running"],
  };
}
