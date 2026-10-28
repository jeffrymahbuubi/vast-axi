// Next-step hints by job name: the onstart setup job must never be told to
// `finish --destroy` (E96); every other job keeps its hints (E97).
import { describe, expect, it } from "vitest";
import { REGISTRY, type Registry } from "../src/commands/index.js";
import * as job from "../src/commands/job.js";
import * as run from "../src/commands/run.js";
import { parseProbeOutput, type JobRecord } from "../src/job.js";
import { ok, record, recordingSpawner } from "./helpers/job-records.js";
import { runCli } from "./helpers/run-cli.js";

const END = "2026-10-20T10:42:00Z";

function rec(name: string, reply: string): JobRecord {
  const r = parseProbeOutput(reply);
  if (r.kind !== "jobs") throw new Error(`expected jobs, got ${r.kind}`);
  return r.jobs[0]!;
}

const states = {
  running: (name: string) => record({ name, alive: true }),
  finished: (name: string) => record({ name, marker: { code: 0, end: END } }),
  failed: (name: string) => record({ name, marker: { code: 2, end: END } }),
  lost: (name: string) => record({ name, alive: false }),
};

describe("E96: onstart job hints never suggest --destroy", () => {
  it.each(Object.keys(states) as Array<keyof typeof states>)(
    "stateHelp for onstart %s",
    (state) => {
      const text = job.stateHelp(42, rec("onstart", states[state]("onstart")));
      expect(text.join("\n")).not.toMatch(/--destroy|finish/);
      expect(text.length).toBeGreaterThan(0);
    },
  );

  it("running points at job --name onstart and status --wait", () => {
    const text = job
      .stateHelp(42, rec("onstart", states.running("onstart")))
      .join("\n");
    expect(text).toContain("Check again with `vast-axi job 42 --name onstart`");
    expect(text).toContain(
      "Or wait for setup with `vast-axi status 42 --wait`",
    );
  });

  it("finished says setup is done and offers run", () => {
    const text = job
      .stateHelp(42, rec("onstart", states.finished("onstart")))
      .join("\n");
    expect(text).toContain(
      "Setup is done; start your main job with `vast-axi run 42 -- <cmd>`",
    );
  });

  it("failed and lost point at the log tail and keep the instance", () => {
    for (const state of ["failed", "lost"] as const) {
      const text = job
        .stateHelp(42, rec("onstart", states[state]("onstart")))
        .join("\n");
      expect(text).toContain("vast-axi job 42 --name onstart --tail 100");
      expect(text).toContain("the instance is kept");
    }
  });

  const registryFor = (reply: string): Registry => {
    const { spawn } = recordingSpawner(() => ok(reply));
    return {
      home: REGISTRY.home,
      commands: {
        ...REGISTRY.commands,
        job: {
          command: job.createJobCommand({ spawn, resolveTool: () => "ssh" }),
          help: job.help,
        },
        run: {
          command: run.createRunCommand({ spawn, resolveTool: () => "ssh" }),
          help: run.help,
        },
      },
    };
  };

  it("`job --name onstart` output has no --destroy", async () => {
    for (const state of Object.keys(states) as Array<keyof typeof states>) {
      const out = await runCli(["job", "42", "--name", "onstart"], {
        registry: registryFor(states[state]("onstart")),
      });
      expect(out.stdout).toContain("onstart (#42)");
      expect(out.stdout).not.toContain("--destroy");
      expect(out.stdout).not.toContain("vast-axi finish");
    }
  });

  it("`run --name onstart` output has no --destroy", async () => {
    const out = await runCli(
      ["run", "42", "--name", "onstart", "--", "echo", "hi"],
      { registry: registryFor(states.running("onstart")) },
    );
    expect(out.stdout).toContain("state: running");
    expect(out.stdout).toContain("vast-axi status 42 --wait");
    expect(out.stdout).not.toContain("--destroy");
  });
});

describe("E97: other job names keep the finish --destroy hints", () => {
  it.each(["main", "train"])("%s: running and finished", (name) => {
    const n = name === "main" ? "" : ` --name ${name}`;
    const running = job
      .stateHelp(42, rec(name, states.running(name)))
      .join("\n");
    expect(running).toContain(`Check again with \`vast-axi job 42${n}\``);
    expect(running).toContain(
      `vast-axi finish 42${n} --wait --fetch <remote>:<local> --destroy`,
    );
    const finished = job
      .stateHelp(42, rec(name, states.finished(name)))
      .join("\n");
    expect(finished).toContain(
      `Fetch results and tear down with \`vast-axi finish 42${n} --wait --fetch <remote>:<local> --destroy\``,
    );
  });

  it("failed and lost are unchanged", () => {
    const failed = job.stateHelp(42, rec("main", states.failed("main")));
    expect(failed[0]).toContain("the instance is kept");
    expect(failed[1]).toContain("vast-axi run 42 --overwrite -- <cmd>");
    const lost = job.stateHelp(42, rec("main", states.lost("main")));
    expect(lost[1]).toContain("vast-axi run 42 --overwrite -- <cmd>");
  });
});
