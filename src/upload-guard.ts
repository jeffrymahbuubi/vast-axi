// Upload secret guard for `copy local:<path> C.<id>:<path>` (Phase 3).
// Walks the local source before scp starts and reports files that look like
// credentials, by name (.env, id_rsa, *.pem, ...) or by content (the shared
// patterns in secret-patterns.ts). Findings carry a path and a reason only;
// file contents and secret text are never returned.
import {
  type Stats,
  closeSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, dirname, parse, resolve, sep } from "node:path";
import { findSecretStrings } from "./secret-patterns.js";

/** Stop walking after this many entries; the caller then refuses (or notes) the upload. */
export const MAX_ENTRIES = 100_000;
/** Only text files up to this size are scanned for credential-shaped strings. */
export const MAX_CONTENT_BYTES = 1024 * 1024;
const BINARY_PROBE_BYTES = 8 * 1024;
/** Most rows shown in a refusal or in `allowed_secrets`. */
export const MAX_LISTED = 20;

export interface SecretFinding {
  /** Path relative to the source root, "/" separated; the root itself shows its own name. */
  path: string;
  /** `name: <rule>` or `content: <pattern name>`; never the secret text. */
  reason: string;
}

export interface GuardResult {
  findings: SecretFinding[];
  /** Entries that could not be read or stat'ed and so were not checked. */
  skipped: number;
  /** True when the walk stopped at MAX_ENTRIES: the scan is incomplete. */
  truncated: boolean;
}

const ENV_ALLOWED = new Set([".env.example", ".env.sample", ".env.template"]);
const SECRET_EXTENSIONS = [".pem", ".key", ".p12", ".pfx"];
const SECRET_NAMES = new Set([
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  ".git-credentials",
  ".netrc",
  ".pypirc",
  ".npmrc",
  "credentials.json",
  "kaggle.json",
  "vast_api_key",
  ".vast_api_key",
]);

/**
 * Why `segments` (path components, the entry's own name last) is a secret by
 * name, or undefined. Matching is case-insensitive on every platform: a file
 * called `.ENV` or `ID_RSA` is as sensitive on Linux as on Windows, so the
 * stricter choice is used everywhere.
 */
export function nameReason(segments: readonly string[]): string | undefined {
  const own = segments[segments.length - 1];
  if (own === undefined) return undefined;
  const name = own.toLowerCase();
  const parent = segments[segments.length - 2]?.toLowerCase();
  if (name === ".env" || (name.startsWith(".env.") && !ENV_ALLOWED.has(name))) {
    return `name: ${own}`;
  }
  if (SECRET_EXTENSIONS.some((ext) => name.endsWith(ext))) {
    return `name: *${name.slice(name.lastIndexOf("."))}`;
  }
  if (SECRET_NAMES.has(name)) return `name: ${own}`;
  if (name === "credentials" && parent === ".aws") {
    return "name: .aws/credentials";
  }
  if (name === ".ssh") return "name: .ssh/";
  if (segments.slice(0, -1).some((s) => s.toLowerCase() === ".ssh")) {
    return "name: inside .ssh/";
  }
  return undefined;
}

/** Pattern names found in a text file of at most MAX_CONTENT_BYTES, or undefined to skip it. */
function contentReason(path: string, size: number): string | undefined {
  if (size > MAX_CONTENT_BYTES) return undefined;
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(size);
    let got = 0;
    while (got < size) {
      const n = readSync(fd, buf, got, size - got, got);
      if (n === 0) break;
      got += n;
    }
    if (buf.subarray(0, Math.min(got, BINARY_PROBE_BYTES)).includes(0)) {
      return undefined;
    }
    const hits = findSecretStrings(buf.subarray(0, got).toString("utf8"));
    return hits.length > 0
      ? `content: ${hits.map((h) => h.name).join(", ")}`
      : undefined;
  } finally {
    closeSync(fd);
  }
}

/** Absolute path components of `p` without the drive or root. */
function absoluteSegments(p: string): string[] {
  const abs = resolve(p);
  return abs
    .slice(parse(abs).root.length)
    .split(sep)
    .filter((s) => s !== "");
}

/**
 * Scan what `scp -r <root>` would upload. A missing root yields no findings
 * (scp reports that itself). Symlinks are followed the way scp -r follows
 * them; each real directory is walked once, so a cyclic link cannot loop.
 */
export function scanUpload(
  root: string,
  maxEntries: number = MAX_ENTRIES,
): GuardResult {
  const result: GuardResult = { findings: [], skipped: 0, truncated: false };
  const visited = new Set<string>();
  let entries = 0;

  const realOf = (p: string): string | undefined => {
    try {
      return realpathSync.native(p);
    } catch {
      return undefined;
    }
  };

  const visit = (
    fsPath: string,
    rel: string[],
    prefix: readonly string[],
  ): void => {
    if (result.truncated) return;
    if (++entries > maxEntries) {
      result.truncated = true;
      return;
    }
    const display = rel.length > 0 ? rel.join("/") : (prefix.at(-1) ?? "");
    const own = [...prefix, ...rel];
    const byName = nameReason(own);
    let st: Stats;
    let isLink: boolean;
    try {
      isLink = lstatSync(fsPath).isSymbolicLink();
      st = statSync(fsPath);
    } catch {
      result.skipped++;
      if (byName) result.findings.push({ path: display, reason: byName });
      return;
    }
    let reason = byName;
    let real: string | undefined;
    if (isLink) {
      real = realOf(fsPath);
      if (real && !reason) {
        const viaTarget = nameReason(absoluteSegments(real));
        if (viaTarget) reason = `${viaTarget} (symlink target)`;
      }
    }
    if (st.isDirectory()) {
      if (reason) {
        // The whole directory goes up; one row is enough. Empty ones carry nothing.
        if (safeReaddir(fsPath)?.length) {
          result.findings.push({ path: display + "/", reason });
        }
        return;
      }
      const key = real ?? realOf(fsPath) ?? resolve(fsPath);
      if (visited.has(key)) return;
      visited.add(key);
      const names = safeReaddir(fsPath);
      if (!names) {
        result.skipped++;
        return;
      }
      for (const n of names.sort()) {
        visit(resolve(fsPath, n), [...rel, n], prefix);
      }
      return;
    }
    if (!st.isFile()) return; // sockets, devices, fifos: scp skips or fails on them
    if (!reason) {
      try {
        const c = contentReason(fsPath, st.size);
        if (c) reason = isLink ? `${c} (symlink target)` : c;
      } catch {
        result.skipped++;
      }
    }
    if (reason) result.findings.push({ path: display, reason });
  };

  const safeReaddir = (p: string): string[] | undefined => {
    try {
      return readdirSync(p);
    } catch {
      return undefined;
    }
  };

  try {
    lstatSync(root);
  } catch {
    return result;
  }
  const abs = resolve(root);
  // Ancestors only matter for the `.ssh/` and `.aws/credentials` rules.
  const prefix = [
    ...absoluteSegments(dirname(abs)),
    basename(abs) || parse(abs).root,
  ];
  visit(abs, [], prefix);
  return result;
}

/** `path (reason)` rows for a message, at most MAX_LISTED, then `and N more`. */
export function formatFindings(findings: readonly SecretFinding[]): string[] {
  const rows = findings
    .slice(0, MAX_LISTED)
    .map((f) => `${f.path} (${f.reason})`);
  if (findings.length > MAX_LISTED) {
    rows.push(`and ${findings.length - MAX_LISTED} more`);
  }
  return rows;
}
