/* Node verification: run the calc core against a real ConEd export and print results.
   Usage: node verify.js [path-to-green-button-export]
   Accepts the same formats as the browser tool: .csv/.tsv, .xml (ESPI), or the raw .zip.
   Defaults to test fixture: ./test/fixtures/sample-greenbutton.csv
   Confirms the browser calc reproduces the analysis (expected ~$5,945 / ~$7,665 annualized). */
const fs = require("fs");
const path = require("path");
const calc = require("./public/calc.js");
const dataPath = process.argv[2] || path.join(__dirname, "test/fixtures/sample-greenbutton.csv");

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

function analyzeText(text) {
  const parsed = calc.parse(text);   // same auto-detect as the browser: CSV vs XML/ESPI
  const a = calc.analyze(parsed);

  console.log(`file: ${dataPath}`);
  console.log(`intervals: ${parsed.intervals}  days: ${parsed.ndays}  totalKwh: ${a.totalKwh.toFixed(0)}`);
  console.log(`load shape: ${a.peakPct.toFixed(1)}% peak / ${(100 - a.peakPct).toFixed(1)}% off-peak`);
  console.log(`Standard:    $${a.standardCost.toFixed(2)}  (annualized $${a.standardAnnual.toFixed(0)})`);
  console.log(`TOU:         $${a.touCost.toFixed(2)}  (annualized $${a.touAnnual.toFixed(0)})`);
  console.log(`TOU vs Std:  ${a.touDelta >= 0 ? "+" : ""}$${a.touDelta.toFixed(2)}`);
  console.log(`verdict:     ${a.recommendation}`);

  // Plan-by-plan comparison: every priced plan with its metadata, ranked cheapest-first
  console.log(`\nplan-by-plan comparison (ranked, ${a.comparison.length} plans priced on this usage):`);
  a.comparison.forEach((e, i) => {
    const label = `${e.name}${e.formerly ? ` (formerly ${e.formerly})` : ""}`;
    const cost = `$${e.annualCost.toFixed(0)}/yr`;
    const basis = e.basis + (e.estimate ? " estimate" : "");
    const delta = e.current ? "current plan"
      : (!e.avail ? `NOT ELIGIBLE — ${e.excludedReason}`
      : `${e.deltaAnnual >= 0 ? "+" : "-"}$${Math.abs(e.deltaAnnual).toFixed(0)}/yr vs Standard`);
    console.log(`  ${i + 1}. ${label} — ${cost} [${basis}] ${delta}`);
    console.log(`     eligibility: ${e.eligibility} · rates: ${e.ratesAsOf}`);
    (e.eligibilityNotes || []).forEach((n) => console.log(`     note: ${n}`));
  });
  if (a.eligibility.notes.length) {
    console.log(`\neligibility notes:`);
    a.eligibility.notes.forEach((n) => console.log(`  - ${n}`));
  }
  if (a.eligibility.blockers.length) {
    console.log(`\neligibility blockers (results are reference only):`);
    a.eligibility.blockers.forEach((b) => console.log(`  ! ${b}`));
  }
}

// Same sniffing order as the browser (app.js): zip by magic bytes, then CSV-vs-XML auto-detect.
const buf = fs.readFileSync(dataPath);
const u8 = new Uint8Array(buf);
if (u8[0] === 0x50 && u8[1] === 0x4B && u8[2] === 0x03 && u8[3] === 0x04) {
  calc.unzipCsv(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
    .then(analyzeText)
    .catch((e) => { console.error(`error: ${e.message}`); process.exit(1); });
} else {
  analyzeText(new TextDecoder().decode(u8));
}
