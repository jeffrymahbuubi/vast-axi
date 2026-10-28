// status labels the proxy pair and the direct endpoint `ssh`/`copy` really use.
import { describe, expect, it } from "vitest";
import { runCli } from "./helpers/run-cli.js";

function inst(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 5001,
    label: "job",
    gpu_name: "RTX 4090",
    num_gpus: 1,
    image_uuid: "example/image:latest",
    dph_total: 0.4,
    actual_status: "running",
    intended_status: "running",
    status_msg: "",
    ssh_host: "ssh8.vast.example",
    ssh_port: 12638,
    start_date: Date.now() / 1000 - 7200,
    gpu_util: 80,
    ...over,
  };
}

const status = (row: Record<string, unknown>) =>
  runCli(["status", "5001"], {
    env: {
      FAKE_VASTAI_ROUTES: JSON.stringify({
        "show instances": { stdout: JSON.stringify([row]) },
      }),
    },
  });

describe("status ssh endpoints", () => {
  it("E99: shows ssh_direct (what ssh/copy use) next to the labelled proxy", async () => {
    const { stdout, exitCode } = await status(
      inst({
        public_ipaddr: "203.0.113.6",
        ports: { "22/tcp": [{ HostIp: "0.0.0.0", HostPort: "30457" }] },
      }),
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain('ssh_direct: "203.0.113.6:30457"');
    expect(stdout).toContain('ssh_proxy: "ssh8.vast.example:12638"');
    expect(stdout).toContain("ssh_host: ssh8.vast.example");
    expect(stdout).toContain("ssh_port: 12638");
  });

  it("E100: without a direct endpoint there is no ssh_direct; the proxy is labelled", async () => {
    const { stdout, exitCode } = await status(inst());
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain("ssh_direct");
    expect(stdout).toContain('ssh_proxy: "ssh8.vast.example:12638"');
  });

  it("E100: a public_ipaddr without a 22/tcp mapping is not direct", async () => {
    const { stdout } = await status(inst({ public_ipaddr: "203.0.113.6" }));
    expect(stdout).not.toContain("ssh_direct");
  });

  it("E100: no ssh endpoint at all prints null host/port and no labels", async () => {
    const { stdout } = await status(inst({ ssh_host: null, ssh_port: null }));
    expect(stdout).toContain("ssh_host: null");
    expect(stdout).not.toContain("ssh_proxy");
    expect(stdout).not.toContain("ssh_direct");
  });
});
