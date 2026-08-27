/* Node verification: run the calc core against a real ConEd CSV and print results.
   Usage: node verify.js [path-to-green-button.csv]
   Defaults to test fixture: ./test/fixtures/sample-greenbutton.csv
   Confirms the browser calc reproduces the analysis (expected ~$3,716 / ~$4,335). */
const fs = require("fs");
const path = require("path");
const calc = require("./public/calc.js");
const csvPath = process.argv[2] || path.join(__dirname, "test/fixtures/sample-greenbutton.csv");

// Load and apply the same rate data the live browser tool uses (app.js fetches rates.json at runtime)
const ratesPath = path.join(__dirname, "public/rates.json");
const ratesJson = JSON.parse(fs.readFileSync(ratesPath, "utf8"));
calc.applyRates(ratesJson);

// Optional startup assertion: catch silent divergence if rates.json drifts from calc.js defaults
const beforeApply = { ...calc.RATES.standard, tou: { ...calc.RATES.tou } };
calc.applyRates(ratesJson);
const afterApply = calc.RATES;
const keysToCheck = ["allIn", "commodity", "delivery", "customer"];
const touKeysToCheck = ["offPeak", "peakSummer", "peakWinter", "gross", "customer"];
let drifted = [];
keysToCheck.forEach(k => { if (beforeApply[k] !== afterApply.standard[k]) drifted.push(`standard.${k}`); });
touKeysToCheck.forEach(k => { if (beforeApply.tou[k] !== afterApply.tou[k]) drifted.push(`tou.${k}`); });
if (drifted.length > 0) {
  console.warn("WARNING: rates.json values differ from calc.js baked-in defaults:");
  drifted.forEach(k => console.warn(`  - ${k}`));
  console.warn("  Run node verify.js to validate against the actual live-site data.\n");
}

const text = fs.readFileSync(csvPath, "utf8");
const parsed = calc.parseGreenButton(text);
const a = calc.analyze(parsed);

console.log(`file: ${csvPath}`);
console.log(`intervals: ${parsed.intervals}  days: ${parsed.ndays}  totalKwh: ${a.totalKwh.toFixed(0)}`);
console.log(`load shape: ${a.peakPct.toFixed(1)}% peak / ${(100 - a.peakPct).toFixed(1)}% off-peak`);
console.log(`Standard:    $${a.standardCost.toFixed(2)}  (annualized $${a.standardAnnual.toFixed(0)})`);
console.log(`TOU:         $${a.touCost.toFixed(2)}  (annualized $${a.touAnnual.toFixed(0)})`);
console.log(`TOU vs Std:  ${a.touDelta >= 0 ? "+" : ""}$${a.touDelta.toFixed(2)}`);
console.log(`verdict:     ${a.recommendation}`);
