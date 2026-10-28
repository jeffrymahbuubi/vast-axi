// Plan assumption A1: the instance shape vast-axi was built against (synthesized
// tests/fixtures/instances.json) matches what live vast.ai returns. The live-*
// fixtures are real `show instance(s) --raw` captures run through
// scripts/record-fixtures.ts, which keeps only the fields vast-axi reads.
//
// A1 result, compared with instances.json:
//   - every field src/ reads is present in the live row with the same JS type
//   - live-only: `ports` (a docker port map; ssh resolves the direct
//     22/tcp -> public_ipaddr:HostPort path) and `image_runtype`. The synthesized
//     rows have neither, so they only ever exercised the ssh_host/ssh_port proxy path
//   - live `status_msg` is non-empty while running (synthesized: ""), and live
//     `start_date` is a float epoch, as in the synthesized rows
//   - the raw live rows also carry machine_id, host_id, geolocation, cur_state,
//     next_state, duration and cpu_util like the synthesized ones; the sanitizer
//     drops them because nothing in src/ reads them
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ALLOWED_FIELDS,
  assertClean,
  sanitizeCaptures,
} from "../scripts/record-fixtures.js";
import { instanceBurnPerHr } from "../src/burn.js";
import { resolveEndpoint, type InstanceInfo } from "../src/endpoint.js";
import { classifyInstance, instanceAgeHours } from "../src/instance-state.js";
import { runCli } from "./helpers/run-cli.js";
import synthesized from "./fixtures/instances.json" with { type: "json" };

const LIST = "live-show-instances-running.json";
const ONE = "live-show-instance-running.json";
const fixturePath = (name: string) =>
  new URL(`./fixtures/${name}`, import.meta.url);
const text = (name: string) => readFileSync(fixturePath(name), "utf8");
const live = JSON.parse(text(LIST))[0] as Record<string, unknown>;
const liveOne = JSON.parse(text(ONE)) as Record<string, unknown>;

/** `show instances` answers with `rows`; `show instance` answers with `rows[0]` as in the live capture. */
function routes(rows: unknown[]): Record<string, string> {
  return {
    FAKE_VASTAI_ROUTES: JSON.stringify({
      "show instances": { stdout: JSON.stringify(rows) },
      "show instance": { stdout: JSON.stringify(rows[0]) },
    }),
  };
}

const NOW_MS = (live["start_date"] as number) * 1000 + 3 * 3600 * 1000;

describe("live fixtures are sanitized", () => {
  it.each([LIST, ONE])("%s passes the denylist", (name) => {
    expect(() => assertClean(text(name), name)).not.toThrow();
  });

  it.each([LIST, ONE])(
    "%s has no IP outside 192.0.2.0/24, no jupyter_token and no long hex",
    (name) => {
      const body = text(name);
      for (const ip of body.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? []) {
        expect(ip).toMatch(/^192\.0\.2\.\d{1,3}$/);
      }
      expect(body).not.toContain("jupyter_token");
      expect(body).not.toMatch(/[0-9a-f]{32,}/);
    },
  );

  it("keeps only allowlisted fields, with the single row identical in both files", () => {
    for (const key of [...Object.keys(live), ...Object.keys(liveOne)]) {
      expect(ALLOWED_FIELDS as readonly string[]).toContain(key);
    }
    expect(liveOne).toEqual(live);
  });

  it("uses fake identities for the host, address and ids", () => {
    expect(live["ssh_host"]).toBe("ssh0.example.invalid");
    expect(live["public_ipaddr"]).toMatch(/^192\.0\.2\./);
    expect(live["id"]).toBe(4000001);
  });
});

describe("the sanitizer refuses leaks", () => {
  const dirty = {
    ...live,
    id: 987654321,
    ssh_host: "ssh5.vast.ai",
    public_ipaddr: "203.0.113.77",
    jupyter_token: "a".repeat(64),
    extra_env: { HF_TOKEN: "secret-value-123" },
    onstart: "echo hi",
    local_ipaddrs: "10.1.2.3 ",
    host_id: 123456,
    machine_id: 654321,
    ports: { "22/tcp": [{ HostIp: "0.0.0.0", HostPort: "31337" }] },
  };

  it("drops every non-allowlisted field and replaces identifying values", () => {
    const out = sanitizeCaptures([dirty], dirty);
    for (const body of [out.instances, out.instance]) {
      expect(() => assertClean(body)).not.toThrow();
      for (const gone of [
        "jupyter_token",
        "extra_env",
        "HF_TOKEN",
        "onstart",
        "local_ipaddrs",
        "host_id",
        "machine_id",
        "HostIp",
        "203.0.113.77",
        "vast.ai",
        "987654321",
        "31337",
      ]) {
        expect(body).not.toContain(gone);
      }
    }
  });

  it.each([
    ["a public IP", '{"ip":"203.0.113.9"}'],
    ["a private IP", '{"ip":"10.0.0.1"}'],
    ["a 32+ hex token", `{"t":"${"ab12".repeat(8)}"}`],
    ["a jupyter_token key", '{"jupyter_token":"x"}'],
    ["an ssh fingerprint", '{"k":"SHA256:c47adrLKbpFW"}'],
    ["an email", '{"e":"someone@example.com"}'],
    ["a real vast.ai host", '{"h":"ssh5.vast.ai"}'],
  ])("assertClean fails loudly on %s", (_what, body) => {
    expect(() => assertClean(body)).toThrow(/not clean/);
  });
});

