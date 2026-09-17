# Fixed-asset extensions (Prompt #13)

## Asset split

`POST /fixed-assets/:id/split { eventDate, parts: [{ name, percent, location?,
serialNumber? }], notes? }` (`fixed-asset.manage`) carves child assets out of
a capitalised asset. Each part takes its percentage of cost, acquisition
cost, accumulated depreciation and salvage value (`Money.allocate`, so
nothing is lost to rounding), keeps the parent's category, method, life,
`depreciatedMonths` and capitalisation journal, and continues depreciating
in the next run. The parent keeps the remainder; when the parts add up to
100% it leaves the register as `DISPOSED` with zero proceeds and no gain /
loss. Every side gets a `SPLIT` asset event (signed cost effect, book value
after). Register only: the children post to the same accounts, so the ledger
does not move and nothing is posted.

## Register rollforward

`GET /fixed-assets/reports/rollforward?from&to&categoryId?`
(`fixed-asset.view`) is the fixed-asset note: per category, opening cost and
accumulated depreciation, additions, depreciation, impairment, revaluation,
disposals and closing, with book values and asset counts. It replays the
asset events per asset in date order so each event yields an exact cost /
accumulated effect (a disposal releases whatever had accumulated by then, a
split moves both sides), then buckets the effects into the window. Without
a category filter, right-of-use assets from the lease register are shown as
their own class (`ROU`) from `lease_events` (commencement = addition,
run depreciation, remeasurement = revaluation, termination = disposal).
Nothing is stored and the ledger is never re-derived; the lease and
fixed-asset integrity reports prove the register against the ledger.
