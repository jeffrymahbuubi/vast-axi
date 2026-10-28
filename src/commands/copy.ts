import { assertKnownFlags, takeBoolFlag, takePositional } from "../args.js";
import { assertNoExtra, requireEndpoint } from "../endpoint.js";
import { AxiError, mapVastError, redactSecrets } from "../errors.js";
import { truncate } from "../format.js";
import { buildHelp } from "../help.js";
import {
  formatFindings,
  MAX_ENTRIES,
  MAX_LISTED,
  scanUpload,
} from "../upload-guard.js";
import {
  assertSafeDestination,
  buildScpArgs,
  parseLocation,
  renderCommand,
  requireTool,
  spawnTool,
  type ToolSpawner,
} from "../transfer.js";
import { vastExec } from "../vastai.js";
import type { VastCommand } from "./types.js";

const USAGE = "vast-axi copy <src> <dst>";

export const help = buildHelp({
  usage: USAGE,
  summary:
    "Copy files between this machine and an instance (scp), or between instances (vastai copy).",
  notes: [
    "Locations: local:<path> or a plain path, C.<id>:<path>. Cloud locators (s3.101:, drive:) and instance-to-instance copies go to `vastai copy` unchanged.",
    "Local copies need the OpenSSH `scp` on PATH; rsync is never used.",
    "Copying into / or /root is refused: it breaks ssh access to the instance.",
    "Uploads are scanned first and refused (exit 2) if they hold secrets: .env/.env.* (not .env.example), *.pem *.key *.p12 *.pfx, id_rsa/id_ed25519 keys, .ssh/, .aws/credentials, .netrc .npmrc .pypirc .git-credentials, credentials.json kaggle.json, vast_api_key, or text with a token (hf_, sk-, ghp_, AKIA, 64-hex...). Downloads are not scanned.",
  ],
  flags: [
    "--allow-secrets   upload even if the scan finds secrets (they are listed as allowed_secrets)",
  ],
  examples: [
    "vast-axi copy local:./data C.42:/workspace/data",
    "vast-axi copy C.42:/workspace/out local:./out",
    "vast-axi copy C.42:/workspace/a C.43:/workspace/a",
  ],
});

export interface CopyDeps {
  spawn?: ToolSpawner;
  resolveTool?: (name: "scp") => string;
}

/** Factory so tests can inject the spawner; real runs use the default below. */
export function createCopyCommand(deps: CopyDeps = {}): VastCommand {
  const spawn = deps.spawn ?? spawnTool;
  const resolveTool = deps.resolveTool ?? requireTool;
  return async (args) => {
    assertKnownFlags(args, ["--allow-secrets"], "copy");
    const allowSecrets = takeBoolFlag(args, "--allow-secrets");
    const src = takePositional(args, "src", `usage: ${USAGE}`);
    const dst = takePositional(args, "dst", `usage: ${USAGE}`);
    assertNoExtra(args, USAGE);
    const from = parseLocation(src);
    const to = parseLocation(dst);

    // Checked before any network call or process start.
    if (to.kind === "instance") assertSafeDestination(to.path);

    if (from.kind === "local" && to.kind === "local") {
      throw new AxiError(
        "both sides are local; copy needs an instance on one side",
        "VALIDATION_ERROR",
        ["Use `cp` for local files, or `C.<id>:<path>` for an instance"],
      );
    }

    const direction =
      from.kind === "local" && to.kind === "instance"
        ? "up"
        : from.kind === "instance" && to.kind === "local"
          ? "down"
          : undefined;

    if (!direction) {
      if (from.kind === "local" || to.kind === "local") {
        // Upstream would shell out to rsync for this; refuse rather than call it (E24).
        throw new AxiError(
          "local copies work only with an instance (C.<id>:<path>) on the other side",
          "VALIDATION_ERROR",
          [
            "Copy from the instance to local first, or between instance and cloud storage with `vastai copy`",
          ],
        );
      }
      // Remote to remote: no local leg, so upstream needs no rsync (E24).
      const text = (await vastExec(["copy", src, dst])).trim();
      if (!/initiated/i.test(text)) {
        throw mapVastError({ status: null, msg: text || "copy not accepted" });
      }
      return {
        copy: `${src} -> ${dst}`,
        status: "remote-to-remote copy initiated",
        help: [
          "Progress shows on the instance status bar after about 30s; `vast-axi status <id>` checks the instance",
        ],
      };
    }

    const instance = direction === "up" ? to : from;
    if (instance.kind !== "instance") throw new Error("unreachable");
    const local = direction === "up" ? from : to;
    if (local.kind !== "local") throw new Error("unreachable");

    // Local scan, before scp or any network call (Phase 3 upload guard).
    const guard: Record<string, unknown> = {};
    if (direction === "up") {
      const scan = scanUpload(local.path);
      const skipped = scan.skipped
        ? `${scan.skipped} unreadable entries not scanned`
        : undefined;
      if (scan.truncated && !allowSecrets) {
        throw new AxiError(
          `refusing to upload: the source has more than ${MAX_ENTRIES} entries, too many to scan for secrets`,
          "VALIDATION_ERROR",
          [
            "Upload a narrower source (a subdirectory, or an archive)",
            "Or rerun with --allow-secrets to skip the scan",
          ],
        );
      }
      if (scan.findings.length > 0 && !allowSecrets) {
        throw new AxiError(
          // One line: the error renderer escapes newlines inside a message.
          `refusing to upload: ${scan.findings.length} path(s) look like secrets: ${[
            ...formatFindings(scan.findings),
            ...(skipped ? [`guard_skipped: ${skipped}`] : []),
          ].join("; ")}`,
          "VALIDATION_ERROR",
          [
            "Move or delete these files, or upload a narrower source",
            "Or rerun with --allow-secrets to upload them anyway",
          ],
        );
      }
      if (scan.findings.length > 0) {
        guard["allowed_secrets"] = scan.findings.slice(0, MAX_LISTED);
        if (scan.findings.length > MAX_LISTED) {
          guard["allowed_secrets_more"] = scan.findings.length - MAX_LISTED;
        }
      }
      if (scan.truncated) {
        guard["guard_note"] =
          `scan stopped at ${MAX_ENTRIES} entries; skipped by --allow-secrets`;
      }
      if (skipped) guard["guard_skipped"] = skipped;
    }

    const scp = resolveTool("scp");
    const endpoint = await requireEndpoint(instance.id);
    const scpArgs = buildScpArgs(
      direction,
      endpoint,
      local.path,
      instance.path,
    );
    const run = await spawn(scp, scpArgs, { capture: true });
    if (run.exitCode !== 0) {
      const detail =
        redactSecrets(truncate(run.stderr.trim(), 400)) ||
        `scp exited with code ${run.exitCode}`;
      throw new AxiError(`scp failed: ${detail}`, "TRANSFER_FAILED", [
        `Run \`vast-axi status ${instance.id}\` to check the instance is running`,
        "The account needs an ssh key attached on vast.ai for scp to log in",
      ]);
    }
    return {
      copy: `${src} -> ${dst}`,
      command: renderCommand("scp", scpArgs),
      exit_code: 0,
      ...guard,
    };
  };
}

export const command: VastCommand = createCopyCommand();
