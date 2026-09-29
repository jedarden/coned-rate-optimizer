# Test Suite

This directory contains automated tests and fixtures for the ConEd Rate Optimizer calc.js core.

## Files

- `test/test.js` — Automated test suite for calc.js core functionality (and the Green Button Connect client core, Test 17, the month-over-month dashboard & decomposition, Test 18, the persistent monthly monitoring series — merge/revision/rolling retention, bill pruning, the plan timeline, the stitched dashboard, realized switch savings, schema compatibility, fingerprints, demo exclusion, the storage contract, the raw-data privacy boundary, and the no-network localStorage check — Test 21, plus local recommendation rechecks for changed/unchanged usage and rates — Test 22)
- `test/monitoring-retention.js` — Focused monitoring contract tests: imports, month merging and revisions, 36-month and bill retention, plan timelines, schema/version handling, recheck fingerprints, immediate deletion and clean re-analysis, sample/raw-data exclusion, and the no-network localStorage guarantee
- `test/checkout.js` — End-to-end hosted-checkout contract tests: the browser-to-Pages-Function-to-provider path, exact $29 request boundary, server-side session verification, success-query fail-closed behavior, cancellation, provider failure, bounded retries, and disabled certification flags
- `test/backtest-harness.js` — End-to-end tests for the consented, diverse 20-account audit harness: passing gate, every-miss reporting, incomplete corpus, and refusal paths
- `test/certification-workflow.js` — Durable certification artifact schema, miss documentation, provider evidence, reviewer approval, flag enablement, and free-result preservation contracts
- `test/gbc-sandbox.js` — Sandbox Third-Party App authorization: a local mock OAuth 2.0 authorization server + ESPI Data Custodian driving the real `public/gbc.js` and the real Pages Function (`functions/api/gbc/token.js`) through the full Green Button Connect flow — and, in section 8, the `/api/gbc/token` contract (`docs/notes/gbc-token-api.md`): valid exchanges (body shape, `no-store` headers, the exact upstream request per client-auth style), every error case (missing/bad code or body, cross-origin 403 with no upstream call, unconfigured 503, unreachable/malformed upstream 502s, upstream OAuth errors passed through verbatim), and the no-logging/no-persistence guarantees (console captured across invocations must stay silent; an instrumented env proves only `GBC_*` bindings are read and no storage binding is ever touched) — and, in section 9, the data-boundary enforcement (`docs/notes/gbc-data-boundary.md`): every request is recorded and the run fails if any usage payload or access token ever arrives inside a request body
- `test/analytics-privacy.js` — The analytics privacy contract (`docs/notes/analytics-privacy.md`): the Cloudflare Web Analytics allowlist (`sample_click`, `parse_success`, `parse_error`) is exact and each event ships as a bare static name — a forbidden-class contamination battery (filename, raw file content, an interval row, billing figures, an account id, a GBC token, the parse-error message) proves none of it can ride along even when a caller attaches it; composed or unknown names fail closed; a static scan keeps the Cloudflare sender reachable only through `public/analytics.js`; every call site passes a single static allowlisted literal; the page's beacon config carries nothing but the site token; README, the privacy notes, and the page copy are regression-checked to distinguish the no-application-server file boundary from the intentional Cloudflare analytics request
- `test/gbc-production-smoke.js` — Deterministic tests for the production smoke checker: public config and registered redirect validation, same-origin rejection, missing Pages bindings, upstream `invalid_client`, the expected synthetic-code `invalid_grant` health result, the authorization callback, direct interval/billing feed retrieval, exact token-endpoint request shape, no usage/billing/token bytes in exchange requests, and unreachable-upstream handling. The live command is `scripts/smoke-gbc-production.js`; it never sends a credential or prints a response body.
- `tools/verify-file-import-privacy.js` — Browser regression for the real CSV, XML/ESPI, and deflated ZIP file-import paths: records application-origin and analytics requests, permits only required static requests plus bare documented event names, and covers successful and failed parses.
- `tools/verify-agentation-mount.js` — Browser deploy check: asserts the `#agentation-root` and rendered toolbar mount after `?feedback=1`, and that normal visits fetch no Agentation payload; the local-server form runs in `scripts/definition-of-done.sh`.
- `test/fixtures/sample-greenbutton.csv` — Sample Green Button CSV data for testing
- `test/fixtures/sample-greenbutton.xml` — The same data as a Green Button ESPI Atom feed (epoch seconds in America/New_York, Wh values), for XML tests — also served by the GBC sandbox as the connected interval feed, so the connected path is checked byte-for-byte against the file path
- `test/fixtures/bill-history-sc1-nyc.json` — ConEd's published NYC SC1 bill history (2023–2025, 300 kWh sample month), the ground truth the bill-reconstruction tests reproduce
- `test/fixtures/bill-reconstruction-tests.json` — generated release-bound reconstruction cases; regenerate with node scripts/regenerate-reconstruction-tests.js after tariff or source-fixture changes
- `test/fixtures/eligibility-lock-in-matrix.json` — fixture-driven policy cases for territory, current plan, meter/data, solar, ESCO supply, heat pumps, enrollment timing, and lock-in terms

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

