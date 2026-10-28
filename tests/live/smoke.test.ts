// U8: the live lifecycle against the real vast.ai. It COSTS MONEY (a few cents),
// so it only runs with VAST_AXI_LIVE=1 and is excluded from `pnpm test`:
//
//   pnpm build && VAST_AXI_LIVE=1 pnpm vitest run tests/live
//
// It drives the BUILT CLI (`node dist/bin/vast-axi.js`) as a user would.
// VAST_AXI_BIN picks the vastai binary (default .venv/Scripts/vastai.exe) and a
// key must be configured (file or VAST_API_KEY). Phases:
//   a. free pre-checks: dashboard, account ssh key, E2, E4, E20, E30
//   b. paid: search, rent the cheapest, status --wait, ssh --exec, scp round trip, stop
//   c. post: E19 (stop again), destroy, E18 (destroy again)
// afterAll ALWAYS destroys any instance labelled vast-axi-smoke and fails the
// run if one survives.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const LABEL = "vast-axi-smoke";
const IMAGE = "ubuntu:22.04";
const MAX_DPH = "0.3";
const FILTER =
  "reliability2>0.98 inet_down>200 disk_space>40 direct_port_count>=1";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CLI = join(ROOT, "dist", "bin", "vast-axi.js");
const VASTAI =
  process.env["VAST_AXI_BIN"] ?? join(ROOT, ".venv", "Scripts", "vastai.exe");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Run {
  code: number;
  out: string; // stdout + stderr, for text assertions
  stdout: string;
}

/** Run the built CLI; `env` overrides the child environment (undefined removes a variable). */
function cli(
  args: string[],
  env: Record<string, string | undefined> = {},
  timeoutMs = 120_000,
): Run {
  const child = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: timeoutMs,
    input: "",
    env: cleanEnv({
      ...process.env,
      VAST_AXI_BIN: VASTAI,
      VAST_AXI_MAX_DPH: MAX_DPH,
      ...env,
    }),
  });
  const stdout = child.stdout ?? "";
  return {
    code: child.status ?? -1,
    out: stdout + (child.stderr ?? ""),
    stdout,
  };
}

function cleanEnv(env: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined),
  );
}

/** A command that must succeed and print JSON. */
function json<T = Record<string, unknown>>(
  args: string[],
  env?: Record<string, string | undefined>,
): T {
  const run = cli([...args, "--json"], env);
  expect(run.code, `${args.join(" ")} -> ${run.out}`).toBe(0);
  return JSON.parse(run.stdout) as T;
}

interface Row {
  id: number;
  label: string | null;
  class?: string;
}

/** Instances on the account; the empty state prints a string instead of a list. */
function listInstances(): Row[] {
  const body = json<{ instances: Row[] | string }>(["status"]);
  return Array.isArray(body.instances) ? body.instances : [];
}

/** Destroy every instance labelled vast-axi-smoke; returns how many were attempted. */
function destroySmokeInstances(): number {
  const smoke = listInstances().filter((i) => i.label === LABEL);
  for (const inst of smoke) cli(["destroy", String(inst.id)]);
  return smoke.length;
}

/** Account balance from the dashboard (the no-argument form has no --json). */
function balance(): number | null {
  const match = /^balance: (-?[0-9.]+)/m.exec(cli([]).stdout);
  return match ? Number(match[1]) : null;
}

/** The public key text of every ~/.ssh/*.pub, so we can match one against the account. */
function localPublicKeys(): string[] {
  const dir = join(homedir(), ".ssh");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".pub"))
    .map((f) => readFileSync(join(dir, f), "utf8").trim().split(/\s+/)[1] ?? "")
    .filter(Boolean);
}

/** Raw `vastai show user`; the ssh key stays inside this process and is never logged. */
function accountSshKey(): string {
  const run = spawnSync(VASTAI, ["--raw", "show", "user"], {
    encoding: "utf8",
    timeout: 60_000,
    input: "",
    env: cleanEnv(process.env),
  });
  const body = JSON.parse(run.stdout || "{}") as { ssh_key?: unknown };
  return typeof body.ssh_key === "string" ? body.ssh_key : "";
}

