import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatFindings,
  nameReason,
  scanUpload,
  type SecretFinding,
} from "../src/upload-guard.js";

// Credential-shaped content is built at runtime, never written as a literal.
const rep = (c: string, n: number): string => c.repeat(n);
const hfToken = (): string => `hf_${rep("a", 34)}`;

function tree(files: Record<string, string | Buffer>): string {
  const root = mkdtempSync(join(tmpdir(), "vast-axi-guard-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, ...rel.split("/"));
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
  }
  return root;
}

const paths = (r: { findings: SecretFinding[] }): string[] =>
  r.findings.map((f) => f.path).sort();

/**
 * Try to create a symlink; false when the platform refuses. Windows needs
 * privilege for file and dir symlinks, so directories fall back to junctions
 * (which Node reports as symbolic links) and file-link tests are skipped.
 */
function tryLink(target: string, link: string, type: "file" | "dir"): boolean {
  try {
    const t =
      type === "dir" && process.platform === "win32" ? "junction" : type;
    symlinkSync(target, link, t);
    return true;
  } catch {
    return false;
  }
}

const canLinkFiles = ((): boolean => {
  const dir = mkdtempSync(join(tmpdir(), "vast-axi-guard-probe-"));
  writeFileSync(join(dir, "a"), "x");
  return tryLink(join(dir, "a"), join(dir, "b"), "file");
})();

describe("nameReason", () => {
  it.each([
    [[".env"], "name: .env"],
    [[".env.local"], "name: .env.local"],
    [[".env.production"], "name: .env.production"],
    [["a", ".ENV"], "name: .ENV"],
    [["server.pem"], "name: *.pem"],
    [["tls.key"], "name: *.key"],
    [["bundle.p12"], "name: *.p12"],
    [["bundle.PFX"], "name: *.pfx"],
    [["id_rsa"], "name: id_rsa"],
    [["id_dsa"], "name: id_dsa"],
    [["id_ecdsa"], "name: id_ecdsa"],
    [["id_ed25519"], "name: id_ed25519"],
    [[".git-credentials"], "name: .git-credentials"],
    [[".netrc"], "name: .netrc"],
    [[".pypirc"], "name: .pypirc"],
    [[".npmrc"], "name: .npmrc"],
    [["credentials.json"], "name: credentials.json"],
    [["kaggle.json"], "name: kaggle.json"],
    [["vast_api_key"], "name: vast_api_key"],
    [[".vast_api_key"], "name: .vast_api_key"],
    [[".aws", "credentials"], "name: .aws/credentials"],
    [[".ssh"], "name: .ssh/"],
    [[".ssh", "config"], "name: inside .ssh/"],
  ])("%j is a secret", (segments, reason) => {
    expect(nameReason(segments)).toBe(reason);
  });

  it.each([
    [[".env.example"]],
    [[".env.sample"]],
    [[".env.template"]],
    [["id_rsa.pub"]],
    [["id_ed25519.pub"]],
    [["credentials"]],
    [["other", "credentials"]],
    [["environment.py"]],
    [["monkey.txt"]],
    [["keys.py"]],
    [["package.json"]],
  ])("%j is allowed", (segments) => {
    expect(nameReason(segments)).toBeUndefined();
  });
});

describe("scanUpload", () => {
  it("E79: finds a .env deep inside a directory", () => {
    const root = tree({ "a/b/c/.env": "K=v\n", "a/ok.txt": "hello\n" });
    expect(paths(scanUpload(root))).toEqual(["a/b/c/.env"]);
  });

  it("E80: .env.example is not a finding", () => {
    const root = tree({ ".env.example": "K=\n", ".env.local": "K=v\n" });
    expect(paths(scanUpload(root))).toEqual([".env.local"]);
  });

  it("flags every name family and leaves .pub files alone", () => {
    const root = tree({
      "a.pem": "x",
      "b.key": "x",
      "c.p12": "x",
      "d.pfx": "x",
      id_rsa: "x",
      "id_rsa.pub": "x",
      ".netrc": "x",
      ".aws/credentials": "x",
      ".aws/config": "x",
      ".ssh/known_hosts": "x",
      vast_api_key: "x",
      "kaggle.json": "x",
    });
    expect(paths(scanUpload(root))).toEqual(
      [
        ".aws/credentials",
        ".ssh/",
        "a.pem",
        "b.key",
        "c.p12",
        "d.pfx",
        "id_rsa",
        "kaggle.json",
        ".netrc",
        "vast_api_key",
      ].sort(),
    );
  });

  it("flags text content with a token and names the pattern", () => {
    const root = tree({
      "notes.txt": `x\ntoken=${hfToken()}\n`,
      "ok.txt": "hi",
    });
    const r = scanUpload(root);
    expect(r.findings).toEqual([
      { path: "notes.txt", reason: "content: Hugging Face token" },
    ]);
    expect(JSON.stringify(r)).not.toContain(hfToken());
  });

  it("skips a binary file even if it contains a token-shaped string", () => {
    const body = Buffer.concat([
      Buffer.from([0, 1, 2, 0]),
      Buffer.from(hfToken()),
    ]);
    expect(scanUpload(tree({ "blob.bin": body })).findings).toEqual([]);
  });

  it("does not read content of files over 1 MB", () => {
    const big = Buffer.from(hfToken() + " ".repeat(1024 * 1024 + 10));
    expect(scanUpload(tree({ "big.txt": big })).findings).toEqual([]);
  });

  it("a single file as the source is checked by its own name", () => {
    const root = tree({ ".env": "K=v\n" });
    expect(scanUpload(join(root, ".env")).findings).toEqual([
      { path: ".env", reason: "name: .env" },
    ]);
  });

  it("a source under a .ssh directory is flagged", () => {
    const root = tree({ ".ssh/config": "Host x\n" });
    expect(paths(scanUpload(join(root, ".ssh", "config")))).toEqual(["config"]);
  });

  it("a missing source yields no findings (scp reports it)", () => {
    const r = scanUpload(join(tmpdir(), "vast-axi-no-such-path-xyz"));
    expect(r).toEqual({ findings: [], skipped: 0, truncated: false });
  });

  it("stops at the entry limit and says so", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 12; i++) files[`f${i}.txt`] = "x";
    const r = scanUpload(tree(files), 5);
    expect(r.truncated).toBe(true);
    expect(scanUpload(tree(files), 100).truncated).toBe(false);
  });

  it.skipIf(!canLinkFiles)(
    "E84: a symlink to a secret file is flagged by its target",
    () => {
      const root = tree({ "real/.env": "K=v\n" });
      const src = tree({});
      if (
        !tryLink(join(root, "real", ".env"), join(src, "config.txt"), "file")
      ) {
        return; // symlinks need privileges on Windows
      }
      expect(scanUpload(src).findings).toEqual([
        { path: "config.txt", reason: "name: .env (symlink target)" },
      ]);
    },
  );

  it("E84: a symlink to a directory is followed, and a cycle does not loop", () => {
    const outside = tree({ "inner/id_rsa": "x" });
    const src = tree({ "ok.txt": "hi" });
    if (!tryLink(outside, join(src, "linked"), "dir")) return;
    // a cycle: loop -> src itself
    if (!tryLink(src, join(src, "loop"), "dir")) return;
    const r = scanUpload(src);
    expect(paths(r)).toEqual(["linked/inner/id_rsa"]);
    expect(r.truncated).toBe(false);
  });

  it.skipIf(!canLinkFiles)(
    "a link that points at a file with a token is flagged by content",
    () => {
      const outside = tree({ "t.txt": `k ${hfToken()}\n` });
      const src = tree({});
      if (!tryLink(join(outside, "t.txt"), join(src, "ln.txt"), "file")) return;
      expect(scanUpload(src).findings).toEqual([
        {
          path: "ln.txt",
          reason: "content: Hugging Face token (symlink target)",
        },
      ]);
    },
  );

  it.skipIf(!canLinkFiles)(
    "a dangling symlink is counted as skipped, not an error",
    () => {
      const src = tree({ "a.txt": "x" });
      if (!tryLink(join(src, "gone"), join(src, "dangling"), "file")) return;
      const r = scanUpload(src);
      expect(r.skipped).toBe(1);
      expect(r.findings).toEqual([]);
    },
  );
});

describe("formatFindings", () => {
  it("lists 20 rows then `and N more`", () => {
    const findings = Array.from({ length: 23 }, (_, i) => ({
      path: `f${i}`,
      reason: "name: x",
    }));
    const rows = formatFindings(findings);
    expect(rows).toHaveLength(21);
    expect(rows[0]).toBe("f0 (name: x)");
    expect(rows[20]).toBe("and 3 more");
  });
});