### Run the Green Button Connect sandbox authorization
```bash
node test/gbc-sandbox.js
# Mock OAuth 2.0 authorize/token + ESPI Data Custodian on 127.0.0.1 (ephemeral
# port); the real Pages Function handles /api/gbc/token. Exits 0 on success.
```

### Run the Green Button Connect browser end-to-end (needs Playwright + Chromium)
```bash
NODE_PATH=<dir containing playwright> CHROME_PATH=<chromium binary> node tools/verify-gbc-browser.js
# A real Chromium drives the shipped page against the sandbox: the connected
# happy path, the refused callback shapes (no/tampered state, OAuth error,
# bogus code), the sessionStorage token lifetime (restore while fresh,
# expired and inside-margin drops), and the whole-run boundary accounting
# (only {code, redirectUri} ever reaches the app server; feeds are fetched
# browser-direct). Not part of definition-of-done.sh — it needs a browser.
```

### Run the file-import privacy browser regression (needs Playwright + Chromium)
```bash
NODE_PATH=<dir containing playwright> CHROME_PATH=<chromium binary> node tools/verify-file-import-privacy.js
# Drives CSV, XML/ESPI, deflated ZIP, malformed CSV/XML, and corrupt ZIP imports
# in Chromium. The application-origin server records every request; the
# Cloudflare beacon is locally recorded as name-only analytics.
```

