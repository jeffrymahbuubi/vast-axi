// Routes owned by U2: the four calls every unit's happy path needs.
// U3-U6 add their own routes/<unit>.cjs instead of editing this file.
module.exports = {
  routes: [
    { match: ["search", "offers"], respond: { fixture: "offers.json" } },
    { match: ["show", "instances"], respond: { fixture: "instances.json" } },
    { match: ["show", "user"], respond: { fixture: "user.json" } },
    { match: ["stop", "instance"], respond: { fixture: "stop.txt" } },
  ],
  scenarios: {},
};
