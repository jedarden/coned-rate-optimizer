# ConEd Rate Optimizer

A single-page, **100% client-side** tool: upload your Con Edison "Download my data" (Green Button) CSV and see — precisely, for your real usage — whether switching ConEd rate plans would lower your bill. Nothing is uploaded; all computation happens in the browser.

Intended demo home: **coned.jedarden.com** (Cloudflare Pages).

## What it does

- Parses ConEd 15-minute interval Green Button CSV/TSV entirely in-browser.
- Prices your usage under **Standard (SC1)** vs **Residential Time-of-Use**, month by month.
- Shows the verdict (stay / switch + $), a per-plan table, your peak/off-peak load shape, and a monthly bar chart.
- Honest by design: for most (peak-heavy) NYC homes it will say **"stay on Standard."**

## Structure

```
public/            <- deploy this directory to Cloudflare Pages
  index.html
  styles.css
  calc.js          <- pure calc core (parse + price); also runs under Node
  sample.js        <- built-in anonymized example (monthly aggregates only)
  app.js           <- DOM glue
verify.js          <- Node check: `node verify.js path/to/greenbutton.csv`
```

## Run locally

Any static server, e.g. `python3 -m http.server -d public 8000` → http://localhost:8000

## Verify the math

```
node verify.js ~/scratch/coned/electricty.csv
# Standard ≈ $3,716/yr · TOU ≈ $4,335/yr · switching COSTS ~$619
```

## Rate model & caveats

Standard components are ConEd's **published 2025 SC1 NYC average**, grossed up for GRT + sales tax, excluding the fixed customer charge; TOU supply rates are ConEd's **current published residential TOU supply**. Absolute totals are ±~5% (the monthly Market Supply Charge varies; 2026 months are priced at 2025 rates). Assumes delivery/MAC/RDM/surcharges are identical under both plans and folds super-peak into peak. **Estimate only; not affiliated with Con Edison.** Update the constants in `public/calc.js` (`RATES`) when ConEd rates change.
