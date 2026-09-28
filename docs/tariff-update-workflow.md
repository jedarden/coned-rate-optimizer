# Tariff update workflow — the authoritative process for `rates.json` and rate changes

This document is the single authority for how tariff data enters, lives in, and
ships from this repo. Every change to `public/rates.json`, to the baked-in
`RATES` defaults in `public/calc.js`, or to any ConEd rate/eligibility number
the tool displays goes through this workflow. The mechanical half of it is
`scripts/validate-rates.js` (the "gate"), which runs as part of
`scripts/definition-of-done.sh` — and the deploy pipeline runs that script as
its build step, so a change that fails the gate fails the deploy.

Started 2026-09-27 (bead `conedrat-cd9785f1`); decision recorded as
[ADR-003](../docs/plan/plan.md) in `docs/plan/plan.md`.

## 1. What carries the tariff data, and who wins

There are exactly two places tariff data lives, and they must agree:

| File | Role |
|---|---|
| `public/rates.json` | The **runtime tariff data file**. `app.js` fetches it (`cache: "no-store"`) on every page load and merges it over the defaults via `calc.applyRates()` — this is the "update rates with no code change" path. |
| `public/calc.js` → `RATES` | The **baked-in defaults**. Used as-is if the `rates.json` fetch fails (file:// local runs, `verify.js` before it loads the override, a broken deploy). |

Merge semantics (`applyRates`): a **deep merge** — objects merge key-by-key,
arrays and scalars replace wholesale. Derived fields (`RATES._nonDelivery`,
`RATES.tou.nonCommodity`) are recomputed after every merge, so a `standard.*`
override cannot leave them stale. `RATES.meta` fields rates.json omits (e.g.
`version`, `caveats`, `sources`) survive from calc.js.

**The mirror rule:** rule/provenance data (`name`, `short`, `formerly`,
`basis`, `eligibility`, `ratesAsOf`, `source`, `requires`, `lockIn`, `solar`,
`smartChargeConflict`) must be **byte-identical in both files** — the
eligibility engine and the test suite's mirroring tests depend on it. Numeric
tariff values may diverge (that is the override mechanism working), but
divergence is always flagged by the gate so it stays a decision, never an
accident. The paid-conversion policy's identity fields (`pricing.policyVersion`,
`pricing.basis`, `pricing.chargingCertified`, `pricing.refund`) carry the same
exact-match rule — consent records are keyed to the policy version (§3
`pricing`). In practice a tariff release updates **both files in one commit**
(§6).

Engine configuration that is *not* tariff data stays out of rates.json:
`peakStartHour`, `summerMonths`, the demand plans' `peakStart`/`peakEnd`, and
the eligibility engine itself. ConEd's peak *windows* are tariff facts and live
in the plan data (`peakWindow` strings); which hours the engine treats as peak
is code.

## 2. Sources — what is authoritative

Every plan carries a `source` URL (required, `https://`, gate-enforced) naming
the ConEd publication its numbers come from. These are the publications, and
nothing else is a valid source for a number:

