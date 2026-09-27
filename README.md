# ConEd Rate Optimizer

A single-page, **100% client-side** tool: upload your Con Edison "Download my data" (Green Button) CSV and see — precisely, for your real usage — whether switching ConEd rate plans would lower your bill. Nothing is uploaded; all computation happens in the browser.

**Live:** [coned.jedarden.com](https://coned.jedarden.com)

The path from this calculator prototype to a chargeable analysis, including
pricing, Green Button Connect, Meta acquisition assumptions, accuracy gates, and
the month-over-month bill experience, is documented in
[`docs/product-strategy.md`](docs/product-strategy.md).

**Privacy note:** The site uses Cloudflare Web Analytics (cookie-less, privacy-safe) to measure visit traffic and user interaction (sample button clicks, successful parses, parse errors). Your usage data is never uploaded or stored — only anonymous pageview counts and interaction events are collected.

## What it does

- Parses ConEd Green Button interval exports entirely in-browser — **CSV/TSV**, **XML (ESPI)**, or the **raw `.zip`** exactly as ConEd delivers it (see [Import formats](#import-formats--green-button-connect)).
- Prices your usage under **every currently-eligible SC1 residential plan**: Standard, Time-of-Use, and the demand-based Steady Use Rate (formerly the "Select Pricing Plan") and Smart Energy Plan.
- Applies **ConEd's published eligibility, enrollment-timing, and lock-in rules** (see [Eligibility & lock-in rules](#eligibility--lock-in-rules)) to your declared situation — service area, current plan, meter, solar, ESCO supply, heat pump — and excludes plans that aren't valid alternatives for you, with the reason shown.
- Shows the verdict (stay / switch + $), a ranked **plan-by-plan comparison** — each plan with its exact ConEd display name, pricing basis (energy vs demand), eligibility, switch terms, and the date its rates were last verified (demand-based plans are flagged as estimates) — plus your peak/off-peak load shape and a monthly bar chart.
- Honest by design: for most (peak-heavy) NYC homes it will say **"stay on Standard."**

## Import formats & Green Button Connect

All parsing happens in the browser (`public/calc.js`); files never leave the device.

| Format | How it works |
|---|---|
| `.zip` (what ConEd emails you) | Detected by magic bytes and unpacked in-page (`unzipCsv`, using `DecompressionStream`) — no need to unzip first. The first `.csv` or `.xml` inside is used. |
| `.csv` / `.tsv` | The classic "Download my data" layout (`DATE`, `START TIME`, `USAGE` columns; delimiter auto-detected). |
| `.xml` (ESPI) | Green Button ESPI Atom feeds, with or without a namespace prefix (`<espi:IntervalReading>` or `<IntervalReading>`); epoch timestamps are converted to America/New_York before pricing. Wh values and `powerOfTenMultiplier` scaling are handled. |

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

**Green Button Connect (account authorization) is not available in this tool.**
Connecting directly to a ConEd account requires ConEd's third-party onboarding and
data security agreement, an OAuth redirect endpoint, and data storage — all of which
conflict with this prototype's 100% client-side, nothing-uploaded design. It is
explicitly scoped as **Phase 2** of the paid product in
[`docs/product-strategy.md`](docs/product-strategy.md) ("Data architecture"), where
the consent and scope requirements are documented. This site never asks for your
Con Edison password and never connects to your account; it only reads a file you
downloaded yourself.

## Structure

```
public/            <- deploy this directory to Cloudflare Pages
  index.html
  styles.css
  calc.js          <- pure calc core (parse + price); also runs under Node
  sample.js        <- built-in anonymized example (monthly aggregates only)
  app.js           <- DOM glue
  rates.json       <- live rate data overrides (optional)
verify.js          <- Node verification script
scripts/
  validate-rates.js         <- tariff data gate (docs/tariff-update-workflow.md)
  definition-of-done.sh     <- gate + test suite + verify: run before every push
test/              <- automated test suite and fixtures
  test.js          <- automated tests for calc.js core
  fixtures/
    sample-greenbutton.csv  <- sample data for testing
    sample-greenbutton.xml  <- same data as ESPI XML (epoch/Wh), for parseESPI tests
```

## Run locally

Any static server, e.g. `python3 -m http.server -d public 8000` → http://localhost:8000

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
