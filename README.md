# ConEd Rate Optimizer

A single-page tool: upload your Con Edison "Download my data" (Green Button) CSV — or connect your account with **Green Button Connect (Share My Data)** — and see, for your real usage, whether switching ConEd rate plans would lower your bill. The tool says which kind of number you're looking at: when your billing history is available, your actual bills are replayed through the model first, and the verdict is labeled **Verified** only if they reconcile within the accuracy gate — otherwise it's labeled an **estimate**, with the reasons named. **Every calculation runs in your browser, and your usage data is never stored anywhere.** The file path has no server touch at all; the connect path has exactly one — the one-time OAuth code→token exchange at `/api/gbc/token` ([`functions/api/gbc/token.js`](functions/api/gbc/token.js)) — and it handles only the one-time authorization code and the access token: interval and billing data flow from ConEd directly into your tab and never touch the application server. The full data-handling boundary — who sees, keeps, and logs what — is [`docs/notes/gbc-data-boundary.md`](docs/notes/gbc-data-boundary.md).

**Live:** [coned.jedarden.com](https://coned.jedarden.com)

The path from this calculator prototype to a chargeable analysis, including
pricing, Green Button Connect, Meta acquisition assumptions, accuracy gates, and
the month-over-month bill experience, is documented in
[`docs/product-strategy.md`](docs/product-strategy.md).

**Privacy note:** Your interval and billing data are parsed, analyzed, and charted entirely in your browser — never uploaded to or stored on this site's server, on either the file path or the Green Button Connect path (where the feeds flow from ConEd straight into your tab). The connect path's only server step is the one-time OAuth code→token exchange at `/api/gbc/token`, and `test/gbc-sandbox.js` enforces that boundary mechanically: it records every request its sandbox receives and fails the run if an exchange body is anything but `{ code, redirectUri }`, if the access token ever appears in a request body, or if any interval/billing payload bytes ever arrive inside one. Separately, the site uses Cloudflare Web Analytics (cookie-less, privacy-safe) to measure visit traffic and user interaction (sample button clicks, successful parses, parse errors) — only anonymous pageview counts and interaction events are collected. Full boundary: [`docs/notes/gbc-data-boundary.md`](docs/notes/gbc-data-boundary.md).

## What it does

- Parses ConEd Green Button interval exports entirely in-browser — **CSV/TSV**, **XML (ESPI)**, or the **raw `.zip`** exactly as ConEd delivers it (see [Import formats](#import-formats--green-button-connect)) — and can **pull the same data straight from a connected ConEd account** via Green Button Connect (Share My Data), still analyzed entirely in-browser.
- Prices your usage under **every currently-eligible SC1 residential plan**: Standard, Time-of-Use, and the demand-based Steady Use Rate (formerly the "Select Pricing Plan") and Smart Energy Plan.
- Applies **ConEd's published eligibility, enrollment-timing, and lock-in rules** (see [Eligibility & lock-in rules](#eligibility--lock-in-rules)) to your declared situation — service area, current plan, meter, solar, ESCO supply, heat pump — and excludes plans that aren't valid alternatives for you, with the reason shown.
- Shows the verdict (stay / switch + $), a ranked **plan-by-plan comparison** — each plan with its exact ConEd display name, pricing basis (energy vs demand), eligibility, switch terms, and the date its rates were last verified (demand-based plans are flagged as estimates) — plus your peak/off-peak load shape and a monthly bar chart.
- Answers the month-over-month questions in a **period-by-period table**: what each period actually cost (reconstructed component-by-component from ConEd's published bill history when you're on Standard, modeled on the plan's own rates otherwise), what the best eligible plan would have charged, the difference, and an exact month-over-month decomposition of every change into **calendar (billed-day) / usage / rate** effects — with the published component behind a rate change named, partial export months and projected-rate periods tagged, and calendar-month buckets labeled as such rather than presented as ConEd bill periods.
- **Checks itself against your real bills** when a billing history is available (the Green Button Connect billing feed): each bill is replayed through the published-rate model and compared with what you actually paid, the verdict carries a **confidence label** — Verified / Estimate / model-disagrees — *above* the savings number, and every downgrade (no bills, missing months, bill-chain gaps, monthly-only data, Westchester pricing) names itself. See [Verified vs. estimated](#verified-vs-estimated--the-accuracy-gate).
- Honest by design: for most (peak-heavy) NYC homes it will say **"stay on Standard."**

## Import formats & Green Button Connect

All parsing happens in the browser (`public/calc.js`); files never leave the device.

| Format | How it works |
|---|---|
| `.zip` (what ConEd emails you) | Detected by magic bytes and unpacked in-page (`unzipCsv`, using `DecompressionStream`) — no need to unzip first. The first `.csv` or `.xml` inside is used. |
| `.csv` / `.tsv` | The classic "Download my data" layout (`DATE`, `START TIME`, `USAGE` columns; delimiter auto-detected). |
| `.xml` (ESPI) | Green Button ESPI Atom feeds, with or without a namespace prefix (`<espi:IntervalReading>` or `<IntervalReading>`); epoch timestamps are converted to America/New_York before pricing. Wh values and `powerOfTenMultiplier` scaling are handled. |
| Connected ConEd account (Green Button Connect / Share My Data) | One-time OAuth authorization at coned.com, then interval **and billing** ESPI feeds are pulled from ConEd's API **directly into your browser** with your access token and parsed by the same in-browser `parseESPI()` — the analysis path is byte-for-byte the file path. Ships **disabled** (`configured: false`) until Con Edison's third-party onboarding issues real credentials; enabling is a `public/gbc-config.json` + env-binding change. The exact data-handling boundary — what the browser, the token-exchange function, ConEd, and the operators each see, process, retain, and log — is documented in [`docs/notes/gbc-data-boundary.md`](docs/notes/gbc-data-boundary.md). Verified end-to-end against a sandbox Third-Party App (`test/gbc-sandbox.js`, `tools/verify-gbc-browser.js`). |

Malformed input fails with a specific, human-readable error (wrong export type, no
interval data, corrupt/unsupported zip, XML with no readings) — never a raw stack trace.

## Eligibility & lock-in rules

A switch only counts if ConEd will actually let you make it. The eligibility engine
(`checkEligibility()` in `public/calc.js`) gates every plan on the facts you declare in
"Your situation" (all optional — defaults describe an SC1 · NYC · smart-meter home on
Standard) and marks plans that aren't valid alternatives, with the reason:

| Check | Rule applied | ConEd's published terms |
|---|---|---|
| Location | ConEd electric territory only; Westchester results are flagged directional | Rates are priced on ConEd's published **NYC SC1 averages**; Westchester delivery rates differ |
| Account | SC1 residential only | The tool models ConEd's SC1 (Rate I) residential plans; anything else is reference-only |
| Meter | Both demand plans require a smart meter + hourly interval data | *"Any Con Edison customer with a smart meter can enroll in the Steady Use Rate"*; *"Anyone with a smart meter installed in their home can participate in the Smart Energy Plan"* |
| Current plan | Your declared plan is the baseline, never a switch candidate | — |
| Fit | Solar / net-metering homes get ConEd's demand-plan caution (advisory, not an exclusion); ESCO homes get a supply-side caveat; EV what-if flags that Steady Use enrollment auto-unenrolls you from SmartCharge NY | *"If you have solar or net metering, you are likely not a good fit for the Steady Use Rate"*; *"We do not recommend this plan for solar customers"* (Smart Energy); ESCO customers are billed supply at their ESCO contract price |
| Enrollment timing | Switches take effect with a future meter read; TOU peak prices are seasonal | ConEd bills TOU summer (Jun–Sep) peak supply at a higher rate than the rest of the year |
| Lock-in | TOU: one-year commitment, 18-month rejoin block; demand plans: cancel anytime, 18-month re-enrollment block; heat-pump homes see the Steady Use 12-month price guarantee | *"After you switch to the Time-of-Use Rate, you must stay enrolled for one year unless you get your energy from an energy service company. If you switch back to the Standard Residential Rate, you cannot rejoin the Time-of-Use Rate for 18 months."*; *"You can cancel anytime without penalty but won't be able to reenroll for 18 months after opting out."* (both demand plans); *"If you have a heat pump and are new to the plan, you're eligible for the 12-month price guarantee"* |

ConEd quotes were verified against the coned.com plan pages (TOU page archived
2026-06-17, Steady Use 2026-07-03, Smart Energy 2026-05-20). The rules are data on each
plan (`requires`, `lockIn`, `solar`, `smartChargeConflict`), mirrored in `rates.json` so
they can be updated with no code change when ConEd's terms change. Excluded plans stay
visible in the comparison with their reason — they're just never recommended.

**Green Button Connect (account authorization) is implemented — enabled once ConEd's third-party onboarding completes.** The flow (`public/gbc.js` + the `/api/gbc/token` Pages Function) does the full Share My Data authorization: link-out to ConEd's OAuth screen, CSRF-guarded callback, code→token exchange, then direct browser retrieval of interval and billing ESPI feeds, analyzed by the same in-browser engine as the file path. It resolves the tension with the nothing-uploaded promise the narrow way: **all computation stays in the browser**; the one server step (the token exchange, which needs the client secret) retains and logs nothing; the access token lives only in your tab's session storage and dies with it; your ConEd password is never asked for. The full boundary — what each component sees, processes, retains, and logs — is in [`docs/notes/gbc-data-boundary.md`](docs/notes/gbc-data-boundary.md). The connect panel stays hidden until ConEd's [third-party registration](https://www.coned.com/en/accounts-billing/share-energy-usage-data/become-a-third-party) (data security agreement, client credentials, real endpoint URLs) is done; persistent server-side monitoring remains **Phase 2** of the paid product in [`docs/product-strategy.md`](docs/product-strategy.md) and is deliberately not built here, because it would require storing customer data. Until onboarding lands, this site still never connects to your account; it only reads a file you downloaded yourself.

## Verified vs. estimated — the accuracy gate

The strategy document ([`docs/product-strategy.md`](docs/product-strategy.md)) is explicit that this prototype "is not yet a chargeable rate audit": the published-rate model runs on approximations — an annual average supply rate instead of each month's Market Supply Charge, 2026 usage priced at 2025 rates, demand plans estimated on held-flat supply. So the tool never shows an unverified total as exact. It **replays your actual bills through the model** and lets the outcome decide what the verdict is allowed to claim:

- **With a billing history** (the Green Button Connect billing feed), every bill whose dates your interval data covers is reconstructed component-by-component at ConEd's published rates for that bill's year and compared with what you actually paid. A bill within **±2%** passes, within ±5% warns, beyond that fails — each in its own row of the "Your actual bills vs the model" table.
- **The account-level gate** is the strategy doc's own: at least **95% of complete, supported billing periods** must reconcile within 2% before the verdict says **Verified**. Bills your interval data doesn't cover are excluded from the gate rather than priced on invented usage, and every miss is listed with its label and worst component — never averaged away.
- **Without a billing history** the verdict is labeled an **estimate**, stated directly above the savings number. Missing usage months, gaps in the bill chain, billing summaries with no total, monthly-only data (no load shape), a short export window, and Westchester pricing each downgrade the label with a named reason — never silently.
- **What Verified does *not* mean:** it means the published-rate *reconstruction* reproduces your bills. The plan *counterfactuals* still inherit the caveats in [Rate model & caveats](#rate-model--caveats) — alternatives are priced at current published rates, not replayed through your billing history.

**The paid-product bar is not met, and the claims here are scoped to that.** The strategy doc authorizes charging only after ≥20 diverse real accounts have been backtested at this same gate; until that happens, this tool is a labeled estimate, not an audit, and nothing on the site calls a projection a guaranteed saving. The thresholds are data, not constants (`RATES.accuracy` in `public/calc.js`, mirrored in `rates.json`, enforced by the tariff gate `scripts/validate-rates.js`), and the whole path — billing-feed parse → bill replay → gate → confidence label → UI — is covered by the test suite (Tests 14, 15, and 19). Why these specific numbers, and where the residual the 2% band absorbs comes from, is the rationale in [`docs/notes/bill-reconstruction-tolerance.md`](docs/notes/bill-reconstruction-tolerance.md).

## Structure

```
public/            <- deploy this directory to Cloudflare Pages
  index.html
  styles.css
  calc.js          <- pure calc core (parse + price); also runs under Node
  sample.js        <- built-in anonymized example (monthly aggregates only)
  gbc.js           <- Green Button Connect client core (auth + feed walk); also runs under Node
  gbc-config.json  <- GBC public config (ships configured:false until ConEd onboarding)
  app.js           <- DOM glue
  rates.json       <- live rate data overrides (optional)
  feedback.js      <- Agentation feedback toolbar (loads only with ?feedback=1)
functions/
  api/gbc/token.js <- Pages Function: OAuth code→token exchange; retains nothing, logs nothing
                      (contract spec: docs/notes/gbc-token-api.md)
docs/
  notes/gbc-data-boundary.md <- the GBC data-handling boundary (who sees/keeps what)
verify.js          <- Node verification script
scripts/
  validate-rates.js         <- tariff data gate (docs/tariff-update-workflow.md)
  definition-of-done.sh     <- gate + test suite + sandbox + verify: run before every push
tools/
  verify-agentation-mount.js <- browser check: toolbar mounts on ?feedback=1,
                                nothing extra loads without it (needs playwright)
  verify-gbc-browser.js      <- browser E2E: real Chromium through the full GBC
                                authorization + import flow (needs playwright)
test/              <- automated test suite and fixtures
  test.js          <- automated tests for calc.js core (+ GBC core, Test 17)
  gbc-sandbox.js   <- sandbox Third-Party App authorization: mock OAuth server +
                     ESPI Data Custodian driving the real gbc.js + Pages Function
  fixtures/
    sample-greenbutton.csv  <- sample data for testing
    sample-greenbutton.xml  <- same data as ESPI XML (epoch/Wh), for parseESPI tests
    bill-history-sc1-nyc.json <- ConEd's published 3-year SC1 NYC bill history (reconstruction ground truth)
```

## Run locally

Any static server, e.g. `python3 -m http.server -d public 8000` → http://localhost:8000

## Feedback toolbar

The Agentation visual-feedback toolbar (click elements / select text to copy
structured feedback markdown) is wired on the page but **lazy-loaded only
when `?feedback=1` is in the URL** — the footer's "feedback toolbar" link, or
any link with that param. Normal visitors fetch nothing extra: no React, no
third-party CDN request, no toolbar — so the nothing-uploaded privacy promise
is unchanged for them. Agentation itself makes no network calls; it renders
locally and copies feedback text to your clipboard. The mount is verified by
`#agentation-root` existing after load (never by grepping for the script
tag):

```bash
python3 -m http.server -d public 8000 &
NODE_PATH=/home/coding/spaxel/dashboard/node_modules \
  node tools/verify-agentation-mount.js            # local
node tools/verify-agentation-mount.js https://coned.jedarden.com   # production
```

## Test the calc.js core

### Run automated test suite
```bash
node test/test.js
# Runs all tests and exits with status code
```

### Verify the math with test fixture
```bash
node verify.js
# Uses test/fixtures/sample-greenbutton.csv by default
```

### Verify with your own data
```bash
node verify.js ~/path/to/your/green-button-export.csv
# .xml (ESPI) and .zip exports work too — same formats as the browser drop zone
```

## Rate model & caveats

Standard components are ConEd's **published 2025 SC1 NYC average**, grossed up for GRT + sales tax, excluding the fixed customer charge; TOU supply rates are ConEd's **current published residential TOU supply**. Absolute totals are ±~5% (the monthly Market Supply Charge varies; 2026 months are priced at 2025 rates). Assumes delivery/MAC/RDM/surcharges are identical under both plans and folds super-peak into peak. **Estimate only; not affiliated with Con Edison.** When ConEd rates change, follow the authoritative update workflow in [`docs/tariff-update-workflow.md`](docs/tariff-update-workflow.md): update `rates.json` and the `RATES` defaults in `public/calc.js` together from a named ConEd publication, and let `scripts/definition-of-done.sh` (which runs the tariff data gate, `scripts/validate-rates.js`) stand between the edit and production — it fails the build on missing/inconsistent plan data, unit slips, effective-period gaps, or a stale `reviewedThrough` verification date.