| Publication | Feeds | Cadence |
|---|---|---|
| [Historical Average Full Service Electric Rates PDF](https://www.coned.com/-/media/files/coned/documents/save-energy-money/using-private-generation/historical-average-full-service-electric-rates.pdf) (NYC Residential SC 1) | `standard.*` (latest year's average, grossed up for GRT + sales tax) and `bill.periods[]` (the per-year component history). **One publication, two sections — they move together** (gate-enforced). | Annual (published on a lag; 2026 averages arrived mid-2026 for the 2025 year) |
| [Time-of-Use page](https://www.coned.com/en/accounts-billing/your-bill/time-of-use) | `tou.offPeak` / `peakSummer` / `peakWinter` (residential TOU supply), `tou.gross`, `tou.customer`, the TOU lock-in terms | Checked at least quarterly |
| [Steady Use Rate page](https://www.coned.com/en/accounts-billing/steady-use-rate) | `steadyUse.demand.*` ($/kW delivery), `customer`, lock-in terms, solar caution | Checked at least quarterly |
| [Smart Energy Plan page](https://www.coned.com/en/accounts-billing/smart-energy-plan) | `smartEnergy.demand.*`, `customer`, lock-in terms, solar guidance | Checked at least quarterly |
| [EV rewards page](https://www.coned.com/en/save-money/rebates-incentives-tax-credits/rebates-incentives-tax-credits-for-residential-customers/electric-vehicle-rewards) | `smartChargeNY.offPeakCredit`, `offPeakWindow`, eligibility wording | Checked at least quarterly |

**Cadence enforcement:** this table is not advisory — it is the gate's data.
`scripts/validate-rates.js` parses it at run time, matches each plan's
`source` URL to its row, and reads the Cadence cell as an enforcement window:
"checked at least quarterly" = **fail past 95 days**, "Annual" = **fail past
13 months**, each with a heads-up warning at 60 days / 9 months (~⅔ of the
window, mirroring the reviewedThrough warn/fail ratio). The age measured is
the latest `YYYY-MM` / `YYYY-MM-DD` verification date recorded in the plan's
`ratesAsOf` string — which is why the fetching discipline below requires one
there. Reading the cadence from this table (rather than a copy inside the
script) is deliberate, so gate and doc cannot drift. Four consequences:

- A plan `source` with **no row in this table** fails the gate — add the row,
  with its cadence, in the same change as the new source.
- A `ratesAsOf` carrying **no verification date** fails the gate. A bare
  publication year ("2025 published averages") names the publication, not the
  verification, and does not count; where a string records several dates, the
  latest is the one measured.
- A Cadence cell **reworded past recognition** (anything other than
  quarterly/annual) fails the gate rather than being silently ignored — extend
  `CADENCE_RULES` in `scripts/validate-rates.js` in the same change.
- `--allow-stale` downgrades a past-window cadence to a warning, exactly as it
  does for `meta.reviewedThrough` — it means "shipping knowingly stale", never
  "skip the check".

**Fetching discipline:** coned.com Akamai-blocks fetches from this
environment (verified in ADR-002). Verify against **Wayback Machine snapshots**
of the pages, and record the snapshot date in the commit message and in the
plan's `ratesAsOf` string (existing convention: "TOU page archived 2026-06-17,
Steady Use 2026-07-03, Smart Energy 2026-05-20"). A number whose provenance
cannot be named — publication + snapshot date — does not ship.

Units: energy rates are **$/kWh expressed in dollars** (`0.338267`, never
`33.8267`), demand rates are **$/kW**, customer charges are **$/month**. The
gate sanity-checks all three ranges because a cents-as-dollars slip is the
classic failure here.

## 3. Schema — `rates.json` field reference

Top level: `_comment` (what the file is), `meta`, `standard`, `tou`,
`smartChargeNY`, `steadyUse`, `smartEnergy`, `bill`, `accuracy`, `pricing`.
Unknown top-level keys are rejected by the gate (a plan rates.json invents is a plan
the engine silently ignores — worse than a missing one).

### `meta`

| Field | Type | Meaning |
|---|---|---|
| `reviewedThrough` | `YYYY-MM-DD` | **The freshness anchor**: the date through which every rate, term, and quote in the file has been verified against its source. The single field both the UI staleness banner and the deploy gate read. |
| `asOf` | string | Human-readable summary of what the rates are current as of. Mirrors calc.js `meta.asOf`. |
| `switchTiming` | string | The meter-read switch-timing note shown in the UI. Mirrors calc.js. |
| `version` | optional `X.Y.Z` | If present it overrides calc.js `meta.version` at runtime — keep them equal; the gate warns on divergence. |

### Priced plans — common fields (`standard`, `tou`, `steadyUse`, `smartEnergy`)

| Field | Type | Meaning |
|---|---|---|
| `name` / `short` | string | ConEd's exact display name + the UI short label. `formerly` on Steady Use carries its old name ("Select Pricing Plan"). |
| `basis` | `"energy"` \| `"demand"` | How the plan bills: total kWh, or peak kW from interval data. Selects the pricing path in calc.js. |
| `eligibility` | string | Who the plan is open to, in ConEd's terms. |
| `ratesAsOf` | string | Per-plan currency statement ("delivery $/kW rates current as of 2026-07"). Shown verbatim in the plan comparison. Must carry at least one `YYYY-MM`/`YYYY-MM-DD` verification date — the latest one is what the §2 cadence gate measures; a bare publication year does not count. |
| `source` | https URL | The publication above this plan's numbers come from. |
| `requires` | object | Eligibility-engine facts: `serviceClass: "SC1"` always; `meter: "smart"` on both demand plans. |
| `lockIn` | object \| `null` | Published commitment terms: `minStayMonths`, `reenrollBlockMonths`, `escoExempt`, `cancelAnytime`, `note`. `null` only for Standard (the default rate every plan can return to). |
| `solar`, `smartChargeConflict` | string | ConEd's fit guidance / program conflicts, quoted or tightly tracked from ConEd wording — surfaced as advisory notes, never invented. |
| `customer` | $/month | Monthly customer charge. |

Plan-specific rate fields:

| Plan | Fields |
|---|---|
| `standard` (energy) | `allIn`, `commodity`, `delivery` ($/kWh) — `allIn` folds in the cents-scale MAC/RDM/surcharge adjustments on top of delivery + commodity, and is the value the bill-history tie check anchors to |
| `tou` (energy) | `offPeak`, `peakSummer`, `peakWinter` ($/kWh supply), `gross` (gross-up multiplier, 1–1.5) — **no** `allIn`/`commodity`/`delivery`: the non-commodity side derives from `standard` (`nonCommodity = standard.allIn − standard.commodity`), so a standard override automatically re-prices TOU's delivery side |
| `steadyUse`, `smartEnergy` (demand) | `demand.peakSummer`, `demand.peakWinter`, `demand.off` ($/kW delivery), `peakWindow` |

### `smartChargeNY` (what-if incentive, not a priced plan)

`offPeakCredit` ($/kWh, ≤ 1), `offPeakWindow`, `eligibility`, `ratesAsOf`,
`source`. It has no `basis`, no `requires`, no `lockIn`.

### `bill` — the effective-period table

| Field | Meaning |
|---|---|
| `basis`, `source` | The publication the history comes from (same PDF as `standard`). |
| `periods[]` | One entry per published billing year, **strictly increasing by year**: `{ year, delivery, commodity, mac, rdm, surcharges }` ($/kWh; `rdm` may be negative — it was in 2023). |

### `accuracy`

`passPct` (2), `warnPct` (5), `gateFraction` (0.95) — the bill-reconstruction
accuracy policy from `docs/product-strategy.md`. `passPct < warnPct` and
`0 < gateFraction ≤ 1`, gate-enforced.

### `pricing` — the paid-conversion policy (not a tariff)

The charging policy from `docs/product-strategy.md` ("Pricing" + "Accuracy
gate"): what the paid products cost, when they may be offered, and the
certification state that gates charging. It rides in rates.json because it is
data the engine reads (`paidConversion`, `validateConsent`), and it gets the
same two-file mirror discipline as tariff data — with one consequence worth
calling out: **stored consent records are keyed to `policyVersion`**, so a
version that differs between the files silently invalidates consent under one
of them.

| Field | Type | Meaning |
|---|---|---|
| `policyVersion` | integer ≥ 1 | **The charging policy's identity.** Consent records record it; consent given under an older policy is rejected. Exact-mirrored. |
| `report` | `{ name, price }` | The self-service report product ($29). |
| `threshold` | $ | Projected first-year savings must clear it — measured at the **low end** of the uncertainty range — before the report may be offered. |
| `savingsBandPct` / `demandBandPct` | fraction (0, 1) | The uncertainty band applied to the savings range (±5% energy; ±10% for demand-plan targets, whose exact rates are unpublished). |
| `concierge` | `{ min, pctOfVerifiedSavings }` | The concierge product: $99 min, 20% of verified savings. |
| `monitoring` | `{ price, per }` | The monitoring product ($29/yr). |
| `refund` | `{ windowDays }` | The published refund window in days — a consumer term, exact-mirrored like `lockIn`. |
| `maxPaymentAttempts` | positive integer | Payment retry cap. |
| `chargingCertified` | boolean | The accuracy-gate certification (≥20 backtested accounts). `false` is a valid, expected shipping state and means nothing may ever charge (test 20 asserts this deployment ships false). Exact-mirrored. |
| `provider` | string \| `null` | Payment-provider handoff — `null` until charging is armed. |
| `basis` | string | Provenance: the doc section these numbers come from and the conditions on charging. Exact-mirrored. |

Nothing here is a ConEd fact — no `source` URL, no §2 cadence. Its authority
is `docs/product-strategy.md` and this repo's own release process; the gate
still checks its shape (required fields, fraction ranges) and its mirror
discipline, so a half-shipped policy change fails the deploy like a
half-shipped tariff change.

## 4. Effective-period handling

Tariff time is handled at four distinct layers; do not blur them:

1. **Verification horizon** — `meta.reviewedThrough` (a date you verified, not
   a date ConEd published). Every freshness mechanism reads this one field
   (§5).
2. **Per-plan currency** — `ratesAsOf` strings, shown to users verbatim in the
   plan comparison ("delivery $/kW rates current as of 2026-07"). These are
   prose, deliberately: ConEd publishes different components on different
   lags, and a single date would claim more consistency than exists. But the
   prose must embed each string's own verification date(s) (`YYYY-MM` or
   `YYYY-MM-DD`, latest wins): the §2 cadence gate measures it, and prose
   without a date in it is exactly the staleness this workflow exists to make
   visible.
3. **Billing-year periods** — `bill.periods[]`, keyed by calendar year. A
   usage year with no period prices at the **latest prior year** and
   `reconstructBill` flags the result `projected` — this is exactly how "2026
   usage priced at 2025 rates" works today, and the first `meta` caveat says
   so. Gaps are allowed (2023→2025 with 2024 missing is valid, if unfortunate);
   years must increase; the latest period must tie to `standard.*` because
   they are the same publication (gate-enforced).
4. **Seasonality** — *which months are summer* is engine config
   (`summerMonths = [6,7,8,9]` in calc.js, matching ConEd's Jun–Sep TOU
   season); *what each season costs* is data (`peakSummer`/`peakWinter` on TOU
   and both demand plans). A tariff change that moves the season boundary is a
   code change plus a data change, reviewed together.

**Adding a newly published year** (the annual refresh): append the year to
`bill.periods[]` and update `standard.*` from the same PDF, in the same
change — the gate fails one without the other. Bump `meta.reviewedThrough` to
the verification date and refresh the `ratesAsOf` strings of anything else you
re-verified in the same pass.

## 5. Validation & freshness — the gate

`node scripts/validate-rates.js` is the mechanical pre-deploy gate. It is
wired into `scripts/definition-of-done.sh` (after self-test, before the test
suite — a schema-broken rates.json would otherwise fail the suite with
misleading errors), so it runs for every worker, every NEEDLE close
verification, and any human running the definition of done. And the deploy
itself runs that same script: the push-to-deploy trigger (§6) sets
`build-command: sh scripts/definition-of-done.sh`, which the `website-build`
template executes under `set -e` **before** `wrangler pages deploy` — a red
run fails the workflow and nothing is published. **The gate is the thing that
stands between a tariff edit and production**, mechanically, not just by
convention. (Break-glass manual wrangler deploys bypass the pipeline and must
supply the gate themselves — the hard rule in `DEPLOY.md`.)

It is pure (no network, no clock — `now` is injected) and has two modes:
the **gate** (`validate-rates.js`, exits 1 on any error) and the
**self-test** (`--self-test`, mutates a known-good copy and asserts each
seeded defect is caught — it reports its own check count and every check must
pass; the validator testing itself, shipped with itself).

**Errors (block deploy):**

- JSON unparseable; missing `_comment`; unknown top-level key; missing plan.
- `meta.reviewedThrough` missing/malformed, or **≥ 6 months old** (unless
  `--allow-stale`); `meta.asOf`/`switchTiming` missing; calc.js `meta.version`
  not semver / `meta.updated` not `YYYY-MM`.
- **Per-source cadence** (§2 table, parsed at run time): a plan's `ratesAsOf`
  older than its publication's window — quarterly pages past **95 days**, the
  historical-averages PDF past **13 months** — (unless `--allow-stale`); a
  `ratesAsOf` carrying no `YYYY-MM`/`YYYY-MM-DD` verification date; a plan
  `source` with no row in the §2 table; a Cadence cell the gate cannot map to
  a window.
- Plan metadata missing (`name`/`short`/`basis`/`eligibility`/`ratesAsOf`/
  `source`), non-https source, `requires.serviceClass ≠ SC1`.
- Rate fields: missing or non-positive numbers for the plan's basis; values
  outside plausible ranges (all-in 0.05–2 $/kWh, demand 0.5–150 $/kW, credit
  ≤ 1 $/kWh); `tou.gross` outside 1–1.5; TOU seasonal ordering
  `offPeak ≤ peakWinter ≤ peakSummer` and demand ordering
  `peakSummer ≥ peakWinter ≥ off` violated; TOU carrying flat-rate fields it
  must not have.
- Cross-field: `standard.allIn` more than 0.05 $/kWh away from
  `delivery + commodity` (only MAC/RDM/surcharges may sit between); latest
  `bill.periods` year not tying to `standard.allIn`/`commodity` (±0.001);
  `accuracy.passPct ≥ warnPct` or `gateFraction` outside (0, 1].
- `pricing` policy shape (§3): missing section; `policyVersion` not a positive
  integer; a band fraction outside (0, 1); missing `threshold`,
  `refund.windowDays`, `report.price`, `maxPaymentAttempts`, `basis`;
  `chargingCertified` not a boolean.
- **Mirror discipline:** any rule/provenance field (`name`, `requires`,
  `lockIn`, `solar`, `smartChargeConflict`, `ratesAsOf`, …) differing between
  rates.json and the calc.js defaults — and likewise the `pricing` policy's
  identity fields (`policyVersion`, `basis`, `chargingCertified`, `refund`),
  since consent records are keyed to the policy version.

**Warnings (print, do not block):**

- **Freshness:** `reviewedThrough` ≥ 4 months old; a plan's latest `ratesAsOf`
  verification date past 60 days (quarterly sources) / 9 months (annual PDF) —
  the mid-quarter reminder that the §2 sweep is coming due; no `bill.periods`
  entry for the current year (current-year usage is being priced `projected` —
  ConEd publishes on a lag, so this is normal most of the year, but it must be
  seen and the caveat kept, not slept through).
- **Numeric divergence** between rates.json and calc.js defaults — plan
  numerics and `pricing` policy terms alike (the override path working —
  flagged so both sides get mirrored in the same release).
- `meta.version` / wording divergence between the two files.

`--allow-stale` exists for exactly one case: knowingly shipping data the UI
banner will label "may be out of date" (e.g. re-deploying an old release). The
warning it prints says so on the record.

**Runtime detection (last line of defense):** `app.js` `checkStaleness()`
shows a banner past 6 months ("may be out of date; treat as directional"),
`verify.js` warns on rates.json/calc.js drift, and the test suite asserts the
rule mirroring (tests 10 & 13). The gate catches these **before** deploy; the
UI banner is what a user sees if something ships stale anyway.

| Failure mode | Detected by | When |
|---|---|---|
| Missing plan / field / bad units / broken consistency | `validate-rates.js` errors | pre-deploy gate |
| Latest published year not reflected in both `standard.*` and `bill.periods` | gate tie check | pre-deploy gate |
| Stale verification (> 6 months) | gate error; `checkStaleness()` banner | gate, then UI |
| A quarterly page's verification lapses past its §2 cadence (95 days) | gate per-source cadence error | pre-deploy gate |
| Annual PDF unverified past 13 months | gate per-source cadence error | pre-deploy gate |
| `ratesAsOf` with no verification date, or a `source` with no §2 row | gate error | pre-deploy gate |
| Current year priced `projected` | gate warning + meta caveat | gate, then UI |
| rates.json / calc.js divergence (rules) | gate error; tests 10 & 13 | gate + test suite |
| rates.json / calc.js divergence (numbers) | gate warning; `verify.js` drift warning | gate + verify |
| Malformed or half-mirrored `pricing` policy | `validate-rates.js` errors | pre-deploy gate |
| Regressed validator itself | `--self-test` in definition of done | every run |

## 6. Release process

The site deploys **push-to-deploy**: every push to `main` triggers the
`website-build` Argo WorkflowTemplate, which publishes `public/` to Cloudflare
Pages (coned.jedarden.com) — ADR-001. There is no separate "deploy rates"
step; **a tariff release is an ordinary commit to `main` that passes the
gate.** Work directly on `main` (no branches); stage precise paths.

1. **Verify the source.** Pull the authoritative publication (§2) — for coned.com
   pages, via a fresh Wayback snapshot; record its date. If a fetched number
   can't be tied to publication + snapshot date, stop.
2. **Edit `public/rates.json`** — the new values, the touched plans'
   `ratesAsOf` strings, and `meta.reviewedThrough` = today's verification
   date. Adding a published year: §4's annual-refresh step.
3. **Mirror `public/calc.js` `RATES`** with the same values. Rule/provenance
   fields must match byte-for-byte; numeric divergence between the files is
   allowed by the merge design but must not survive a release — a user whose
   `rates.json` fetch fails must see the same numbers as one whose fetch
   succeeds.
4. **Bump the release markers** in calc.js `meta`: `version` (semver; tariff
   data refresh = patch or minor per judgment, engine behavior change = minor),
   `updated` (`YYYY-MM`), and refresh `meta.asOf` if the summary prose is now
   stale. If ConEd's *terms* (not numbers) changed, quote the new wording in
   the `lockIn`/`solar`/`smartChargeConflict` notes in **both** files.
5. **Run the gate and the suite:** `scripts/definition-of-done.sh` —
   self-test, gate, `node test/test.js`, `node verify.js`. Green only, and
   read the warnings: a stale-data or numeric-divergence warning at this point
   means step 2–3 was incomplete. This is a rehearsal, not the enforcement —
   the pipeline re-runs the identical script as the deploy's build step
   (step 7).
6. **Commit both files in one commit** (plus any doc/test updates the change
   requires), message naming the source and snapshot date, e.g.
   `feat(rates): 2026 published SC1 averages (historical-averages PDF archived 2026-07-14)`.
   The owning bead records the change (repo rule: every change is covered by a
   bead; deployment verification lands on that bead before it closes).
7. **Push to `origin`** (Forgejo). Push-to-deploy fires; watch the
   `website-build` workflow on `iad-ci`
   (`kubectl --server=http://traefik-iad-ci:8001 get workflows -n argo-workflows`).
   The workflow's build step is this same `scripts/definition-of-done.sh`
   (`build-command` in the sensor's coned trigger), and the deploy only
   happens if it exits green — a red gate ends the workflow before
   `wrangler pages deploy` runs.
8. **Post-deploy verification:** fetch
   `https://coned.jedarden.com/rates.json` and confirm the new
   `reviewedThrough`/version is what production serves, and that
   `https://coned.jedarden.com` loads with the expected plan comparison.
   Record the verification on the bead.
9. **Rollback** = `git revert` of the release commit + push; Pages redeploys
   the reverted tree. Do not hand-edit production (break-glass `wrangler pages
   deploy` in `DEPLOY.md` is for pipeline outages only and leaves the next
   push to reconcile).

**Quarterly re-verification** is the standing cadence: even with no known
change, re-check every source (§2), confirm `reviewedThrough` is inside the
4-month warning line, refresh the verification dates of every `ratesAsOf`
string you actually re-checked, and ship the (usually no-op) verification
bump. This is what keeps the 6-month gate and the §2 per-source cadence
windows (95 days / 13 months) from ever firing in anger.

**Who performs the sweep:** it is filed as a bead in this repo's bead queue —
the operator creates it at the start of each quarter, and any agent that
notices the gate's 60-day / 9-month warnings may create it too; whichever
worker claims the bead executes steps 1–5 above against fresh Wayback
snapshots. Nothing wall-clock-scheduled runs this, deliberately (§7): the
enforcement is (a) the **cadence gate**, which fails the deploy at 95 days /
13 months whether or not anyone remembered, and (b) the **mid-quarter
warnings**, which surface on every definition-of-done run — every worker,
every NEEDLE close verification, any human running the suite. A lapsed sweep
is therefore loud within a quarter, not discoverable at the next tariff
change.

## 7. What this workflow deliberately does *not* do

- **No scraping.** ConEd blocks it and a silent scrape could publish numbers
  no human has seen. Updates are human/agent-verified against an archived
  publication, every time.
- **No server-side tariff store.** The tool is client-side by design
  (README; the one Green Button Connect server touchpoint is the OAuth code
  exchange, per `docs/notes/gbc-data-boundary.md`); rates.json ships as a
  static file. Versioned effective-date rate
  data in a database is a Phase-2 paid-product need (`docs/product-strategy.md`,
  technical gap #1) — until then this file *is* the versioned store, and git
  history is its audit trail.
- **No silent projection.** Pricing a current year at the latest published
  year is legitimate and disclosed (`projected` flag + caveat), but the gate
  keeps it visible so "temporary" never becomes permanent without a human
  reading the warning.
