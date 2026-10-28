// Routes owned by U6: ssh, logs, stop, destroy and copy. Happy paths only; a
// test changes a route per case with FAKE_VASTAI_ROUTES, for example
// { "show instance": { fixture: "u6-instance-stopped.json" } }.
// (`stop instance` and `show instances` come from core.cjs.)
//
// Large logs: set FAKE_U6_LOG_FILE to a file path and `logs` replays that file,
// so a test can generate a 10 MB log in a temp dir instead of committing one.
/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("node:fs");

module.exports = {
  routes: [
    { match: ["show", "instance"], respond: { fixture: "u6-instance-running.json" } },
    { match: ["destroy", "instance"], respond: { fixture: "u6-destroy.json" } },
    { match: ["destroy", "instances"], respond: { fixture: "u6-destroy.json" } },
    { match: ["copy"], respond: { fixture: "u6-copy-remote.txt" } },
    {
      match: ["logs"],
      respond: () => {
        const file = process.env.FAKE_U6_LOG_FILE;
        return file
          ? { stdout: fs.readFileSync(file, "utf8") }
          : { fixture: "u6-logs.txt" };
      },
    },
  ],
  scenarios: {},
};
