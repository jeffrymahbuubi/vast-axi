import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as copy from "../src/commands/copy.js";
import { REGISTRY, type Registry } from "../src/commands/index.js";
import type { ToolSpawner } from "../src/transfer.js";
import { runCli } from "./helpers/run-cli.js";

// Credential-shaped content is built at runtime, never written as a literal.
const rep = (c: string, n: number): string => c.repeat(n);
const hfToken = (): string => `hf_${rep("a", 34)}`;

function copyRegistry(): { registry: Registry; spawned: string[][] } {
  const spawned: string[][] = [];
  const spawn: ToolSpawner = (_file, args) => {
    spawned.push(args);
    return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
  };
  const command = copy.createCopyCommand({ spawn, resolveTool: () => "scp" });
  return {
    spawned,
    registry: {
      home: REGISTRY.home,
      commands: { ...REGISTRY.commands, copy: { command, help: copy.help } },
    },
  };
}

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "vast-axi-guard-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, ...rel.split("/"));
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
  }
  return root;
}

describe("copy upload guard", () => {
  it("refuses a directory with secrets before scp starts, listing path and reason only", async () => {
    const root = tree({
      "app/.env": "A=1\n",
      "app/keys/id_ed25519": "x",
      "app/notes.txt": `token ${hfToken()}\n`,
      "app/ok.py": "print(1)\n",
    });
    const { registry, spawned } = copyRegistry();
    const out = await runCli(
      ["copy", `local:${join(root, "app")}`, "C.42:/workspace/app"],
      { registry },
    );
    expect(out.exitCode).toBe(2);
    expect(spawned).toEqual([]);
    expect(out.stdout).toContain("code: VALIDATION_ERROR");
    expect(out.stdout).toContain("3 path(s) look like secrets");
    expect(out.stdout).toContain(".env (name: .env)");
    expect(out.stdout).toContain("keys/id_ed25519 (name: id_ed25519)");
    expect(out.stdout).toContain("notes.txt (content: Hugging Face token)");
    expect(out.stdout).not.toContain("ok.py");
    expect(out.stdout).not.toContain(hfToken());
    expect(out.stdout).toContain("--allow-secrets");
  });

  it("E79: a .env deep inside a directory is found", async () => {
    const root = tree({ "a/b/c/d/.env": "K=v\n", "a/x.txt": "hi\n" });
    const { registry, spawned } = copyRegistry();
    const out = await runCli(["copy", root, "C.42:/workspace/p"], { registry });
    expect(out.exitCode).toBe(2);
    expect(out.stdout).toContain("a/b/c/d/.env (name: .env)");
    expect(spawned).toEqual([]);
  });

  it("E80: .env.example, .env.sample and .env.template upload fine", async () => {
    const root = tree({
      ".env.example": "K=\n",
      ".env.sample": "K=\n",
      ".env.template": "K=\n",
    });
    const { registry, spawned } = copyRegistry();
    const out = await runCli(["copy", root, "C.42:/workspace/p"], { registry });
    expect(out.exitCode).toBe(0);
    expect(spawned).toHaveLength(1);
  });

  it("E81: --allow-secrets uploads and lists what was allowed", async () => {
    const root = tree({ ".env": "K=v\n", "keys/server.pem": "x" });
    const { registry, spawned } = copyRegistry();
    const out = await runCli(
      ["copy", root, "C.42:/workspace/p", "--allow-secrets"],
      { registry },
    );
    expect(out.exitCode).toBe(0);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).not.toContain("--allow-secrets");
    expect(out.stdout).toContain("allowed_secrets[2]{path,reason}:");
    expect(out.stdout).toContain("keys/server.pem");
  });

  it("caps the refusal at 20 paths and says how many more", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 25; i++) {
      files[`k/f${String(i).padStart(2, "0")}.pem`] = "x";
    }
    const root = tree(files);
    const { registry } = copyRegistry();
    const out = await runCli(["copy", root, "C.42:/workspace/p"], { registry });
    expect(out.exitCode).toBe(2);
    expect(out.stdout).toContain("25 path(s) look like secrets");
    expect(out.stdout).toContain("f19.pem");
    expect(out.stdout).not.toContain("f20.pem");
    expect(out.stdout).toContain("and 5 more");
  });

  it("caps allowed_secrets at 20 rows plus a count", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 22; i++) {
      files[`f${String(i).padStart(2, "0")}.key`] = "x";
    }
    const root = tree(files);
    const { registry } = copyRegistry();
    const out = await runCli(
      ["copy", root, "C.42:/workspace/p", "--allow-secrets"],
      { registry },
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("allowed_secrets[20]{path,reason}:");
    expect(out.stdout).toContain("allowed_secrets_more: 2");
  });

  it("a single secret file as the source is refused too", async () => {
    const root = tree({ ".env": "K=v\n" });
    const { registry, spawned } = copyRegistry();
    const out = await runCli(
      ["copy", join(root, ".env"), "C.42:/workspace/.env"],
      { registry },
    );
    expect(out.exitCode).toBe(2);
    expect(spawned).toEqual([]);
  });

  it("downloads are not guarded", async () => {
    const root = tree({ ".env": "K=v\n" });
    const { registry, spawned } = copyRegistry();
    const out = await runCli(["copy", "C.42:/workspace/out", root], {
      registry,
    });
    expect(out.exitCode).toBe(0);
    expect(spawned).toHaveLength(1);
    expect(out.stdout).not.toContain("allowed_secrets");
  });

  it("a clean upload prints only copy, command and exit_code", async () => {
    const root = tree({ "src/main.py": "print(1)\n", "README.md": "# hi\n" });
    const { registry, spawned } = copyRegistry();
    const out = await runCli(["copy", root, "C.42:/workspace/p"], { registry });
    expect(out.exitCode).toBe(0);
    expect(spawned).toHaveLength(1);
    const keys = out.stdout
      .split("\n")
      .filter((l) => /^[a-z_]+:/.test(l))
      .map((l) => l.split(":")[0]);
    expect(keys).toEqual(["copy", "command", "exit_code"]);
  });

  it("--help documents --allow-secrets", async () => {
    const out = await runCli(["copy", "--help"]);
    expect(out.stdout).toContain("--allow-secrets");
  });
});
