# Test Suite

This directory contains automated tests and fixtures for the ConEd Rate Optimizer calc.js core.

## Files

- `test/test.js` — Automated test suite for calc.js core functionality
- `test/fixtures/sample-greenbutton.csv` — Sample Green Button CSV data for testing
- `test/fixtures/sample-greenbutton.xml` — The same data as a Green Button ESPI Atom feed (epoch seconds in America/New_York, Wh values), for XML tests

## Running Tests

### Run automated test suite
```bash
node test/test.js
```

### Run verification script with test fixture
```bash
node verify.js
# Or explicitly:
node verify.js test/fixtures/sample-greenbutton.csv
```

### Run verification with your own data
```bash
node verify.js /path/to/your/green-button-export.csv
```

## Test Coverage

The automated test suite covers:

1. **CSV Parsing** — Green Button CSV format parsing
2. **Data Analysis** — Usage analysis and rate calculations
3. **Rate Calculations** — Standard vs TOU rate accuracy
4. **Edge Cases** — Error handling for malformed/empty input
5. **Rate Override** — applyRates() functionality
6. **XML/ESPI Parsing** — the XML fixture must produce month totals/peak/off identical to the CSV fixture; `parse()` router dispatch; namespace-prefix tolerance (`<espi:…>` vs unprefixed)
7. **XML Errors** — non-ESPI XML and empty XML rejected with guidance
8. **ZIP Import** — stored and deflated archives rebuilt in-memory (no binary fixture needed); XML inside a `.zip` parses end-to-end
9. **ZIP Errors** — non-zip input and truncated archives rejected gracefully
10. **Plan Inventory & Metadata** — all four SC1 residential plans exist with exact ConEd display names (Steady Use carrying its former name "Select Pricing Plan"), pricing basis, eligibility, rates-as-of dates, and ConEd source links; `rates.json` mirrors the metadata and merges it through `applyRates()`
11. **Plan-by-Plan Comparison** — `analyze().comparison` ranks every priced plan cheapest-first with annualized cost, delta vs Standard, current/estimate flags, and metadata; months-only input (no interval data) correctly shrinks the comparison to the two energy plans
12. **Eligibility & Lock-in Engine** — `checkEligibility()` applies ConEd's published rules to a declared profile: smart-meter/interval-data gates on the demand plans, current-plan exclusion from switch candidates, solar fit guidance, ESCO supply caveat and TOU-commitment exemption, heat-pump price guarantee, the one-year TOU commitment and 18-month rejoin block, the 18-month demand-plan re-enrollment block, and SC1/NYC-Westchester territory gates (blockers flag the whole analysis as reference-only)
13. **Rule Data Mirroring** — `rates.json` carries the same `requires`/`lockIn`/solar rules as the `calc.js` defaults, so the runtime override path can update rules with no code change

## Fixture Data

The `sample-greenbutton.csv` fixture contains 3 days of hourly interval data (72 readings) representing:
- Summer usage (June) with peak-heavy load shape
- Winter usage (December) with higher heating loads
- Total ~48 kWh across the test period

`sample-greenbutton.xml` carries the identical 72 readings as an ESPI feed — epoch
timestamps in America/New_York (EDT for June, EST for December) and Wh values — so the
CSV and XML parsers can be cross-checked against each other.

This fixture provides a minimal but realistic dataset that exercises all core calculation paths while keeping the test suite fast.

## Expected Results

Using the test fixture:
- **Standard rate**: ~$48.86 (annualized ~$5,945)
- **TOU rate**: ~$63.00 (annualized ~$7,665)
- **Verdict**: "Stay on Standard" (peak-heavy usage makes TOU more expensive)

Your real data will vary — the tool is designed to give honest recommendations even when switching plans would cost more.
