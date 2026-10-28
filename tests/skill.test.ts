import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createSkillMarkdown, MAX_SKILL_MARKDOWN_CHARS } from "../src/skill.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const skillPath = fileURLToPath(
  new URL("../skills/vast-axi/SKILL.md", import.meta.url),
);

describe("skill stub (R19)", () => {
  const markdown = createSkillMarkdown();

  it("stays under the character cap", () => {
    expect(markdown.length).toBeLessThan(MAX_SKILL_MARKDOWN_CHARS);
  });

  it("names the installed binary and points at the live CLI, not npx", () => {
    expect(markdown).toContain("`vast-axi`");
    expect(markdown).toContain("`vast-axi --help`");
    expect(markdown).toContain("`vast-axi <command> --help`");
    expect(markdown).not.toContain("npx");
  });

  it("has frontmatter with the skill name and a trigger description", () => {
    expect(markdown.startsWith('---\nname: vast-axi\ndescription: "')).toBe(
      true,
    );
    const [, front] = markdown.split("---\n");
    expect(front).toContain("user-invocable: false");
  });

  it("carries no command, flag or price guidance of its own", () => {
    expect(markdown).not.toMatch(/--(gpu|limit|max-dph|image)/);
    expect(markdown).not.toMatch(/\$\d/);
  });

  it("the committed skills/vast-axi/SKILL.md equals the generator output", () => {
    expect(readFileSync(skillPath, "utf8").replace(/\r\n/g, "\n")).toBe(
      markdown,
    );
  });

  it("`build-skill --check` finds no drift", () => {
    const out = execFileSync(
      process.execPath,
      ["--import", "tsx", "scripts/build-skill.ts", "--check"],
      { cwd: root, encoding: "utf8" },
    );
    expect(out).toContain("up to date");
  });
});
