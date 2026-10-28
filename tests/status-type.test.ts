import { describe, expect, it } from "vitest";
import { runCli } from "./helpers/run-cli.js";

const status = (args: string[]) =>
  runCli(["status", ...args, "--json"], {
    env: { U4_FIXTURE: "u9-instances.json" },
  });

describe("status <id>: on-demand vs interruptible type", () => {
  it("is_bid false shows type on-demand", async () => {
    const { stdout, exitCode } = await status(["9101"]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ id: 9101, type: "on-demand" });
  });

  it("is_bid true shows type interruptible", async () => {
    const { stdout, exitCode } = await status(["9102"]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      id: 9102,
      type: "interruptible",
    });
  });

  it("a missing is_bid omits the type field", async () => {
    const { stdout, exitCode } = await status(["9103"]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).not.toHaveProperty("type");
  });

  it("prints type in the TOON detail view", async () => {
    const { stdout } = await runCli(["status", "9101"], {
      env: { U4_FIXTURE: "u9-instances.json" },
    });
    expect(stdout).toContain("type: on-demand");
  });

  it("the list view keeps its columns (type is a single-instance field)", async () => {
    const { stdout } = await runCli(["status"], {
      env: { U4_FIXTURE: "u9-instances.json" },
    });
    expect(stdout).toContain(
      "instances[3]{id,label,gpu,actual_status,class,reason,dph_total,age_h}:",
    );
  });
});