describe("A1: classification on the live shape", () => {
  it("every field vast-axi reads is present in the live row with the synthesized type", () => {
    const synth = synthesized[0] as Record<string, unknown>;
    for (const key of Object.keys(synth)) {
      if (!(key in live)) continue; // dropped by the allowlist: src/ never reads it
      expect(typeof live[key], key).toBe(typeof synth[key]);
    }
    for (const key of [
      "id",
      "actual_status",
      "intended_status",
      "dph_total",
      "storage_cost",
      "disk_space",
      "start_date",
      "gpu_util",
      "ssh_host",
      "ssh_port",
    ]) {
      expect(live[key], key).not.toBeUndefined();
    }
  });

  it("running/running is class running; exited/stopped is stopped; loading is booting", () => {
    expect(classifyInstance(live, NOW_MS)).toEqual({ class: "running" });
    expect(
      classifyInstance(
        { ...live, actual_status: "exited", intended_status: "stopped" },
        NOW_MS,
      ),
    ).toEqual({ class: "stopped" });
    expect(
      classifyInstance({ ...live, actual_status: "loading" }, NOW_MS),
    ).toEqual({ class: "booting", reason: "slow" });
  });

  it("reads age from the float start_date", () => {
    expect(instanceAgeHours(live, NOW_MS)).toBe(3);
  });

  it("prices a running instance at dph_total and a stopped one at storage only", () => {
    expect(instanceBurnPerHr(live)).toBe(0.04891851851851852);
    expect(instanceBurnPerHr({ ...live, actual_status: "exited" })).toBeCloseTo(
      0.0018,
      4,
    );
  });

  it("resolves the direct ssh endpoint from ports + public_ipaddr", () => {
    expect(resolveEndpoint(live as InstanceInfo)).toEqual({
      host: "192.0.2.10",
      port: 40022,
    });
  });
});

describe("A1: commands on the live shape", () => {
  it("dashboard lists the instance with a 4-decimal price", async () => {
    const { stdout, exitCode } = await runCli([], { env: routes([live]) });
    expect(exitCode).toBe(0);
    expect(stdout).toContain(
      "instances[1]{id,label,gpu,status,dph_total,age_h,gpu_util,idle}:",
    );
    expect(stdout).toContain("4000001,vast-axi-smoke,GTX 1080,running,0.0489,");
    expect(stdout).toContain("burn_per_hr: 0.0489\n");
    expect(stdout).not.toContain("0.04891");
  });

  it("dashboard shows a stopped live-shaped instance's storage burn, never 0, beside its projection", async () => {
    const stopped = {
      ...live,
      actual_status: "exited",
      intended_status: "stopped",
    };
    const { stdout } = await runCli([], { env: routes([stopped]) });
    expect(stdout).toContain("stopped[1]{id,label,gpu,storage_per_hr}:");
    expect(stdout).toContain("burn_per_hr: 0.0018\n");
    expect(stdout).toContain("projection_24h: 0.04\n");
  });

  it("status list classifies the row as running", async () => {
    const { stdout, exitCode } = await runCli(["status"], {
      env: routes([live]),
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain(
      "4000001,vast-axi-smoke,GTX 1080,running,running,",
    );
    expect(stdout).toContain(",0.0489,");
  });

  it("status <id> prints ssh details, the image and the live status_msg", async () => {
    const { stdout, exitCode } = await runCli(["status", "4000001"], {
      env: routes([live]),
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("class: running");
    expect(stdout).toContain("dph_total: 0.0489\n");
    expect(stdout).toContain("ssh_host: ssh0.example.invalid");
    expect(stdout).toContain("ssh_port: 22001");
    expect(stdout).toContain('image: "ubuntu:22.04"');
    expect(stdout).toContain('status_msg: "success, running ubuntu_22.04/ssh"');
  });

  it("status <id> --wait returns at once for the running live row", async () => {
    const { stdout, exitCode } = await runCli(["status", "4000001", "--wait"], {
      env: routes([live]),
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("class: running");
  });

  it("ssh resolves the direct endpoint from a bare `show instance` object", async () => {
    const { stdout, exitCode } = await runCli(["ssh", "4000001"], {
      env: routes([liveOne]),
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("ssh -p 40022 root@192.0.2.10");
  });
});
