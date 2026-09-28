# Bill-reconstruction tolerance — rationale

How closely the model must reproduce an actual Con Edison bill before its
counterfactuals can be trusted, where the numbers live, and why these specific
numbers. This is the implementation of the accuracy gate in
[`docs/product-strategy.md`](../product-strategy.md):

> Do not charge until at least 20 diverse real accounts have been backtested and
> the modeled bill is within 2% of the actual bill for at least 95% of complete,
> supported billing periods. Investigate every miss rather than averaging it
> away.

## The stated tolerance

| Band | Meaning | Where it lives |
|---|---|---|
| within **2%** (`passPct`) | the period reconciles — the model may be trusted on it | `RATES.accuracy` in `public/calc.js`, mirrored in `public/rates.json` |
| 2%–**5%** (`warnPct`) | flagged for investigation, never trusted | same |
| beyond 5% | unacceptable — the account is not understood | same |
| **95%** (`gateFraction`) | share of an account's complete, supported billing periods that must land in the 2% band | same |

An account backtests through the billing feed → `parseBillingESPI()` (or
`normalizeBills()` for already-parsed records) → `reconcileBills()`, which
replays each interval-supported bill through `reconstructBill()` at that bill's
year's published rates and reconciles it via `reconcileBill()`;
`accuracyGate()` then applies the 95%-within-2% verdict, listing every miss.
"Complete, supported" is `reconcileBills`' coverage rule — a bill is priced
only when the interval data covers ≥80% of its days (`BILL_COVERAGE`);
everything else is excluded from the gate rather than priced on invented usage.

On the published SC1 basis the fixture reproduces
(`test/fixtures/bill-history-sc1-nyc.json`: $88.56–$101.48 at 300 kWh/month),
2% is $1.77–$2.03, so the per-month shorthand for the gate — **±$2 or ±2%** —
and the percentage formulation coincide. Test 15 asserts the reconstruction
lands under half a cent on each published period, far inside either.

## Why 2%

**Tight enough to be diagnostic.** Delivery is ~52–54% of the published bill. A
tariff-table error of 4% in the delivery rate — the kind of mistake a stale
`rates.json` or a wrong effective period produces — lands at ~2.2% of the bill
total and blows the gate. A looser band would wave through exactly the errors
the gate exists to catch; product-strategy.md's kill criterion ("if the full
tariff model cannot meet the accuracy gate without manual consultant
judgment") depends on the band being sharp.

**Loose enough for the residual the model cannot see.** The reconstruction
reproduces ConEd's published bill history to under half a cent per period
(Test 15), so the entire real-world budget goes to modeling gaps, not
arithmetic. Those gaps, quantified:

1. **Monthly supply volatility (dominant).** The model prices supply at the
   published *annual average* commodity rate because that is what ConEd
   publishes. Real bills reprice supply monthly. The published annual
   averages themselves swing 12.99–13.75 ¢/kWh across 2023–2025 (±~3%); supply
   is ~39–45% of the bill, so one month billed at an off-average Market Supply
   Charge can move the total by a full percent on its own. This is the miss
   source the gate is designed to absorb, and `reconcileBill`'s
   `supplyPerKwh` override exists to take it out of the residual when the bill
   shows the actual MSC.
2. **Customer-charge proration.** A read pair of 30 vs 31 days moves the
   prorated $16.33 charge by ~$0.54 (0.5% of a $100 bill). `reconcileBills`
   prorates by the bill's day count over the 30.4375-day mean month rather
   than hardcoding 1.0; the residual against a flat 1.0 is at most ~$0.30
   either way.
3. **Cent rounding of the published data.** Published component rates are
   rounded to 0.0001 ¢/kWh and bills to the cent; the fixture's own
   `publicationNotes` record the ~0.0001 ¢/kWh column-sum artifact. At
   300 kWh that is ≤ $0.001 on a period — three orders of magnitude inside
   the band.
4. **Tax gross-up.** The published bills are grossed up for GRT and sales tax
   uniformly; a uniform multiplier cancels in a relative (percent) error, so
   it costs nothing here. (A *missing* or non-uniform tax line on a real bill
   would not cancel — that is a miss to investigate, correctly.)

Adding 1–4: a normal period sits well inside 1%; 2% leaves headroom without
letting a structural error through.

## Why 95%, and why per-period

Averaging error across periods would hide a systematically wrong delivery rate
under a run of good supply months — the gate is per-period for the same reason
product-strategy.md says "investigate every miss rather than averaging it
away". The 95% fraction then absorbs *isolated* oddities the model cannot see
from the outside: a mid-period rate change, an estimated read later trued up,
a one-off correction or credit line.

Arithmetic consequence worth knowing: 0.95 × 12 = 11.4, so a 12-period
(one-year) history must land **every** period within 2% to pass; the fraction
only earns headroom as history lengthens (23/24 passes, 19/20 passes exactly
at the edge). The tests pin this edge (Test 15: 19/20 passes, 18/20 fails).
Product-strategy.md accordingly backtests ≥ 20 accounts before charging —
multi-year histories are the normal case there.

## Changing the numbers

The thresholds are data, not code: `RATES.accuracy` in `public/calc.js`,
mirrored into `public/rates.json` (Test 14 asserts the mirror; the runtime
override path can update either with no code change), with per-call overrides
via `accuracyThresholds()`. Both enforcers demand coherence —
`passPct < warnPct` (an override that inverts the bands throws; Test 15 pins
it) and `gateFraction` in (0, 1] (`scripts/validate-rates.js`, whose self-test
mutates the fraction past 1 to prove the gate fires). Loosening a threshold to
make a failing account pass is the one thing they must never be changed for —
a miss is a finding, not a tuning input.

## Fixtures and verification

- `test/fixtures/bill-history-sc1-nyc.json` — ConEd's published NYC SC1 bill
  history (2023–2025, 300 kWh sample month), transcribed from ConEd's
  published PDF via a web.archive.org snapshot. The suite integrity-checks the
  transcription before trusting it as ground truth: components must sum to the
  published totals, bill lines must equal 300 kWh × rate, and the year columns
  must average to the published 36-month columns.
- `node test/test.js` Test 14 (reconstruction vs the published history + the
  rates.json accuracy mirror), Test 15 (reconciliation bands, driver
  components, the 95% gate and its 19/20 vs 18/20 edge), and Test 19
  (billing-feed import → bill replay → gate → confidence label) carry all of
  the above. `scripts/definition-of-done.sh` runs the suite (plus
  `validate-rates`, the GBC sandbox, and `verify.js`) on every deploy build.