### Run the Agentation deploy check (needs Playwright + Chromium)
```bash
node tools/verify-agentation-mount.js --local
# The --local form serves public itself and is included in
# scripts/definition-of-done.sh. Pass a deployed URL to check production.
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
12. **Eligibility & Lock-in Engine** — `checkEligibility()` applies ConEd's published rules to a declared profile: smart-meter/interval-data gates on the demand plans, current-plan exclusion from switch candidates, solar fit guidance, ESCO supply caveat and TOU-commitment exemption, heat-pump price guarantee, the one-year TOU commitment and 18-month rejoin block, the 18-month demand-plan re-enrollment block, recent plan-history enforcement with explicit exclusion reasons, and SC1/NYC-Westchester territory gates (blockers flag the whole analysis as reference-only); `eligibility-lock-in-matrix.json` exercises eligible, ineligible, and lock-in scenarios and verifies documented exclusion reasons plus priced alternatives
13. **Rule Data Mirroring** — `rates.json` carries the same `requires`/`lockIn`/solar rules as the `calc.js` defaults, so the runtime override path can update rules with no code change
14. **Bill Reconstruction** — `reconstructBill()` prices a billing period component by component (customer charge, delivery, supply, MAC, RDM, surcharges) and reproduces ConEd's real published bill history to under half a cent at each year's rates; integrity guards re-derive the fixture's published totals; projection rules price uncovered years at the nearest published period and flag them; partial periods, actual-supply overrides, the default customer charge, and bad-input rejection are all covered
15. **Reconciliation & Accuracy Gate** — `reconcileBill()` compares a modeled period against the actual bill (pass ≤2%, warn ≤5%, fail beyond), names the component driving each miss, and `accuracyGate()` enforces the product-strategy rule that an account is only trusted when ≥95% of its supported periods reconcile within 2% — every miss listed, never averaged away; a $0 actual bill and missing totals are handled without divide-by-zero. Why these bands (±$2/±2% on the published basis): [`docs/notes/bill-reconstruction-tolerance.md`](../docs/notes/bill-reconstruction-tolerance.md)
16. **Demand-Plan Pricing** — `costDemand()` prices the Steady Use and Smart Energy schedules on hand-built interval data: the average of the three highest hourly demands per month at each plan's seasonal $/kW rates (summer vs winter), supply + surcharges held at the standard flat non-delivery rate, the customer charge per month, and the weekdays-noon–8pm peak window's edges (noon inclusive, 8pm exclusive, weekends never peak); an end-to-end flat-load analysis confirms the demand plans can win the ranking and that the verdict itself names Steady Use
17. **Green Button Connect core** — the `public/gbc.js` client: public-config validation (missing file degrades to unconfigured; `configured:true` demands client id, authorize URL, API base, and scopes), the OAuth authorization-request shape (`response_type=code`, client id, registered redirect URI, state, joined scopes), callback validation (code+state accept, CSRF state-mismatch rejection, OAuth `error` mapping to friendly copy), the sessionStorage connection store (round-trip, the 30s expiry safety margin, clear), and the ESPI feed-walk helpers (entry-id extraction with namespace-prefix tolerance and feed-level ids excluded, resource-id from URI, path-template expansion with missing-id refusal) — the full authorization *flow* against a mock ConEd runs in `gbc-sandbox.js`
18. **Month-over-month dashboard & change decomposition** — `analyze().dashboard` builds the per-period actual-vs-best table: actual = what the current plan charged (reconstructed from the published bill history when you're on Standard, modeled on the plan's own rates otherwise), best = the cheapest eligible plan that period via `pricePeriod()`'s single-period slices of the same cost models (slices are tested to sum exactly to the whole-window Standard/TOU/demand costs); `decomposeChange()` splits every month-over-month change exactly — no residual, proven by hand cases and a property sweep including zero-usage sides, prorated customer charges, and missing day counts — into calendar (billed-day span), usage (day-weighted daily-usage change at the prior rate), rate (Δ effective ¢/kWh × the later period's usage), and fixed effects; `rateDriver()` names the published component behind a schedule change (2024→2025 names the largest mover, 2025→2026 is correctly null — one schedule) and 2026 periods carry the projected-rates flag; month buckets expose observed day counts so truncated export months flag as partial while months-only input falls back to calendar days without claiming observations
19. **Analytics privacy contract** — the Cloudflare Web Analytics events (sample button click, parse success, parse error) are provably name-only: the allowlist in `public/analytics.js` is exact, each send is one call with one argument, extra arguments are discarded across a forbidden-class contamination battery (filename, raw fixture content, an interval row, billing figures, an account id, a GBC token, the on-screen error message), composed or unknown event names fail closed, a static scan keeps the Cloudflare sender reachable only through the choke point, every `.track()` call site passes a single static allowlisted literal (so code and `docs/notes/analytics-privacy.md` can't drift apart), and the beacon in `index.html` is configured with nothing but the site token

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
- **Steady Use / Smart Energy**: priced from the fixture's interval data as flagged demand estimates (annualized ~$14,829 / ~$16,640) — well above Standard on this peak-heavy sample, consistent with the verdict
- **Verdict**: "Stay on Standard" (peak-heavy usage makes TOU more expensive)

Your real data will vary — the tool is designed to give honest recommendations even when switching plans would cost more.
