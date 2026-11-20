// Joins the words after `--` into the one string the remote shell parses.
import { shellQuote } from "./job.js";

const PLAIN = /^[A-Za-z0-9_@%+=:,./~*?$[\]{}-]+$/;

/** One word is returned as is; with 2+ words each is quoted unless it is plain (I3). */
export function joinRemoteArgv(words: string[]): string {
  if (words.length === 1) return words[0]!;
  return words
    .map((w) => (w === "" ? "''" : PLAIN.test(w) ? w : shellQuote(w)))
    .join(" ");
}
