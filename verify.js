/* Node verification: run the calc core against a real ConEd CSV and print results.
   Usage: node verify.js [path-to-green-button.csv]
   Confirms the browser calc reproduces the analysis (expected ~$3,716 / ~$4,335). */
const fs = require("fs");
const calc = require("./public/calc.js");
const path = process.argv[2] || process.env.HOME + "/scratch/coned/electricty.csv";

const text = fs.readFileSync(path, "utf8");
const parsed = calc.parseGreenButton(text);
const a = calc.analyze(parsed);

console.log(`file: ${path}`);
console.log(`intervals: ${parsed.intervals}  days: ${parsed.ndays}  totalKwh: ${a.totalKwh.toFixed(0)}`);
console.log(`load shape: ${a.peakPct.toFixed(1)}% peak / ${(100 - a.peakPct).toFixed(1)}% off-peak`);
console.log(`Standard:    $${a.standardCost.toFixed(2)}  (annualized $${a.standardAnnual.toFixed(0)})`);
console.log(`TOU:         $${a.touCost.toFixed(2)}  (annualized $${a.touAnnual.toFixed(0)})`);
console.log(`TOU vs Std:  ${a.touDelta >= 0 ? "+" : ""}$${a.touDelta.toFixed(2)}`);
console.log(`verdict:     ${a.recommendation}`);
