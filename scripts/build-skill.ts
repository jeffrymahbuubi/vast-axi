// Regenerate skills/vast-axi/SKILL.md from src/skill.ts.
//
//   pnpm build:skill           write the file
//   pnpm build:skill --check   exit 1 when the committed file differs
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createSkillMarkdown } from "../src/skill.js";

const target = fileURLToPath(
  new URL("../skills/vast-axi/SKILL.md", import.meta.url),
);
const markdown = createSkillMarkdown();

if (process.argv.includes("--check")) {
  const current = existsSync(target) ? readFileSync(target, "utf8") : "";
  if (current !== markdown) {
    console.error("skills/vast-axi/SKILL.md is stale; run `pnpm build:skill`");
    process.exit(1);
  }
  console.log("skills/vast-axi/SKILL.md is up to date");
} else {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, markdown, "utf8");
  console.log(`wrote skills/vast-axi/SKILL.md (${markdown.length} chars)`);
}
