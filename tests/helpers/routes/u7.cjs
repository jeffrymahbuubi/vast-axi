// Routes owned by U7: `raw` passthrough and `setup key`. Happy paths only; a
// test changes a route per case with FAKE_VASTAI_ROUTES, for example
// { "show volumes": { stdout: "...", exit: 1 } }.
// (`stop instance` comes from core.cjs and prints plain text.)
module.exports = {
  routes: [
    {
      match: ["show", "volumes"],
      respond: {
        stdout: JSON.stringify([
          { id: 11, name: "data", size: 20, disk_name: "vol-a" },
          { id: 12, name: "models", size: 100, disk_name: "vol-b" },
        ]),
      },
    },
    // The real command prints a confirmation without the key; a test overrides
    // this route when it needs a leaky upstream.
    {
      match: ["set", "api-key"],
      respond: { stdout: "Your api key has been saved.\n" },
    },
  ],
  scenarios: {},
};
