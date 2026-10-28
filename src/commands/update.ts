import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isUpdateAvailable } from "axi-sdk-js";
import { assertKnownFlags, takeBoolFlag } from "../args.js";
import { AxiError, redactSecrets } from "../errors.js";
import { buildHelp } from "../help.js";
import { VERSION } from "../version.js";
import type { VastCommand } from "./types.js";

export const REPO = "jeffrymahbuubi/vast-axi";

/** Accepted release tags; also what makes the commands safe to hand to a shell on Windows. */
const TAG = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

/** The release asset `npm pack` produced; the name is also safe to hand to a shell on Windows. */
const ASSET = /^vast-axi-[0-9A-Za-z.+-]+\.tgz$/;

/** gh's own words for "not logged in" (no token, or a rejected one). */
const GH_LOGIN =
  /gh auth login|GH_TOKEN|GITHUB_TOKEN|HTTP 401|bad credentials/i;

const MANUAL = `Install by hand: gh release download <tag> -R ${REPO} -p "vast-axi-*.tgz" -D <dir>, then npm i -g <dir>/vast-axi-<version>.tgz`;

export const help = buildHelp({
  usage: "vast-axi update [--check] [--pre]",
  summary:
    "Install the newest vast-axi release from the private GitHub repo (KTD7). The SDK's npm-registry update does not apply to this package.",
  flags: [
    "--check  only report current vs latest and the two install commands; install nothing",
    "--pre    count pre-releases too (v0.1.x are pre-releases until the stable gate)",
  ],
  notes: [
    `needs the gh CLI, logged in (\`gh auth login\`), to read ${REPO}`,
    "downloads the release's vast-axi-*.tgz asset with gh, then runs: npm i -g <dir>/vast-axi-<version>.tgz",
  ],
  examples: [
    "vast-axi update --check",
    "vast-axi update",
    "vast-axi update --pre",
  ],
});

/** What one finished subprocess said. `missing` means the program was not found. */
export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  missing?: boolean;
}

/** Runs `file args` with no prompts and stdin closed. Tests replace it so nothing real runs. */
export type Exec = (
  file: string,
  args: string[],
  opts?: { cwd?: string },
) => Promise<ExecResult>;

/**
 * The program and argv to really spawn for `file args`. npm is npm.cmd on
 * Windows and Node only runs a .cmd through a shell, so go through cmd.exe
 * explicitly with shell: false (`shell: true` trips Node's DEP0190). Every
 * argument is fixed text or checked (TAG, ASSET), so no cmd.exe metacharacter
 * can reach it; the temp dir travels as cwd, never as an arg.
 */
export function launchSpec(
  file: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): { file: string; args: string[] } {
  return platform === "win32" && file === "npm"
    ? { file: "cmd.exe", args: ["/d", "/s", "/c", "npm.cmd", ...args] }
    : { file, args };
}

