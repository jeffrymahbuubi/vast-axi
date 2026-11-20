// `finish --fetch`: list the remote paths, scp each one down and verify it.
import { mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { Endpoint } from "./endpoint.js";
import { redactSecrets } from "./errors.js";
import { truncate } from "./format.js";
import { buildRemoteCommand, resolveRemotePath } from "./job.js";
import {
  expectedLocalFiles,
  buildListScript,
  parseListOutput,
  verifyFetch,
  type LocalStat,
} from "./job-fetch.js";
import {
  buildScpArgs,
  requireTool,
  runSsh,
  spawnTool,
  type ToolSpawner,
} from "./transfer.js";

export interface FetchDeps {
  spawn?: ToolSpawner;
  resolveTool?: (name: "ssh" | "scp") => string;
  stat?: (path: string) => LocalStat | undefined;
  mkdirp?: (path: string) => void;
}

function realStat(path: string): LocalStat | undefined {
  try {
    const s = statSync(path);
    return { size: s.size, isDirectory: s.isDirectory() };
  } catch {
    return undefined;
  }
}

export interface FetchRow {
  remote: string;
  local: string;
  files: number;
  bytes: number;
  ok: "yes" | "no";
  note: string;
}

export async function fetchAll(
  deps: FetchDeps,
  id: number,
  endpoint: Endpoint,
  cwd: string,
  specs: Array<{ remote: string; local: string }>,
): Promise<FetchRow[]> {
  const spawn = deps.spawn ?? spawnTool;
  const resolveTool = deps.resolveTool ?? requireTool;
  const stat = deps.stat ?? realStat;
  const mkdirp =
    deps.mkdirp ?? ((p: string) => void mkdirSync(p, { recursive: true }));
  const remotes = specs.map((s) => resolveRemotePath(s.remote, cwd, "--fetch"));
  const { run } = await runSsh(spawn, resolveTool("ssh"), id, endpoint, [
    buildRemoteCommand(buildListScript(remotes)),
  ]);
  const listings = parseListOutput(run.stdout, specs.length);
  const scp = resolveTool("scp");

  const rows: FetchRow[] = [];
  for (const [i, spec] of specs.entries()) {
    const remote = remotes[i]!;
    const listing = listings[i]!;
    const row = (v: Partial<FetchRow>): FetchRow => ({
      remote,
      local: spec.local,
      files: 0,
      bytes: 0,
      ok: "no",
      note: "",
      ...v,
    });
    if (listing.absent) {
      rows.push(row({ note: "not found on the instance" }));
      continue;
    }
    if (listing.files.length === 0) {
      rows.push(row({ note: "no files at the remote path" }));
      continue;
    }
    const before = stat(spec.local);
    mkdirp(dirname(spec.local));
    const copy = await spawn(
      scp,
      buildScpArgs("down", endpoint, spec.local, remote),
      { capture: true },
    );
    if (copy.exitCode !== 0) {
      const why = redactSecrets(truncate(copy.stderr.trim(), 300));
      rows.push(
        row({
          files: listing.files.length,
          note: `scp failed: ${why || `exit ${copy.exitCode}`}`,
        }),
      );
      continue;
    }
    const verdict = verifyFetch(
      expectedLocalFiles(
        remote,
        listing.files,
        spec.local,
        before?.isDirectory === true,
      ),
      stat,
    );
    rows.push(
      row({
        files: verdict.files,
        bytes: verdict.bytes,
        ok: verdict.ok ? "yes" : "no",
        note: verdict.note,
      }),
    );
  }
  return rows;
}
