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
- Prices your usage under **Standard (SC1)** vs **Residential Time-of-Use**, month by month.
- Shows the verdict (stay / switch + $), a per-plan table, your peak/off-peak load shape, and a monthly bar chart.
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

Standard components are ConEd's **published 2025 SC1 NYC average**, grossed up for GRT + sales tax, excluding the fixed customer charge; TOU supply rates are ConEd's **current published residential TOU supply**. Absolute totals are ±~5% (the monthly Market Supply Charge varies; 2026 months are priced at 2025 rates). Assumes delivery/MAC/RDM/surcharges are identical under both plans and folds super-peak into peak. **Estimate only; not affiliated with Con Edison.** Update the constants in `public/calc.js` (`RATES`) when ConEd rates change.