export const spawnExec: Exec = (file, args, opts = {}) =>
  new Promise((resolve) => {
    const run = launchSpec(file, args);
    const child = spawn(run.file, run.args, {
      shell: false,
      cwd: opts.cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, GH_PROMPT_DISABLED: "1" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.stdin.on("error", () => {});
    child.on("error", (error) => {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      resolve({ exitCode: missing ? 127 : 1, stdout, stderr, missing });
    });
    child.on("close", (code) =>
      resolve({ exitCode: code ?? 1, stdout, stderr }),
    );
    child.stdin.end();
  });

export interface UpdateDeps {
  exec?: Exec;
  /** The running version (tests pin it). */
  version?: string;
  /** Makes the fresh download directory (tests never touch the disk). */
  makeTempDir?: () => Promise<string>;
  /** Removes it again, whether or not the install worked. */
  removeDir?: (dir: string) => Promise<void>;
}

function clip(text: string): string {
  const line = redactSecrets(text.trim().split(/\r?\n/)[0] ?? "");
  return line.length > 200 ? `${line.slice(0, 200)}...` : line;
}

const downloadCommand = (tag: string, dir: string): string =>
  `gh release download ${tag} -R ${REPO} -p "vast-axi-*.tgz" -D ${dir} --clobber`;
const installCommand = (dir: string, asset: string): string =>
  `npm i -g ${dir}/${asset}`;

/** Throws for a gh run that did not work: gh missing, not logged in, or anything else. */
function failGh(run: ExecResult, doing: string, manual: string): never {
  if (run.missing) {
    throw new AxiError("the gh CLI is not installed", "GH_NOT_INSTALLED", [
      "Install GitHub CLI from https://cli.github.com, then run `gh auth login`",
      manual,
    ]);
  }
  if (GH_LOGIN.test(run.stderr)) {
    throw new AxiError(
      "gh is not logged in, so the private repo cannot be read",
      "UPDATE_UNAVAILABLE",
      ["Run `gh auth login`, then rerun `vast-axi update`", manual],
    );
  }
  const why = clip(run.stderr);
  throw new AxiError(
    `gh could not ${doing}${why ? `: ${why}` : ""}`,
    "UPDATE_ERROR",
    ["Run `gh auth status` to check the login", manual],
  );
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function checkTag(tag: unknown, raw: string): string {
  if (typeof tag !== "string" || !TAG.test(tag)) {
    throw new AxiError(
      `unexpected release tag from gh: ${clip(typeof tag === "string" ? tag : raw)}`,
      "UPDATE_ERROR",
      ["Release tags look like v0.2.0", MANUAL],
    );
  }
  return tag;
}

const noReleases = (extra: string[] = []): AxiError =>
  new AxiError(`${REPO} has no releases yet`, "NO_RELEASES", [
    "Nothing to update to; the first release has not been published",
    ...extra,
  ]);

/**
 * The newest release as its tag plus its .tgz asset (undefined when it has none).
 * Plain `gh release view` skips pre-releases, so --pre asks `gh release list`
 * for the newest of everything and then views that tag.
 */
async function latestRelease(
  exec: Exec,
  pre: boolean,
): Promise<{ tag: string; asset: string | undefined }> {
  let wanted: string | undefined;
  if (pre) {
    const list = await exec("gh", [
      "release",
      "list",
      "--repo",
      REPO,
      "--exclude-drafts",
      "--limit",
      "1",
      "--json",
      "tagName",
    ]);
    if (list.missing || list.exitCode !== 0) {
      failGh(list, "list the releases", MANUAL);
    }
    const rows = parseJson(list.stdout);
    if (Array.isArray(rows) && rows.length === 0) throw noReleases();
    wanted = checkTag(
      (rows as { tagName?: unknown }[] | undefined)?.[0]?.tagName,
      list.stdout,
    );
  }
  const view = await exec("gh", [
    "release",
    "view",
    ...(wanted ? [wanted] : []),
    "--repo",
    REPO,
    "--json",
    "tagName,assets",
  ]);
  if (view.missing || view.exitCode !== 0) {
    if (!wanted && /release not found|no releases/i.test(view.stderr)) {
      throw noReleases([
        "If only pre-releases exist, run `vast-axi update --pre`",
      ]);
    }
    failGh(view, "read the latest release", MANUAL);
  }
  const body = parseJson(view.stdout) as
    { tagName?: unknown; assets?: { name?: unknown }[] } | undefined;
  const tag = checkTag(body?.tagName, view.stdout);
  const names = (Array.isArray(body?.assets) ? body.assets : [])
    .map((a) => a?.name)
    .filter((n): n is string => typeof n === "string" && ASSET.test(n))
    .sort();
  return { tag, asset: names[0] };
}

/** Factory so tests can inject gh, npm and the temp dir; real runs use the defaults below. */
export function createUpdateCommand(deps: UpdateDeps = {}): VastCommand {
  const exec = deps.exec ?? spawnExec;
  const current = deps.version ?? VERSION;
  const makeTempDir =
    deps.makeTempDir ?? (() => mkdtemp(join(tmpdir(), "vast-axi-update-")));
  const removeDir =
    deps.removeDir ??
    ((dir: string) => rm(dir, { recursive: true, force: true }));
  return async (args) => {
    assertKnownFlags(args, ["--check", "--pre"], "update");
    const rest = [...args];
    const check = takeBoolFlag(rest, "--check");
    const pre = takeBoolFlag(rest, "--pre");
    if (rest.length > 0) {
      throw new AxiError(
        `unexpected argument${rest.length > 1 ? "s" : ""}: ${rest.join(" ")}`,
        "VALIDATION_ERROR",
        ["usage: vast-axi update [--check] [--pre]"],
      );
    }

    const { tag, asset } = await latestRelease(exec, pre);
    const latest = tag.replace(/^v/, "");
    if (!isUpdateAvailable(current, latest)) {
      return {
        update: { current, latest, available: false },
        help: [`vast-axi ${current} is already the latest release`],
      };
    }
    if (!asset) {
      throw new AxiError(
        `release ${tag} has no vast-axi-*.tgz asset to install`,
        "UPDATE_UNAVAILABLE",
        [
          "Ask the maintainer to attach the packed tarball to that release",
          pre
            ? "Nothing else can be installed from this release"
            : "A newer pre-release may carry one: `vast-axi update --pre`",
        ],
      );
    }
    const download = downloadCommand(tag, "<dir>");
    const install = installCommand("<dir>", asset);
    if (check) {
      return {
        update: { current, latest, available: true, download, install },
        help: [
          "Run `vast-axi update` to do both steps in a fresh temp dir",
          "<dir> is any empty directory; `update` makes one and deletes it afterwards",
        ],
      };
    }

    const dir = await makeTempDir();
    try {
      const got = await exec("gh", [
        "release",
        "download",
        tag,
        "-R",
        REPO,
        "-p",
        "vast-axi-*.tgz",
        "-D",
        dir,
        "--clobber",
      ]);
      if (got.missing || got.exitCode !== 0) {
        failGh(
          got,
          `download ${tag}`,
          `Install by hand: ${download}, then ${install}`,
        );
      }
      // Run inside the download dir with a ./ path: the dir never reaches the Windows shell.
      const run = await exec("npm", ["i", "-g", `./${asset}`], { cwd: dir });
      if (run.missing || run.exitCode !== 0) {
        const why = run.missing
          ? "npm is not installed"
          : clip(run.stderr) || `npm exited with code ${run.exitCode}`;
        throw new AxiError(`installing ${tag} failed: ${why}`, "UPDATE_ERROR", [
          `Run it yourself to see the full output: ${download}, then ${install}`,
        ]);
      }
    } finally {
      await removeDir(dir).catch(() => {});
    }
    return {
      update: { previous: current, installed: latest, status: "installed" },
      help: ["Start a new agent session so it runs the updated vast-axi"],
    };
  };
}

export const command: VastCommand = createUpdateCommand();
