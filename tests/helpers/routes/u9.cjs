// Routes owned by U9 (budget safety: --hours estimates, on-demand visibility).
// `show user` serves tests/fixtures/u9-user-<U9_USER>.json when U9_USER is set
// (low = balance 3.00, zero = balance 0, nobalance = no balance field),
// otherwise the shared user.json (balance 12.3456), so other units are unaffected.
// Status tests reach tests/fixtures/u9-instances.json (is_bid false / true / absent for
// ids 9101 / 9102 / 9103) through the existing U4_FIXTURE switch.
module.exports = {
  routes: [
    {
      match: ["show", "user"],
      respond: (ctx) => ({
        fixture: ctx.env.U9_USER
          ? `u9-user-${ctx.env.U9_USER}.json`
          : "user.json",
      }),
    },
  ],
  scenarios: {},
};
