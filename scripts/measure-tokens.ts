// Token budget check (SC1): run a vast-axi command and report the size of its output.
//
//   pnpm tsx scripts/measure-tokens.ts search --limit 10
//
// The command runs in-process against tests/helpers/fake-vastai.cjs (offline,
// recorded fixtures) unless VAST_AXI_BIN is already set, in which case that
// binary is used. The count is a real o200k_base tokenization (js-tiktoken).
import { getEncoding } from "js-tiktoken";
import { fileURLToPath } from "node:url";
import { main } from "../src/cli.js";

export function countTokens(text: string): number {
  return getEncoding("o200k_base").encode(text).length;
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error(
    "usage: measure-tokens.ts <vast-axi args>, e.g. search --limit 10",
  );
  process.exit(2);
}

if (!process.env["VAST_AXI_BIN"]) {
  process.env["VAST_AXI_BIN"] = fileURLToPath(
    new URL("../tests/helpers/fake-vastai.cjs", import.meta.url),
  );
  process.env["VAST_API_KEY"] ??= "measure-tokens-not-real";
}

let output = "";
await main({
  argv: args,
  stdout: {
    write: (chunk) => {
      output += chunk;
      return true;
    },
  },
});

const exitCode = Number(process.exitCode ?? 0);
const lines = output.split("\n").length - (output.endsWith("\n") ? 1 : 0);
console.log(output.trimEnd());
console.log(
  `\n# ${output.length} chars, ${lines} lines, ${countTokens(output)} tokens (o200k_base, exit ${exitCode})`,
);
process.exitCode = exitCode;
