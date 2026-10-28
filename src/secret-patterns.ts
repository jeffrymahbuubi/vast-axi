// Credential-shaped strings in text bound for an instance (Phase 3, OQ36).
// vast.ai stores a rent's onstart script on the instance record, where the
// host and `show instance` can read it, so a key inside it leaks.
// Shared by `rent --onstart` and the `copy` upload guard.

export interface SecretPattern {
  /** Short name shown to the user; never the matched text itself. */
  name: string;
  re: RegExp;
}

export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { name: "private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "Hugging Face token", re: /\bhf_[A-Za-z0-9]{30,}\b/ },
  { name: "OpenAI/Anthropic-style key", re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  {
    name: "GitHub token",
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/,
  },
  { name: "GitLab token", re: /\bglpat-[A-Za-z0-9_-]{20,}/ },
  { name: "AWS access key id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  // A vast.ai API key is 64 hex characters, but so is every sha256 content
  // hash (package.json files, lockfiles, digests). Only a 64-hex value with
  // key-like words shortly before it on the same line counts.
  {
    name: "64-hex token (vast.ai API key shape)",
    re: /(?:vast|api[_-]?key|token|secret|bearer|authorization|password)[^\n]{0,40}?(?<!sha256[:=])\b[0-9a-f]{64}\b/i,
  },
];

export interface SecretHit {
  /** Pattern name; the secret itself is never returned. */
  name: string;
  /** 1-based line number of the first match. */
  line: number;
}

/** Every pattern that matches `text`, once each, with the first line it is on. */
export function findSecretStrings(text: string): SecretHit[] {
  const lines = text.split(/\r?\n/);
  const hits: SecretHit[] = [];
  for (const p of SECRET_PATTERNS) {
    const idx = lines.findIndex((l) => p.re.test(l));
    if (idx >= 0) hits.push({ name: p.name, line: idx + 1 });
  }
  return hits;
}
