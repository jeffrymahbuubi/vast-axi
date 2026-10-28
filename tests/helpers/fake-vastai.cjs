#!/usr/bin/env node
"use strict";
// Replay stand-in for the `vastai` CLI (KTD3). Point VAST_AXI_BIN at this file;
// the runner then spawns it under node. It never touches the network.
//
// How a call is answered, first match wins:
//   1. `--version`               prints FAKE_VASTAI_VERSION (default 1.8.3), logged as "--version"
//   2. FAKE_VASTAI_SCENARIO      a global behaviour for every call (see SCENARIOS,
//                                plus any `scenarios` exported by a route file)
//   3. FAKE_VASTAI_ROUTES        per-test JSON: { "<command prefix>": <response> }
//   4. tests/helpers/routes/*.cjs  the routing table, one file per unit
//   5. otherwise                 an argparse-style "invalid choice" error, exit 2
//
// A <response> is { fixture?, stream?, stdout?, stderr?, exit?, hang?, delayMs? }
// or { sequence: [<response>, ...] } (the nth call of the same route gets the nth
// entry, the last one repeats; needs FAKE_VASTAI_LOG). A route file may also give a
// function (ctx) => <response>. `fixture` is a file under tests/fixtures; it goes to
// stdout unless stream is "stderr".
//
// FAKE_VASTAI_LOG=<file> appends one JSON line per call ({ argv, tokens, route }),
// so a test can assert which commands ran (or that none did).
//
// Route file format (tests/helpers/routes/<unit>.cjs, no require() allowed):
//   module.exports = {
//     routes: [{ match: ["search", "offers"], respond: { fixture: "offers.json" } }],
//     scenarios: { empty: { stdout: "[]" } },
//   };
// `match` is a prefix of the leading non-flag tokens; the longest prefix wins and,
// on a tie, the later file wins. Files load in alphabetical order.

const fs = require("node:fs");
const path = require("node:path");

const FIXTURES = path.resolve(__dirname, "..", "fixtures");
const ROUTES_DIR = path.join(__dirname, "routes");

const SCENARIOS = {
  auth401: { fixture: "error-401.json", stream: "stderr" },
  auth403: { fixture: "error-403.json", stream: "stderr" },
  rate429: { fixture: "error-429.json", stream: "stderr" },
  garbage: { stdout: '[{"id": 1, "gpu_name": "RTX 40' },
  empty: { stdout: "" },
  crash: { stderr: "Traceback: something broke\n", exit: 1 },
  hang: { hang: true },
};

const raw = process.argv.slice(2);

// Strip the global flags the runner prepends (`--raw`, `--retry <n>`).
const argv = [];
for (let i = 0; i < raw.length; i++) {
  if (raw[i] === "--raw") continue;
  if (raw[i] === "--retry") {
    i++;
    continue;
  }
  argv.push(raw[i]);
}
const tokens = [];
for (const a of argv) {
  if (a.startsWith("-")) break;
  tokens.push(a);
}

function readLog() {
  const file = process.env.FAKE_VASTAI_LOG;
  if (!file || !fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function appendLog(route) {
  const file = process.env.FAKE_VASTAI_LOG;
  if (file) fs.appendFileSync(file, JSON.stringify({ argv: raw, tokens, route }) + "\n");
}

function loadRouteFiles() {
  if (!fs.existsSync(ROUTES_DIR)) return [];
  return fs
    .readdirSync(ROUTES_DIR)
    .filter((f) => f.endsWith(".cjs"))
    .sort()
    .map((f) => require(path.join(ROUTES_DIR, f)));
}

function isPrefix(match, list) {
  return match.length <= list.length && match.every((m, i) => m === list[i]);
}

function pickRoute(files, overrides) {
  let best;
  const consider = (match, respond, rank) => {
    if (!isPrefix(match, tokens)) return;
    const score = [rank, match.length];
    if (!best || score[0] > best.score[0] || (score[0] === best.score[0] && score[1] >= best.score[1])) {
      best = { key: match.join(" "), respond, score };
    }
  };
  for (const file of files) {
    for (const route of file.routes || []) consider(route.match, route.respond, 0);
  }
  for (const [key, respond] of Object.entries(overrides)) {
    consider(key.split(/\s+/).filter(Boolean), respond, 1);
  }
  return best;
}

function resolveResponse(respond, key) {
  if (typeof respond === "function") {
    const ctx = { argv, tokens, raw, env: process.env, fixtures: FIXTURES };
    return resolveResponse(respond(ctx), key);
  }
  if (respond && Array.isArray(respond.sequence)) {
    const calls = readLog().filter((entry) => entry.route === key).length;
    return respond.sequence[Math.min(calls, respond.sequence.length - 1)];
  }
  return respond;
}

function emit(spec) {
  if (spec.hang) {
    // Outlive any timeout; the runner kills this process.
    setInterval(() => {}, 1000);
    return;
  }
  let stdout = spec.stdout || "";
  let stderr = spec.stderr || "";
  if (spec.fixture) {
    const text = fs.readFileSync(path.join(FIXTURES, spec.fixture), "utf8");
    if (spec.stream === "stderr") stderr += text;
    else stdout += text;
  }
  const finish = () => {
    process.stdout.write(stdout);
    process.stderr.write(stderr);
    process.exitCode = spec.exit || 0;
  };
  if (spec.delayMs) setTimeout(finish, spec.delayMs);
  else finish();
}

function main() {
  if (raw.includes("--version")) {
    appendLog("--version");
    process.stdout.write((process.env.FAKE_VASTAI_VERSION || "1.8.3") + "\n");
    return;
  }

  const files = loadRouteFiles();
  const scenarios = Object.assign({}, SCENARIOS, ...files.map((f) => f.scenarios || {}));
  const overrides = process.env.FAKE_VASTAI_ROUTES ? JSON.parse(process.env.FAKE_VASTAI_ROUTES) : {};
  const route = pickRoute(files, overrides);

  const scenarioName = process.env.FAKE_VASTAI_SCENARIO;
  if (scenarioName === "stdin") {
    // Scenario "stdin": proves the runner closed stdin: this only finishes if stdin reaches EOF.
    let size = 0;
    process.stdin.on("data", (chunk) => (size += chunk.length));
    process.stdin.on("end", () => {
      appendLog(route ? route.key : null);
      process.stdout.write(JSON.stringify({ stdin_bytes: size }));
    });
    return;
  }
  const scenario = scenarioName ? scenarios[scenarioName] : undefined;
  if (scenarioName && !scenario) {
    process.stderr.write("fake-vastai: unknown scenario " + scenarioName + "\n");
    process.exitCode = 3;
    return;
  }

  const key = route ? route.key : null;
  const spec = scenario || (route ? resolveResponse(route.respond, key) : undefined);
  appendLog(key);
  if (!spec) {
    process.stderr.write(
      "usage: vastai [-h] ...\nvastai: error: argument command: invalid choice: '" + tokens.join(" ") + "'\n",
    );
    process.exitCode = 2;
    return;
  }
  emit(spec);
}

main();
