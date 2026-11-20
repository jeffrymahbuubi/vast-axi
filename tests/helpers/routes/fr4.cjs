// Routes owned by FR4 (the `timer` command). Instance 7835610 exists and runs, with
// a rental contract that ends far in the future (end_date 2030-01-01T00:00Z).
// The three-token match beats u6's `show instance` route. A test changes it per
// case with FAKE_VASTAI_ROUTES, for example
//   { "show instance 7835610": { stdout: '{"instances": null}' } }   (not found)
// Scheduled jobs and the REST side come from u11.cjs and tests/helpers/fake-rest.ts.
module.exports = {
  routes: [
    {
      match: ["show", "instance", "7835610"],
      respond: {
        stdout: JSON.stringify({
          id: 7835610,
          actual_status: "running",
          intended_status: "running",
          dph_total: 0.5,
          end_date: 1893456000,
        }),
      },
    },
  ],
  scenarios: {},
};
