import { DESCRIPTION } from "./help.js";

// Trigger string agents match against to auto-load the skill: terse, and
// phrased around the intents that need a GPU rental.
export const SKILL_DESCRIPTION =
  "Rent and manage GPU instances on vast.ai through the vast-axi CLI - find offers, rent, check status and spend, ssh, logs, run and finish long jobs, stop, destroy and copy files, plus raw access to any other vastai command. " +
  "Use whenever a task needs a rented GPU: searching vast.ai offers, renting or tearing down an instance, checking balance or burn rate, running a long training job unattended, reading instance logs, or moving files to or from an instance.";

export const SKILL_AUTHOR = "jeffrymahbuubi";

export const HERMES_TAGS = ["vast-ai", "gpu", "cloud", "instances", "cost"];
export const HERMES_CATEGORY = "devops";

// Hard cap so a future regeneration cannot silently re-inflate the stub with
// CLI-owned instructions. Dashboard, `--help` and per-command help are the
// source of truth.
export const MAX_SKILL_MARKDOWN_CHARS = 2500;

function yamlDoubleQuote(value: string): string {
  return JSON.stringify(value);
}

/**
 * Render the installable SKILL.md for the vast-axi skill.
 *
 * This is a discovery stub, not a copy of CLI guidance. Installed skills go
 * stale; `vast-axi` (dashboard), `vast-axi --help` and `vast-axi <command> --help`
 * do not. Keep the body to what vast-axi is, when to reach for it, and pointers
 * at those commands. The tool is installed globally (OQ2a), so it is called by
 * name, not through npx.
 *
 * @returns full SKILL.md contents including YAML frontmatter, LF line endings
 */
export function createSkillMarkdown(): string {
  const markdown = `---
name: vast-axi
description: ${yamlDoubleQuote(SKILL_DESCRIPTION)}
user-invocable: false
author: ${SKILL_AUTHOR}
metadata:
  hermes:
    tags: [${HERMES_TAGS.join(", ")}]
    category: ${HERMES_CATEGORY}
---

# vast-axi

${DESCRIPTION}

Use vast-axi whenever a task needs a rented GPU: finding offers, renting, instance status and spend, ssh, logs, stop, destroy, file copy, or any other vastai command through \`raw\`.

## Current guidance lives in the CLI

Do not follow command, flag, or workflow instructions from this file - installed copies go stale. Get the current source of truth from the installed CLI:

- \`vast-axi\` for a dashboard of balance, running instances and burn rate
- \`vast-axi --help\` for global flags and the command index
- \`vast-axi <command> --help\` for per-command usage

## Agent notes

- gpu_util is delayed by minutes; before stopping or destroying anything, confirm with \`vast-axi status <id> --live\` (nvidia-smi over ssh).
- Long jobs: \`run\` starts them detached, \`job\` reports state, \`finish --wait\` fetches results. \`finish --wait\` can outlast a tool timeout, so run it in the background.
`;
  if (markdown.length > MAX_SKILL_MARKDOWN_CHARS) {
    throw new Error(
      `generated SKILL.md is ${markdown.length} chars; keep it a stub under ${MAX_SKILL_MARKDOWN_CHARS} and defer guidance to the CLI`,
    );
  }
  return markdown;
}
