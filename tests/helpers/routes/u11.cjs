// Routes owned by U11 (rent --max-hours: server-side destroy timers).
// Defaults: the account has no scheduled jobs, and deleting one succeeds with the
// Python repr upstream prints even under --raw. A test serves jobs with
// FAKE_VASTAI_ROUTES, for example
//   { "show scheduled-jobs": { fixture: "u11-jobs.json" } }
// The REST side (POST schedule_job) is served by tests/helpers/fake-rest.ts.
module.exports = {
  routes: [
    { match: ["show", "scheduled-jobs"], respond: { stdout: "[]" } },
    {
      match: ["delete", "scheduled-job"],
      respond: (ctx) => ({
        stdout: `{'success': True, 'msg': 'Scheduled job ${ctx.tokens[2]} deleted successfully'}\n`,
      }),
    },
  ],
  scenarios: {},
};
