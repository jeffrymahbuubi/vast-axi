// Routes owned by U4 (dashboard and status).
// `show instances` serves tests/fixtures/<U4_FIXTURE> when that env var is set,
// otherwise the shared instances.json, so other units' tests are unaffected.
// Per-test overrides (inline JSON, sequences for --wait) go through FAKE_VASTAI_ROUTES.
module.exports = {
  routes: [
    {
      match: ["show", "instances"],
      respond: (ctx) => ({ fixture: ctx.env.U4_FIXTURE || "instances.json" }),
    },
  ],
  scenarios: {},
};
