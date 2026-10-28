// `rent --onstart <file> / --pip "<pkgs>" / --allow-secrets`: read, validate and
// build the onstart text BEFORE anything is looked up or billed (Phase 3).
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { takeBoolFlag, takeFlag } from "./args.js";
import { AxiError } from "./errors.js";
import { newToken } from "./job.js";
import {
  ONSTART_JOB,
  ONSTART_LIMIT,
  buildOnstartText,
  parsePipSpecs,
} from "./onstart.js";
import { findSecretStrings } from "./secret-patterns.js";

export const ONSTART_FLAGS = ["--onstart", "--pip", "--allow-secrets"];

/** A script this big can never fit the 4048-character limit; do not read it. */
const MAX_SCRIPT_BYTES = 64 * 1024;

export interface OnstartFlags {
  file?: string;
  pip?: string;
  allowSecrets: boolean;
}

export interface OnstartPlan {
  /** The value for `create instance --onstart-cmd`. */
  text: string;
  /** What the job does, for the `onstart:` output line. */
  summary: string;
  /** Names of the secret patterns that were allowed with --allow-secrets. */
  allowedSecrets: string[];
}

export function takeOnstartFlags(rest: string[]): OnstartFlags {
  const file = takeFlag(rest, "--onstart");
  const pip = takeFlag(rest, "--pip");
  return {
    ...(file !== undefined ? { file } : {}),
    ...(pip !== undefined ? { pip } : {}),
    allowSecrets: takeBoolFlag(rest, "--allow-secrets"),
  };
}

function bad(message: string, hints: string[] = []): AxiError {
  return new AxiError(message, "VALIDATION_ERROR", hints);
}

const COPY_RUN_HINT =
  "Copy the script with `vast-axi copy` and start it with `vast-axi run` after the instance is up";

/** Read the script as UTF-8 (CRLF to LF); missing, unreadable or blank is E73. */
function readScript(file: string): string {
  let text: string;
  try {
    if (statSync(file).size > MAX_SCRIPT_BYTES) {
      throw bad(
        `--onstart ${file} is far larger than vast.ai's ${ONSTART_LIMIT}-character onstart limit`,
        [COPY_RUN_HINT],
      );
    }
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (error instanceof AxiError) throw error;
    const why = (error as NodeJS.ErrnoException).code ?? "read error";
    throw bad(`--onstart: cannot read ${file} (${why})`, [
      "Pass the path of an existing script file, for example --onstart setup.sh",
    ]);
  }
  if (text.trim() === "") throw bad(`--onstart: ${file} is empty`);
  return text.replace(/\r\n/g, "\n");
}

/** Secret-shaped strings in the script or pip specs refuse the rent unless allowed (E75, OQ36). */
function checkSecrets(
  script: string | undefined,
  file: string | undefined,
  pip: string | undefined,
  allow: boolean,
): string[] {
  const found: Array<{ name: string; where: string }> = [];
  if (script !== undefined) {
    for (const h of findSecretStrings(script)) {
      found.push({ name: h.name, where: `${file} line ${h.line}` });
    }
  }
  if (pip !== undefined) {
    for (const h of findSecretStrings(pip)) {
      found.push({ name: h.name, where: "--pip" });
    }
  }
  if (found.length === 0) return [];
  if (allow) return [...new Set(found.map((f) => f.name))];
  const list = found.map((f) => `${f.name} (${f.where})`).join("; ");
  throw bad(
    `refusing to rent: the onstart text contains credential-shaped strings: ${list}. vast.ai stores the onstart script on the instance record, where the host and anyone with account read access can see it`,
    [
      "Keep secrets out of the script: set them on the instance after it is up, for example with `vast-axi run` or `vast-axi ssh --exec`",
      "Rerun with --allow-secrets only if you accept that the value is stored on the instance record",
    ],
  );
}

/** Validate everything and build the onstart text; throws (exit 2) before any vastai call. */
export function prepareOnstart(flags: OnstartFlags): OnstartPlan | undefined {
  if (flags.file === undefined && flags.pip === undefined) return undefined;
  const script = flags.file !== undefined ? readScript(flags.file) : undefined;
  const pip = flags.pip !== undefined ? parsePipSpecs(flags.pip) : undefined;
  const allowedSecrets = checkSecrets(
    script,
    flags.file,
    flags.pip,
    flags.allowSecrets,
  );
  const text = buildOnstartText({
    ...(pip !== undefined ? { pip } : {}),
    ...(script !== undefined ? { script } : {}),
    token: newToken(),
  });
  if (text.length > ONSTART_LIMIT) {
    throw bad(
      `the onstart text is ${text.length} characters, over vast.ai's limit of ${ONSTART_LIMIT} (the script is sent inside a launcher that is base64-encoded as a whole)`,
      [COPY_RUN_HINT, "Or shorten the script or the --pip list"],
    );
  }
  const parts = [
    ...(pip !== undefined ? ["pip"] : []),
    ...(flags.file !== undefined ? [basename(flags.file).slice(0, 60)] : []),
  ];
  return {
    text,
    summary: `job ${ONSTART_JOB} (${parts.join(", then ")})`,
    allowedSecrets,
  };
}

/** Extra output fields and help lines for a successful rent. */
export function onstartResult(
  plan: OnstartPlan,
  id: number,
): { fields: Record<string, unknown>; help: string[] } {
  return {
    fields: {
      onstart: plan.summary,
      ...(plan.allowedSecrets.length > 0
        ? { allowed_secrets: plan.allowedSecrets.join(", ") }
        : {}),
    },
    help: [
      `\`vast-axi status ${id} --wait\` waits for it; \`vast-axi job ${id} --name ${ONSTART_JOB}\` shows its log`,
    ],
  };
}
