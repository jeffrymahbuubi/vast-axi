#!/usr/bin/env node
import { tryFastPath } from "axi-sdk-js/fast-path";
import { VERSION } from "../src/version.js";

// Answer `-v/-V/--version` before the command graph is imported (AXI fast path).
if (!tryFastPath(process.argv.slice(2), { version: VERSION })) {
  const { main } = await import("../src/cli.js");
  await main();
}
