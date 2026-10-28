// Routes owned by U3 (search). The fake does not filter, so a function route
// picks the response from the `--gpu` marker in the generated query (the third
// leading token of `search offers <query> -o dph_total`). Any other query gets
// the ten-offer fixture, exactly as core.cjs would serve it.
const MARKERS = [
  // No offer matches: upstream prints an empty array (E4).
  ["gpu_name=NO_SUCH_GPU", { stdout: "[]" }],
  // Non-ASCII geolocations, deliberately unsorted (E27).
  ["gpu_name=UNICODE_GPU", { fixture: "u3-offers-unicode.json" }],
  // 41 offers, more than any small --limit (E30).
  ["gpu_name=LONG_LIST", { fixture: "offers50.json" }],
];

module.exports = {
  routes: [
    {
      match: ["search", "offers"],
      respond: (ctx) => {
        const query = ctx.tokens[2] || "";
        const hit = MARKERS.find(([marker]) => query.includes(marker));
        return hit ? hit[1] : { fixture: "offers.json" };
      },
    },
  ],
  scenarios: {},
};