interface OfferRow {
  id: number;
  dph_total: number;
}

describe.skipIf(process.env["VAST_AXI_LIVE"] !== "1")(
  "live smoke (costs money)",
  () => {
    const state: { balanceBefore: number | null } = { balanceBefore: null };
    let workDir = "";

    beforeAll(() => {
      expect(
        existsSync(CLI),
        "run `pnpm build` first (dist/bin/vast-axi.js is missing)",
      ).toBe(true);
      // Precondition for ssh/scp: abort before anything is rented if the account key is unusable.
      const accountKey = accountSshKey();
      expect(
        accountKey.length,
        "no ssh key registered on the vast.ai account",
      ).toBeGreaterThan(0);
      const local = localPublicKeys();
      expect(
        local.some((k) => accountKey.includes(k)),
        "no ~/.ssh/*.pub matches the key registered on the vast.ai account",
      ).toBe(true);
      destroySmokeInstances(); // a leftover from an aborted run must not skew the checks
      workDir = mkdtempSync(join(tmpdir(), "vast axi smoke "));
    });

    afterAll(async () => {
      try {
        // Destroy, then check twice: the account may take a moment to drop the row.
        destroySmokeInstances();
        let survivors = listInstances().filter((i) => i.label === LABEL);
        for (let i = 0; i < 6 && survivors.length > 0; i++) {
          await sleep(5_000);
          destroySmokeInstances();
          survivors = listInstances().filter((r) => r.label === LABEL);
        }
        const after = balance();
        console.info(
          `[smoke] balance before=${state.balanceBefore} after=${after} (delayed charges may post later)`,
        );
        expect(survivors, "a vast-axi-smoke instance survived the run").toEqual(
          [],
        );
      } finally {
        if (workDir) rmSync(workDir, { recursive: true, force: true });
      }
    }, 180_000);

    it("a. free pre-checks: dashboard, E2, E4, E20, E30", () => {
      const dash = cli([]);
      expect(dash.code, dash.out).toBe(0);
      expect(dash.stdout).toContain("balance:");
      state.balanceBefore = balance();

      // E2: a bogus key (the environment wins over the key file) maps to AUTH_REQUIRED
      // and the key value is never echoed.
      const bogus = "bogus-key-for-vast-axi-e2";
      const e2 = cli(["status"], { VAST_API_KEY: bogus });
      expect(e2.code).toBe(1);
      expect(e2.out).toContain("code: AUTH_REQUIRED");
      expect(e2.out).not.toContain(bogus);

      // E4: nothing costs 0.0001 USD/hr, so the zero state is explicit and exit 0.
      const e4 = cli(["search", "--max-dph", "0.0001"]);
      expect(e4.code, e4.out).toBe(0);
      expect(e4.stdout).toContain("0 matching offers");

      // E20: an unknown flag is a usage error naming the valid flags.
      const e20 = cli(["search", "--bogus-flag"]);
      expect(e20.code).toBe(2);
      expect(e20.out).toContain("--limit");

      // E30: more matches than --limit are truncated with a total-count hint.
      const e30 = cli(["search", "--limit", "1"]);
      expect(e30.code, e30.out).toBe(0);
      expect(e30.stdout).toMatch(/Showing 1 of \d+ matching offers/);
    });

    it(
      "b+c. paid lifecycle: rent, boot, ssh, scp, stop, then E19, destroy, E18",
      async () => {
        let instanceId: number | undefined;
        try {
          // --- search the cheapest verified offers under the ceiling ---
          const found = json<{ offers: OfferRow[] | string }>([
            "search",
            "--max-dph",
            MAX_DPH,
            "--query",
            FILTER,
            "--limit",
            "2",
          ]);
          const offers = Array.isArray(found.offers) ? found.offers : [];
          expect(
            offers.length,
            "no offer matches the smoke filter under 0.3 USD/hr",
          ).toBeGreaterThan(0);

          // --- rent the cheapest; retry once with the next offer if it was taken ---
          let rented: { instance_id: number; dph_total: number } | undefined;
          for (const offer of offers.slice(0, 2)) {
            const rent = cli([
              "rent",
              String(offer.id),
              "--image",
              IMAGE,
              "--disk",
              "10",
              "--label",
              LABEL,
              "--json",
            ]);
            if (rent.code === 0) {
              rented = JSON.parse(rent.stdout) as {
                instance_id: number;
                dph_total: number;
              };
              break;
            }
            // Anything but a vanished offer is a real failure; do not spend again.
            expect(rent.out, "rent failed").toContain("OFFER_UNAVAILABLE");
          }
          expect(rented, "both offers were unavailable").toBeDefined();
          instanceId = rented!.instance_id;
          const id = String(instanceId);
          expect(rented!.dph_total).toBeLessThanOrEqual(Number(MAX_DPH));

          // --- boot ---
          const wait = cli(["status", id, "--wait", "--json"], {}, 11 * 60_000);
          expect(wait.code, wait.out).toBe(0);
          expect(JSON.parse(wait.stdout)).toMatchObject({
            class: "running",
            label: LABEL,
          });

          // --- ssh --exec (sshd can lag a few seconds behind `running`) ---
          let exec: Run | undefined;
          for (let attempt = 0; attempt < 8; attempt++) {
            exec = cli(
              ["ssh", id, "--exec", "--json", "--", "echo", "vast-axi-ok"],
              {},
              90_000,
            );
            if (exec.code === 0) break;
            await sleep(10_000);
          }
          expect(exec!.code, exec!.out).toBe(0);
          const execBody = JSON.parse(exec!.stdout) as {
            exit_code: number;
            output?: string;
          };
          expect(execBody.exit_code).toBe(0);
          expect(execBody.output ?? "").toContain("vast-axi-ok");

          // --- 1 KB scp round trip; the local path contains spaces ---
          mkdirSync(join(workDir, "in dir"), { recursive: true });
          const upPath = join(workDir, "in dir", "up file.bin");
          const downPath = join(workDir, "down file.bin");
          const payload = randomBytes(1024);
          writeFileSync(upPath, payload);
          const remote = `C.${id}:/tmp/vast-axi-smoke.bin`;
          const up = cli(["copy", `local:${upPath}`, remote], {}, 120_000);
          expect(up.code, up.out).toBe(0);
          const down = cli(["copy", remote, `local:${downPath}`], {}, 120_000);
          expect(down.code, down.out).toBe(0);
          expect(
            readFileSync(downPath).equals(payload),
            "downloaded bytes differ from uploaded",
          ).toBe(true);

          // --- stop, then wait for it to settle ---
          const stop = cli(["stop", id]);
          expect(stop.code, stop.out).toBe(0);
          expect(stop.stdout).toContain("stopping");
          let stopped = false;
          for (let i = 0; i < 24 && !stopped; i++) {
            const poll = json<{ class: string }>(["status", id]);
            stopped = poll.class === "stopped";
            if (!stopped) await sleep(10_000);
          }
          expect(
            stopped,
            "instance did not reach stopped within 4 minutes",
          ).toBe(true);

          // --- post: E19, destroy, E18 ---
          const again = cli(["stop", id]);
          expect(again.code, again.out).toBe(0);
          expect(again.stdout).toContain("(no-op)");

          const destroy = cli(["destroy", id]);
          expect(destroy.code, destroy.out).toBe(0);
          expect(destroy.stdout).toMatch(/destroy/);

          // The account can take a few seconds to drop the row; the no-op appears once it has.
          let e18: Run | undefined;
          for (let i = 0; i < 12; i++) {
            e18 = cli(["destroy", id]);
            if (e18.code === 0 && e18.stdout.includes("(no-op)")) break;
            await sleep(5_000);
          }
          expect(e18!.code, e18!.out).toBe(0);
          expect(e18!.stdout).toContain("(no-op)");
          instanceId = undefined;
        } finally {
          // Cheap insurance next to afterAll: never leave a paid instance behind.
          if (instanceId !== undefined) cli(["destroy", String(instanceId)]);
        }
      },
      30 * 60_000,
    );
  },
);
