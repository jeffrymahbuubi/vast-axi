import { describe, expect, it } from "vitest";
import { findSecretStrings } from "../src/secret-patterns.js";

// Built at runtime so no credential-shaped literal sits in the repo.
const rep = (c: string, n: number): string => c.repeat(n);

describe("findSecretStrings", () => {
  it.each([
    ["Hugging Face token", `export HF_TOKEN=hf_${rep("a", 34)}`],
    ["OpenAI/Anthropic-style key", `KEY=sk-ant-${rep("b", 40)}`],
    ["GitHub token", `git clone https://ghp_${rep("c", 36)}@github.com/x/y`],
    ["GitLab token", `glpat-${rep("d", 20)}`],
    ["AWS access key id", `AKIA${rep("E", 16)}`],
    ["Slack token", `xoxb-${rep("1", 12)}`],
    ["Google API key", `AIza${rep("f", 35)}`],
    ["private key block", "-----BEGIN OPENSSH PRIVATE KEY-----"], // scan:allow (test fixture)
    [
      "64-hex token (vast.ai API key shape)",
      `vastai set api-key ${rep("ab", 32)}`,
    ],
  ])("finds a %s", (name, line) => {
    const hits = findSecretStrings(`echo start\n${line}\n`);
    expect(hits.map((h) => h.name)).toContain(name);
    expect(hits.find((h) => h.name === name)?.line).toBe(2);
  });

  it("never returns the secret text", () => {
    const secret = `hf_${rep("z", 34)}`;
    expect(JSON.stringify(findSecretStrings(secret))).not.toContain(secret);
  });

  it("ignores sha256 checksums", () => {
    const hex = rep("0f", 32);
    expect(
      findSecretStrings(
        `pip install x==1 --hash=sha256:${hex}\nimage@sha256:${hex}`,
      ),
    ).toEqual([]);
  });

  it("ignores bare 64-hex content hashes without key context", () => {
    const hex = rep("9c", 32);
    expect(
      findSecretStrings(
        `  "typesPublisherContentHash": "${hex}",\nconst digest = "${hex}";`,
      ),
    ).toEqual([]);
  });

  it.each([
    `export VAST_API_KEY=${rep("ab", 32)}`,
    `curl -H "Authorization: Bearer ${rep("ab", 32)}"`,
    `api_key = "${rep("ab", 32)}"`,
  ])("finds a 64-hex value with key context: %s", (line) => {
    expect(findSecretStrings(line).map((h) => h.name)).toContain(
      "64-hex token (vast.ai API key shape)",
    );
  });

  it("passes an ordinary setup script", () => {
    expect(
      findSecretStrings(
        "#!/bin/bash\napt-get update\npip install -r requirements.txt\ncd /workspace && python prep.py --skip-hf\n",
      ),
    ).toEqual([]);
  });
});
