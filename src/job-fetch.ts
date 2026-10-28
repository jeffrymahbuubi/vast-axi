// The `finish --fetch` half of the job helpers: list what is on the instance,
// work out where scp will put it, and verify the result (OQ22). Pure; split
// from job.ts to keep both files under 500 lines.
import { join, posix } from "node:path";
import { truncate } from "./format.js";
import { PREFIX, shellQuote } from "./job.js";

/** Remote script listing every file (with byte size) under each path (E44: only metadata crosses ssh). */
export function buildListScript(paths: string[]): string {
  return (
    paths
      .map(
        (p, i) =>
          `echo '${PREFIX} spec ${i}'\n` +
          `if [ -e ${shellQuote(p)} ]; then find -H ${shellQuote(p)} -type f -printf '%s %p\\n'; echo '${PREFIX} end'; else echo '${PREFIX} absent'; fi`,
      )
      .join("\n") + "\nexit 0\n"
  );
}

export interface RemoteListing {
  absent: boolean;
  files: Array<{ size: number; path: string }>;
}

export function parseListOutput(
  stdout: string,
  count: number,
): RemoteListing[] {
  const out: RemoteListing[] = Array.from({ length: count }, () => ({
    absent: true,
    files: [],
  }));
  let cur: RemoteListing | undefined;
  for (const raw of stdout.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const spec = new RegExp(`^${PREFIX} spec (\\d+)$`).exec(line);
    if (spec) {
      cur = out[Number(spec[1])];
    } else if (line === `${PREFIX} end` && cur) {
      cur.absent = false;
    } else if (cur) {
      const f = /^(\d+) (\/.*)$/.exec(line);
      if (f) cur.files.push({ size: Number(f[1]), path: f[2]! });
    }
  }
  return out;
}

export interface LocalStat {
  size: number;
  isDirectory: boolean;
}

export interface FetchVerdict {
  files: number;
  bytes: number;
  ok: boolean;
  note: string;
}

/**
 * Where scp puts each remote file, from the local target's state BEFORE the
 * copy: into an existing local directory the remote name is kept, otherwise
 * the local path is the copy itself.
 */
export function expectedLocalFiles(
  remote: string,
  files: RemoteListing["files"],
  local: string,
  localIsDir: boolean,
): Array<{ local: string; size: number }> {
  if (files.length === 1 && files[0]!.path === remote) {
    const target = localIsDir ? join(local, posix.basename(remote)) : local;
    return [{ local: target, size: files[0]!.size }];
  }
  const base = localIsDir ? join(local, posix.basename(remote)) : local;
  return files.map((f) => ({
    local: join(base, ...posix.relative(remote, f.path).split("/")),
    size: f.size,
  }));
}

/** OQ22: every remote file exists locally with the same byte size, and the target totals > 0 bytes. */
export function verifyFetch(
  expected: Array<{ local: string; size: number }>,
  stat: (path: string) => LocalStat | undefined,
): FetchVerdict {
  if (expected.length === 0) {
    return {
      files: 0,
      bytes: 0,
      ok: false,
      note: "no files at the remote path",
    };
  }
  let bytes = 0;
  const problems: string[] = [];
  for (const e of expected) {
    const got = stat(e.local);
    if (!got || got.isDirectory) problems.push(`missing locally: ${e.local}`);
    else if (got.size !== e.size) {
      problems.push(`size ${got.size} != ${e.size}: ${e.local}`);
    } else bytes += got.size;
  }
  if (problems.length === 0 && bytes === 0) problems.push("0 bytes fetched");
  return {
    files: expected.length,
    bytes,
    ok: problems.length === 0,
    note: truncate(problems.slice(0, 3).join("; "), 300),
  };
}
