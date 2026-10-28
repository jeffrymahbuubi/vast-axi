// Routes owned by U5 (rent and spend guard). `rent` looks an offer up with
// `search offers ask_contract_id=<id> -n --storage <disk>`; the query token comes first so
// the fake's token-prefix routing sees ["search","offers","ask_contract_id=<id>"] and these
// routes never shadow another unit's plain `search offers` route.
//
// Offer ids (all on-demand, priced for any disk):
//   5001 0.50      5002 1.00 (exactly the default cap)   5003 1.0001 (cap + 0.0001)
//   5004 1.80 (AE2)  5005 0.05 unverified + external (found only with -n)
//   5006 empty result (offer gone)   5007 0.50, create says the offer is gone
//   5008 0.50, create says insufficient credit   5009 lookup returns a different id
//   5010 no price   5011 rentable=false   5012 0.50, create returns no new_contract
//   5013 0.50, create answers a plain "not found"   5014 0.50, create answers a 5xx
const offer = (id, dph, extra = {}) => ({
  id,
  ask_contract_id: id,
  machine_id: 700000 + (id % 1000),
  gpu_name: "RTX 4090",
  num_gpus: 1,
  gpu_ram: 24564,
  dph_total: dph,
  rentable: true,
  rented: false,
  verified: true,
  external: false,
  geolocation: "Ireland, IE",
  ...extra,
});

const rows = (list) => ({ stdout: JSON.stringify(list) });
const lookup = (id, list) => ({
  match: ["search", "offers", `ask_contract_id=${id}`],
  respond: rows(list),
});

// Upstream error objects arrive on stderr with exit 0 (KTD2).
const upstreamError = (status, msg) => ({
  stderr: JSON.stringify({ error: true, status_code: status, msg }) + "\n",
});
const createFails = (id, respond) => ({
  match: ["create", "instance", String(id)],
  respond,
});

module.exports = {
  routes: [
    lookup(5001, [offer(5001, 0.5)]),
    lookup(5002, [offer(5002, 1.0)]),
    lookup(5003, [offer(5003, 1.0001)]),
    lookup(5004, [offer(5004, 1.8)]),
    lookup(5005, [offer(5005, 0.05, { verified: false, external: true })]),
    lookup(5006, []),
    lookup(5007, [offer(5007, 0.5)]),
    lookup(5008, [offer(5008, 0.5)]),
    lookup(5009, [offer(9999, 0.5)]),
    lookup(5010, [offer(5010, null)]),
    lookup(5011, [offer(5011, 0.5, { rentable: false })]),
    lookup(5012, [offer(5012, 0.5)]),
    lookup(5013, [offer(5013, 0.5)]),
    lookup(5014, [offer(5014, 0.5)]),
    {
      match: ["create", "instance"],
      respond: {
        stdout: JSON.stringify({ success: true, new_contract: 7835610 }),
      },
    },
    createFails(
      5007,
      upstreamError(400, "no_such_ask: offer 5007 is no longer available"),
    ),
    createFails(5008, upstreamError(400, "Insufficient credits")),
    createFails(5012, { stdout: JSON.stringify({ success: true }) }),
    createFails(5013, upstreamError(404, "Instance type 5013 not found")),
    createFails(5014, upstreamError(503, "backend unavailable")),
  ],
  scenarios: {},
};
