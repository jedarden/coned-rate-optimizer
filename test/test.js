/* Automated test suite for calc.js core
   Usage: node test/test.js
   Tests parsing, analysis, and rate calculations */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const calc = require("../public/calc.js");

let testsPassed = 0;
let testsFailed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    testsPassed++;
  } else {
    console.log(`  ✗ ${message}`);
    testsFailed++;
  }
}

function assertClose(actual, expected, tolerance, message) {
  const diff = Math.abs(actual - expected);
  if (diff <= tolerance) {
    console.log(`  ✓ ${message} (actual: ${actual.toFixed(4)}, expected: ${expected.toFixed(4)}, diff: ${diff.toFixed(4)})`);
    testsPassed++;
  } else {
    console.log(`  ✗ ${message} (actual: ${actual.toFixed(4)}, expected: ${expected.toFixed(4)}, diff: ${diff.toFixed(4)})`);
    testsFailed++;
  }
}

console.log("Running calc.js core tests...\n");

// Test 1: Parse sample Green Button CSV
console.log("Test 1: Parse Green Button CSV");
try {
  const csvPath = path.join(__dirname, "fixtures/sample-greenbutton.csv");
  const csvText = fs.readFileSync(csvPath, "utf8");
  const parsed = calc.parseGreenButton(csvText);

  assert(parsed.intervals === 72, `Parsed ${parsed.intervals} intervals (expected 72)`);
  assert(parsed.ndays === 3, `Parsed ${parsed.ndays} days (expected 3)`);
  assert(parsed.hours.length === 72, `Generated ${parsed.hours.length} hour records (expected 72)`);
  assert(parsed.months.length === 2, `Generated ${parsed.months.length} month records (expected 2)`);
  console.log("");
} catch (e) {
  console.log(`  ✗ Failed to parse CSV: ${e.message}`);
  testsFailed++;
  console.log("");
}

// Test 2: Analyze parsed data
console.log("Test 2: Analyze usage data");
try {
  const csvPath = path.join(__dirname, "fixtures/sample-greenbutton.csv");
  const csvText = fs.readFileSync(csvPath, "utf8");
  const parsed = calc.parseGreenButton(csvText);
  const analysis = calc.analyze(parsed);

  assert(analysis.totalKwh > 0, `Total kWh calculated: ${analysis.totalKwh.toFixed(2)}`);
  assert(analysis.peakPct > 0 && analysis.peakPct < 100, `Peak percentage: ${analysis.peakPct.toFixed(1)}%`);
  assert(analysis.standardCost > 0, `Standard cost calculated: $${analysis.standardCost.toFixed(2)}`);
  assert(analysis.touCost > 0, `TOU cost calculated: $${analysis.touCost.toFixed(2)}`);
  assert(analysis.recommendation, `Recommendation generated: "${analysis.recommendation}"`);
  console.log("");
} catch (e) {
  console.log(`  ✗ Failed to analyze: ${e.message}`);
  testsFailed++;
  console.log("");
}

// Test 3: Rate calculations
console.log("Test 3: Rate calculation accuracy");
try {
  const csvPath = path.join(__dirname, "fixtures/sample-greenbutton.csv");
  const csvText = fs.readFileSync(csvPath, "utf8");
  const parsed = calc.parseGreenButton(csvText);
  const analysis = calc.analyze(parsed);

  // Standard rate should be ~$48.86 for this sample
  assertClose(analysis.standardCost, 48.86, 0.50, "Standard rate calculation");

  // TOU rate should be higher for peak-heavy usage
  assertClose(analysis.touCost, 63.00, 1.00, "TOU rate calculation");

  // TOU delta should be positive (peak-heavy = TOU costs more)
  assert(analysis.touDelta > 0, `TOU delta is positive (peak-heavy usage): $${analysis.touDelta.toFixed(2)}`);

  // Recommendation should be to stay on standard
  assert(analysis.recommendation.includes("Stay on Standard"), `Recommendation is to stay on standard`);
  console.log("");
} catch (e) {
  console.log(`  ✗ Failed rate calculations: ${e.message}`);
  testsFailed++;
  console.log("");
}

// Test 4: Edge cases
console.log("Test 4: Edge cases and error handling");
try {
  // Test empty input
  try {
    calc.parseGreenButton("");
    console.log(`  ✗ Should throw error for empty input`);
    testsFailed++;
  } catch (e) {
    assert(e.message.includes("couldn't find") || e.message.includes("data header"), "Empty input throws descriptive error");
  }

  // Test malformed CSV
  try {
    calc.parseGreenButton("not,a,csv,file");
    console.log(`  ✗ Should throw error for malformed CSV`);
    testsFailed++;
  } catch (e) {
    assert(e.message.includes("couldn't find") || e.message.includes("no usable"), "Malformed CSV throws error");
  }

  console.log("");
} catch (e) {
  console.log(`  ✗ Edge case tests failed: ${e.message}`);
  testsFailed++;
  console.log("");
}

// Test 5: Rate override functionality
console.log("Test 5: Rate override (applyRates)");
try {
  const originalStandard = calc.RATES.standard.allIn;
  const testRates = { standard: { allIn: 0.50 } };
  calc.applyRates(testRates);
  assert(calc.RATES.standard.allIn === 0.50, "applyRates updates standard.allIn");

  // Restore original
  calc.RATES.standard.allIn = originalStandard;
  console.log("");
} catch (e) {
  console.log(`  ✗ Rate override failed: ${e.message}`);
  testsFailed++;
  console.log("");
}

// ---- async tests (XML/ESPI + ZIP paths) run after the sync ones, then summary prints ----

// Minimal zip writer: builds in-memory archives so unzipCsv() can be tested without
// committing binary fixtures. CRC32 included — the archives are well-formed zips.
let crcTable;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function zipEntryData(name, data, method) {
  const nameBuf = Buffer.from(name, "utf8");
  const body = method === 8 ? zlib.deflateRawSync(data) : data;
  const crc = crc32(data);
  const local = Buffer.alloc(30 + nameBuf.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);          // version needed
  local.writeUInt16LE(0, 6);           // flags
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(0, 10);          // mod time
  local.writeUInt16LE(0, 12);          // mod date
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18); // compressed size
  local.writeUInt32LE(data.length, 22); // uncompressed size
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);          // extra len
  nameBuf.copy(local, 30);
  return { local: Buffer.concat([local, body]), nameBuf, method, crc, compSize: body.length, uncompSize: data.length };
}

function buildZip(entries) {
  const parts = [], centrals = [];
  let offset = 0;
  for (const e of entries) {
    const d = zipEntryData(e.name, e.data, e.method);
    parts.push(d.local);
    const central = Buffer.alloc(46 + d.nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);      // version made by
    central.writeUInt16LE(20, 6);      // version needed
    central.writeUInt16LE(0, 8);       // flags
    central.writeUInt16LE(d.method, 10);
    central.writeUInt16LE(0, 12);      // time
    central.writeUInt16LE(0, 14);      // date
    central.writeUInt32LE(d.crc, 16);
    central.writeUInt32LE(d.compSize, 20);
    central.writeUInt32LE(d.uncompSize, 24);
    central.writeUInt16LE(d.nameBuf.length, 28);
    central.writeUInt16LE(0, 30);      // extra len
    central.writeUInt16LE(0, 32);      // comment len
    central.writeUInt16LE(0, 34);      // disk start
    central.writeUInt16LE(0, 36);      // internal attrs
    central.writeUInt32LE(0, 38);      // external attrs
    central.writeUInt32LE(offset, 42); // local header offset
    d.nameBuf.copy(central, 46);
    centrals.push(central);
    offset += d.local.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);      // cd offset
  return Buffer.concat([...parts, cd, eocd]);
}

async function runFormatTests() {
  // Test 6: XML/ESPI parsing — cross-format equivalence with the CSV fixture
  console.log("Test 6: Parse Green Button XML (ESPI)");
  try {
    const csvText = fs.readFileSync(path.join(__dirname, "fixtures/sample-greenbutton.csv"), "utf8");
    const xmlText = fs.readFileSync(path.join(__dirname, "fixtures/sample-greenbutton.xml"), "utf8");
    const fromCsv = calc.parseGreenButton(csvText);
    const parsed = calc.parseESPI(xmlText);

    assert(parsed.intervals === 72, `Parsed ${parsed.intervals} interval readings (expected 72)`);
    assert(parsed.ndays === 3, `Parsed ${parsed.ndays} days (expected 3)`);
    assert(parsed.months.length === 2, `Generated ${parsed.months.length} month records (expected 2)`);
    // Same underlying data as the CSV fixture: per-month totals/peak/off must agree
    parsed.months.forEach((xm, i) => {
      const cm = fromCsv.months[i];
      assertClose(xm.total, cm.total, 1e-6, `XML month ${xm.ym} total matches CSV (${xm.ym})`);
      assertClose(xm.peak, cm.peak, 1e-6, `XML month ${xm.ym} peak kWh matches CSV`);
      assertClose(xm.off, cm.off, 1e-6, `XML month ${xm.ym} off-peak kWh matches CSV`);
    });

    // The router should auto-detect XML and produce the same result
    const routed = calc.parse(xmlText);
    assertClose(routed.months[0].total, parsed.months[0].total, 1e-9, "parse() routes XML to the ESPI parser");

    // Namespace-prefix tolerance: strip the espi: prefixes and results must be identical
    const unprefixed = xmlText.replace(/(<\/?)espi:/g, "$1");
    const alt = calc.parseESPI(unprefixed);
    assertClose(alt.months[0].total, parsed.months[0].total, 1e-9, "ESPI parser handles unprefixed XML too");

    // Analyze works end-to-end on the XML path
    const analysis = calc.analyze(parsed);
    assert(analysis.totalKwh > 0, `XML analysis computes total kWh: ${analysis.totalKwh.toFixed(2)}`);
    console.log("");
  } catch (e) {
    console.log(`  ✗ XML/ESPI tests failed: ${e.message}`);
    testsFailed++;
    console.log("");
  }

  // Test 7: XML graceful errors
  console.log("Test 7: XML/ESPI error handling");
  try {
    try {
      calc.parseESPI("<?xml version=\"1.0\"?><root><foo>bar</foo></root>");
      console.log(`  ✗ Should reject XML with no interval readings`);
      testsFailed++;
    } catch (e) {
      assert(e.message.includes("interval readings"), `Non-ESPI XML rejected with guidance: "${e.message.slice(0, 60)}…"`);
    }
    try {
      calc.parseESPI("");
      console.log(`  ✗ Should reject empty XML`);
      testsFailed++;
    } catch (e) {
      assert(e.message.includes("interval readings"), "Empty XML rejected gracefully");
    }
    console.log("");
  } catch (e) {
    console.log(`  ✗ XML error tests failed: ${e.message}`);
    testsFailed++;
    console.log("");
  }

  // Test 8: ZIP import (stored + deflate), including XML inside a zip
  console.log("Test 8: Import raw .zip");
  try {
    const csvText = fs.readFileSync(path.join(__dirname, "fixtures/sample-greenbutton.csv"), "utf8");
    const xmlText = fs.readFileSync(path.join(__dirname, "fixtures/sample-greenbutton.xml"), "utf8");

    const storedZip = buildZip([{ name: "coned-usage.csv", data: Buffer.from(csvText, "utf8"), method: 0 }]);
    const storedText = await calc.unzipCsv(storedZip.buffer.slice(storedZip.byteOffset, storedZip.byteOffset + storedZip.byteLength));
    assert(storedText === csvText, "Stored (uncompressed) .zip yields the original CSV text");

    const deflatedZip = buildZip([{ name: "coned-usage.csv", data: Buffer.from(csvText, "utf8"), method: 8 }]);
    const deflatedText = await calc.unzipCsv(deflatedZip.buffer.slice(deflatedZip.byteOffset, deflatedZip.byteOffset + deflatedZip.byteLength));
    assert(deflatedText === csvText, "Deflated .zip inflates back to the original CSV text");

    // ConEd-style zip: usage XML + a non-data file alongside it; the .xml must win over the fallback
    const mixedZip = buildZip([
      { name: "readme.txt", data: Buffer.from("Your Green Button data is attached."), method: 0 },
      { name: "usage.xml", data: Buffer.from(xmlText, "utf8"), method: 8 },
    ]);
    const mixedText = await calc.unzipCsv(mixedZip.buffer.slice(mixedZip.byteOffset, mixedZip.byteOffset + mixedZip.byteLength));
    const fromXml = calc.parse(mixedText);
    assert(fromXml.intervals === 72, "XML inside a .zip parses end-to-end (72 intervals)");
    console.log("");
  } catch (e) {
    console.log(`  ✗ ZIP tests failed: ${e.message}`);
    testsFailed++;
    console.log("");
  }

  // Test 9: ZIP graceful errors
  console.log("Test 9: ZIP error handling");
  try {
    try {
      await calc.unzipCsv(new TextEncoder().encode("this is definitely not a zip file").buffer);
      console.log(`  ✗ Should reject a non-zip file`);
      testsFailed++;
    } catch (e) {
      assert(e.message.includes("zip"), `Non-zip input rejected gracefully: "${e.message}"`);
    }
    // Truncated central directory
    const z = buildZip([{ name: "x.csv", data: Buffer.from("a,b\n1,2\n"), method: 0 }]);
    const truncated = z.slice(0, z.length - 15);
    try {
      await calc.unzipCsv(truncated.buffer.slice(truncated.byteOffset, truncated.byteOffset + truncated.byteLength));
      console.log(`  ✗ Should reject a corrupt zip`);
      testsFailed++;
    } catch (e) {
      assert(e.message.includes("corrupt"), "Corrupt zip rejected gracefully");
    }
    console.log("");
  } catch (e) {
    console.log(`  ✗ ZIP error tests failed: ${e.message}`);
    testsFailed++;
    console.log("");
  }

  // Test 10: complete plan inventory with metadata (exact display names, basis,
  // eligibility, rates-as-of dates) — in calc.js defaults AND mirrored in rates.json.
  console.log("Test 10: Plan inventory & metadata");
  try {
    const PLAN_KEYS = ["standard", "tou", "steadyUse", "smartEnergy"];
    const EXACT_NAMES = {
      standard: "Standard Residential",
      tou: "Time-of-Use",
      steadyUse: "Steady Use Rate",
      smartEnergy: "Smart Energy Plan",
    };
    const ratesJson = JSON.parse(fs.readFileSync(path.join(__dirname, "../public/rates.json"), "utf8"));
    // Apply rates.json like the live site does — this also restores derived fields
    // (RATES._nonDelivery, RATES.tou.nonCommodity) after Test 5's allIn override.
    calc.applyRates(ratesJson);

    PLAN_KEYS.forEach((k) => {
      const p = calc.RATES[k];
      assert(!!p, `Plan ${k} exists in the inventory`);
      assert(p.name === EXACT_NAMES[k], `${k} display name is exactly "${EXACT_NAMES[k]}" (got "${p.name}")`);
      assert(p.basis === "energy" || p.basis === "demand", `${k} declares its pricing basis (${p.basis})`);
      assert(typeof p.eligibility === "string" && p.eligibility.length > 0, `${k} declares eligibility`);
      assert(typeof p.ratesAsOf === "string" && p.ratesAsOf.length > 0, `${k} declares a rates-as-of date`);
      assert(typeof p.source === "string" && /^https:\/\//.test(p.source), `${k} links its ConEd source`);
      assert(!!ratesJson[k], `rates.json carries the ${k} plan`);
      assert(ratesJson[k].name === p.name && ratesJson[k].basis === p.basis &&
             ratesJson[k].ratesAsOf === p.ratesAsOf && ratesJson[k].eligibility === p.eligibility,
             `rates.json metadata mirrors calc.js for ${k}`);
    });
    assert(calc.RATES.steadyUse.formerly === "Select Pricing Plan",
      `Steady Use carries its former name ("${calc.RATES.steadyUse.formerly}")`);
    assert(calc.RATES.steadyUse.basis === "demand" && calc.RATES.smartEnergy.basis === "demand",
      "Steady Use & Smart Energy are demand-based");
    assert(calc.RATES.meta.version === "1.8.0", `Rate model version bumped (v${calc.RATES.meta.version})`);
    console.log("");
  } catch (e) {
    console.log(`  ✗ Plan inventory tests failed: ${e.message}`);
    testsFailed++;
    console.log("");
  }

  // Test 11: plan-by-plan comparison output from analyze() — one ranked entry per
  // priced plan, with metadata, deltas vs Standard, and honest estimate flags.
  console.log("Test 11: Plan-by-plan comparison output");
  try {
    const csvText = fs.readFileSync(path.join(__dirname, "fixtures/sample-greenbutton.csv"), "utf8");
    const parsed = calc.parseGreenButton(csvText);
    const a = calc.analyze(parsed);

    assert(Array.isArray(a.comparison) && a.comparison.length === 4,
      `Comparison covers all four plans (got ${a.comparison.length})`);
    for (let i = 1; i < a.comparison.length; i++) {
      assert(a.comparison[i].annualCost >= a.comparison[i - 1].annualCost,
        `Comparison ranked cheapest-first at rank ${i + 1}`);
    }
    const stdE = a.comparison.find((p) => p.key === "standard");
    assert(!!stdE && stdE.current === true, "Standard is flagged as the current plan");
    assert(Math.abs(stdE.deltaAnnual) < 1e-9, "Standard's delta vs itself is 0");
    const steadyE = a.comparison.find((p) => p.key === "steady");
    assert(!!steadyE && steadyE.basis === "demand" && steadyE.estimate === true,
      "Steady Use entry is a flagged demand estimate");
    assert(steadyE.formerly === "Select Pricing Plan", "Steady Use comparison entry carries its former name");
    a.comparison.forEach((e) => {
      assert(!!e.name && !!e.basis && !!e.ratesAsOf && typeof e.annualCost === "number",
        `Comparison entry "${e.key}" has name, basis, ratesAsOf, and annualCost`);
    });
    assert(a.comparison[0].key === a.cheapest.key, "Comparison head agrees with the cheapest plan");
    assert(a.comparison.every((e) => typeof e.deltaAnnual === "number"),
      "Every entry carries an annualized delta vs Standard");

    // Months-only input (no interval data, like the built-in sample): the demand
    // plans can't be derived, so the comparison must shrink to the energy plans.
    const a2 = calc.analyze({ months: parsed.months, ndays: parsed.ndays });
    assert(a2.comparison.length === 2, `Months-only input prices 2 plans (got ${a2.comparison.length})`);
    assert(a2.comparison.every((e) => e.basis === "energy"), "Months-only comparison has energy plans only");
    console.log("");
  } catch (e) {
    console.log(`  ✗ Comparison output tests failed: ${e.message}`);
    testsFailed++;
    console.log("");
  }

  // Test 12: eligibility & lock-in engine — location, account, meter, current-plan,
  // fit (solar/ESCO), enrollment timing, and lock-in rules gate the switch verdict.
  console.log("Test 12: Eligibility & lock-in engine");
  try {
    const csvText = fs.readFileSync(path.join(__dirname, "fixtures/sample-greenbutton.csv"), "utf8");
    const parsed = calc.parseGreenButton(csvText);
    const notesOf = (a, key) => {
      const p = a.plans.find((x) => x.key === key);
      return p ? p.eligibilityNotes.join(" ") : "";
    };

    // default profile: SC1 · NYC · smart meter · on Standard — nothing excluded
    const a0 = calc.analyze(parsed);
    assert(a0.eligibility && a0.eligibility.blockers.length === 0, "Default profile has no blockers");
    assert(a0.plans.every((p) => p.avail), "Default profile leaves every plan available");
    assert(a0.plans.find((p) => p.key === "standard").current === true, "Default current plan is Standard");
    assert(!!a0.switchTarget && a0.switchTarget.key !== "standard", "Switch target is an alternative, not the current plan");
    assert(a0.recommendation.includes("Stay on Standard"), "Default verdict stays on Standard for the peak-heavy fixture");
    assert(/18 months/.test(notesOf(a0, "tou")) && /one-year/.test(notesOf(a0, "tou")),
      "TOU carries its one-year commitment and 18-month rejoin lock-in notes");
    assert(/18 months/.test(notesOf(a0, "steady")) && /18 months/.test(notesOf(a0, "smart")),
      "Both demand plans carry the 18-month re-enrollment lock-in note");
    assert(!/Lock-in:/.test(notesOf(a0, "standard")), "Standard (no lock-in) carries no lock-in note");

    // current-plan = TOU: TOU becomes the baseline and Standard becomes the switch candidate
    const aTou = calc.analyze(parsed, { profile: { currentPlan: "tou" } });
    assert(aTou.plans.find((p) => p.key === "tou").current === true, "Declared current plan (TOU) is flagged current");
    assert(aTou.switchTarget.key === "standard", "Standard becomes the switch candidate for a TOU home");
    assert(aTou.savingsIfSwitch > 1, "TOU home on the peak-heavy fixture saves by switching back to Standard");
    assert(aTou.recommendation.includes("Switch to Standard"), "Verdict tells the TOU home to switch back");
    assert(!/one-year commitment|Lock-in/.test(notesOf(aTou, "tou")), "Current plan is not pitched switch terms");

    // meter gate: a traditional (non-AMI) meter excludes both demand plans
    const aLegacy = calc.analyze(parsed, { profile: { meter: "legacy" } });
    const legacyExcluded = aLegacy.plans.filter((p) => p.key === "steady" || p.key === "smart");
    assert(legacyExcluded.every((p) => p.avail === false), "Legacy meter excludes both demand plans");
    assert(legacyExcluded.every((p) => /smart meter/i.test(p.excludedReason)),
      "Exclusion reason names the smart-meter requirement");
    assert(aLegacy.comparison.length === 4, "Excluded demand plans stay visible in the comparison");
    assert(aLegacy.comparison.slice(-2).every((e) => !e.avail), "Excluded plans rank last in the comparison");
    assert(aLegacy.plans.filter((p) => p.avail).every((p) => p.basis === "energy"),
      "Only energy plans remain switch candidates for a legacy meter");

    // meter gate via data: months-only input can't price demand plans either
    const aMo = calc.analyze({ months: parsed.months, ndays: parsed.ndays });
    assert(aMo.eligibility.verdicts.steady.available === false &&
           /interval data/.test(aMo.eligibility.verdicts.steady.reason),
      "Months-only input gates demand plans on missing interval data");

    // solar: advisory notes on the demand plans, no exclusion
    const aSolar = calc.analyze(parsed, { profile: { solar: true } });
    assert(aSolar.plans.filter((p) => p.key === "steady" || p.key === "smart").every((p) => p.avail),
      "Solar doesn't hard-exclude the demand plans (ConEd's guidance is advisory)");
    assert(/solar/i.test(notesOf(aSolar, "steady")) && /solar|Net Metering/i.test(notesOf(aSolar, "smart")),
      "Solar homes get ConEd's demand-plan fit guidance");

    // ESCO supply: TOU commitment exemption + supply-side caveat
    const aEsco = calc.analyze(parsed, { profile: { esco: true } });
    assert(/ESCO/.test(notesOf(aEsco, "tou")) && /exempt/.test(notesOf(aEsco, "tou")),
      "ESCO homes are told the TOU one-year commitment doesn't apply");
    assert(aEsco.eligibility.notes.some((n) => /ESCO/.test(n) && /contract price/.test(n)),
      "ESCO supply caveat explains the supply estimate doesn't apply");

    // heat pump: unlocks the 12-month Steady Use price-guarantee note
    const aHp = calc.analyze(parsed, { profile: { heatPump: true } });
    assert(/price guarantee/.test(notesOf(aHp, "steady")), "Heat-pump homes see the 12-month price guarantee");

    // SmartCharge conflict: switching to Steady Use unenrolls you from SmartCharge NY
    const aSc = calc.analyze(parsed, { smartChargeNY: true });
    assert(/SmartCharge/.test(notesOf(aSc, "steady")),
      "EV what-if flags the Steady Use ↔ SmartCharge conflict");
    assert(!/SmartCharge unenroll|automatically unenrolls/.test(notesOf(a0, "steady")),
      "No SmartCharge conflict note when the EV option is off");

    // account gate: non-SC1 blocks every plan
    const aSc2 = calc.analyze(parsed, { profile: { serviceClass: "SC2" } });
    assert(aSc2.eligibility.blockers.length > 0, "Non-SC1 account raises a blocker");
    assert(aSc2.plans.every((p) => p.avail === false), "Non-SC1 account excludes every plan");
    assert(aSc2.savingsIfSwitch === 0, "No switch savings claimed for an out-of-scope account");

    // location gates
    const aOut = calc.analyze(parsed, { profile: { territory: "outside" } });
    assert(aOut.eligibility.blockers.length > 0 && aOut.plans.every((p) => p.avail === false),
      "Non-ConEd territory raises a blocker and excludes every plan");
    const aW = calc.analyze(parsed, { profile: { territory: "westchester" } });
    assert(aW.eligibility.blockers.length === 0 && aW.plans.every((p) => p.avail),
      "Westchester is in-territory (no exclusions)");
    assert(aW.eligibility.notes.some((n) => /Westchester/.test(n)),
      "Westchester gets the NYC-pricing caveat");

    // the comparison surface carries the engine's output too
    const steadyEntry = a0.comparison.find((e) => e.key === "steady");
    assert(steadyEntry.avail === true && Array.isArray(steadyEntry.eligibilityNotes) && steadyEntry.lockIn,
      "Comparison entries carry avail, eligibilityNotes, and lockIn");
    const legacyEntry = aLegacy.comparison.find((e) => e.key === "smart");
    assert(legacyEntry.avail === false && !!legacyEntry.excludedReason,
      "Comparison entries carry the exclusion reason");
    console.log("");
  } catch (e) {
    console.log(`  ✗ Eligibility engine tests failed: ${e.message}`);
    testsFailed++;
    console.log("");
  }

  // Test 13: rule data mirroring — rates.json must carry the same eligibility/lock-in
  // rules as calc.js defaults (the runtime override path).
  console.log("Test 13: Eligibility rule data mirrors rates.json");
  try {
    const ratesJson = JSON.parse(fs.readFileSync(path.join(__dirname, "../public/rates.json"), "utf8"));
    const PLAN_KEYS = ["standard", "tou", "steadyUse", "smartEnergy"];
    PLAN_KEYS.forEach((k) => {
      const c = calc.RATES[k], j = ratesJson[k];
      assert(JSON.stringify(c.requires) === JSON.stringify(j.requires),
        `rates.json requires-rules mirror calc.js for ${k}`);
      assert(JSON.stringify(c.lockIn) === JSON.stringify(j.lockIn),
        `rates.json lockIn rules mirror calc.js for ${k}`);
      assert((c.solar || null) === (j.solar || null), `rates.json solar note mirrors calc.js for ${k}`);
    });
    assert(ratesJson.meta.switchTiming === calc.RATES.meta.switchTiming,
      "rates.json carries the switch-timing note");
    console.log("");
  } catch (e) {
    console.log(`  ✗ Rule-mirroring tests failed: ${e.message}`);
    testsFailed++;
    console.log("");
  }

  // Test 14: bill reconstruction — the engine must reproduce ConEd's real published
  // bill history (test/fixtures/bill-history-sc1-nyc.json) before any counterfactual
  // built on it can be trusted (docs/product-strategy.md, "Historical backtest").
  console.log("Test 14: Bill reconstruction vs published bill history");
  try {
    const fx = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/bill-history-sc1-nyc.json"), "utf8"));
    const nowYear = new Date().getFullYear();

    // Integrity guards on the transcription itself: the fixture is hand-transcribed,
    // so the suite re-derives its published totals before trusting it as ground truth.
    const yearKeys = Object.keys(fx.years);
    const sumC = (o) => Object.keys(o).filter((k) => k !== "total").reduce((s, k) => s + o[k], 0);
    yearKeys.forEach((y) => {
      const d = fx.years[y];
      assertClose(sumC(d.rates), d.ratesTotal, 5e-4, `${y}: rate components sum to the published ¢/kWh total`);
      Object.keys(d.rates).forEach((c) => {
        assertClose(d.bill[c], Math.round(fx.sampleKwh * d.rates[c]) / 100, 5e-3,
          `${y}: published ${c} bill line = ${fx.sampleKwh} kWh × rate`);
      });
      assertClose(sumC(d.bill), d.bill.total, 5e-3, `${y}: published bill lines sum to the published total`);
    });
    const avg = (f) => yearKeys.reduce((s, y) => s + f(fx.years[y]), 0) / yearKeys.length;
    assertClose(avg((d) => d.ratesTotal), fx.publishedAverage.ratesTotal, 5e-4,
      "year columns average to the published 36-month ¢/kWh column");
    assertClose(avg((d) => d.bill.total), fx.publishedAverage.billTotal, 5e-3,
      "year columns average to the published 36-month bill column");

    // rates.json must carry the same bill history as the calc.js defaults (Test 13's
    // mirroring rule, for the new sections), and applyRates() must preserve it.
    const ratesJson = JSON.parse(fs.readFileSync(path.join(__dirname, "../public/rates.json"), "utf8"));
    assert(JSON.stringify(ratesJson.bill.periods) === JSON.stringify(calc.RATES.bill.periods),
      "rates.json bill periods mirror calc.js");
    assert(JSON.stringify(ratesJson.accuracy) === JSON.stringify(calc.RATES.accuracy),
      "rates.json accuracy policy mirrors calc.js");
    assert(ratesJson.bill.source === calc.RATES.bill.source && !!ratesJson.bill.basis,
      "rates.json carries the bill publication source & basis");

    // Reconstruction: published bills exclude the customer charge, so price them the
    // same way and require the model to land on the published dollars.
    const pubFor = (y) => fx.years[String(y)];
    yearKeys.map(Number).forEach((y) => {
      const pub = pubFor(y);
      const rec = calc.reconstructBill({ kwh: fx.sampleKwh, year: y }, { includeCustomerCharge: false });
      assert(rec.ratePeriod.year === y && rec.projected === false,
        `${y}: prices at its own published period (not projected)`);
      ["delivery", "commodity", "mac", "rdm", "surcharges"].forEach((c) => {
        assertClose(rec.components[c], pub.bill[c], 5e-3, `${y}: reconstructed ${c} matches the published line`);
      });
      assertClose(rec.total, pub.bill.total, 5e-3, `${y}: reconstructed bill matches the published $${pub.bill.total.toFixed(2)}`);
    });

    // 2023's RDM is a credit — the line must price negative and say so.
    const r2023 = calc.reconstructBill({ kwh: fx.sampleKwh, year: 2023 }, { includeCustomerCharge: false });
    const rdmLine = r2023.lines.filter((l) => l.component === "rdm")[0];
    assert(rdmLine.amount < 0 && rdmLine.detail.includes("(credit)"),
      `2023 RDM prices as a credit ("${rdmLine.detail}")`);

    // Projection rules: an uncovered future year prices at the latest prior period and
    // is flagged; a year older than the table falls back to the earliest and is flagged.
    const f2026 = calc.billRatePeriod(2026);
    assert(f2026.year === 2025 && f2026.projected === true, "2026 prices at the 2025 period, flagged projected");
    const f2022 = calc.billRatePeriod(2022);
    assert(f2022.year === 2023 && f2022.projected === true, "2022 falls back to the earliest period, flagged projected");
    const noYear = calc.billRatePeriod(undefined);
    assert(noYear.year === 2025 && noYear.projected === (2025 < nowYear),
      "no year prices at the latest period, projected iff it predates the current year");

    // The default reconstruction (a real customer's bill) adds the customer charge.
    const noCust2024 = calc.reconstructBill({ kwh: fx.sampleKwh, year: 2024 }, { includeCustomerCharge: false });
    const withCust = calc.reconstructBill({ kwh: fx.sampleKwh, year: 2024 });
    assertClose(withCust.components.customerCharge, calc.RATES.standard.customer, 1e-9,
      "customer charge included by default at the published $/month");
    assertClose(withCust.total, noCust2024.total + calc.RATES.standard.customer, 1e-9,
      "default total = published-basis total + customer charge");

    // Partial periods and an actual Market Supply Charge override.
    const twoMos = calc.reconstructBill({ kwh: fx.sampleKwh, year: 2024, months: 2 });
    assertClose(twoMos.components.customerCharge, 2 * calc.RATES.standard.customer, 1e-9,
      "customer charge scales with the period length in months");
    const ownSupply = calc.reconstructBill({ kwh: fx.sampleKwh, year: 2024, supplyPerKwh: 0.15 },
      { includeCustomerCharge: false });
    assertClose(ownSupply.components.commodity, fx.sampleKwh * 0.15, 1e-9,
      "supplyPerKwh replaces the annual average supply rate (the Market Supply Charge actually billed)");
    assertClose(ownSupply.total, noCust2024.total - noCust2024.components.commodity + fx.sampleKwh * 0.15, 1e-9,
      "supplyPerKwh changes only the supply line");

    // Error paths: reconstruction refuses to guess.
    [() => calc.reconstructBill({}), () => calc.reconstructBill({ kwh: -5 }),
     () => calc.reconstructBill({ kwh: 300, plan: "tou" })].forEach((f, i) => {
      try { f(); assert(false, `reconstruction rejects bad input #${i + 1}`); }
      catch (err) { assert(!!err.message, `reconstruction rejects bad input #${i + 1}: "${err.message.slice(0, 48)}…"`);
      }
    });
    console.log("");
  } catch (e) {
    console.log(`  ✗ Bill reconstruction tests failed: ${e.message}`);
    testsFailed++;
    console.log("");
  }

  // Test 15: reconciliation & the accuracy gate — modeled vs actual bills, the
  // pass/warn/fail bands, and the 95%-within-2% gate from docs/product-strategy.md.
  console.log("Test 15: Reconciliation & accuracy gate");
  try {
    const fx = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/bill-history-sc1-nyc.json"), "utf8"));
    const opts = { includeCustomerCharge: false };

    // A real 3-period account backtest: every published year must reconcile.
    const backtest = Object.keys(fx.years).map((y) =>
      calc.reconcileBill({ kwh: fx.sampleKwh, year: +y, total: fx.years[y].bill.total,
        components: fx.years[y].bill, label: `${y} sample month` }, opts));
    const realGate = calc.accuracyGate(backtest);
    assert(realGate.gate === "pass" && realGate.failures.length === 0,
      `published 3-year backtest passes the gate (${realGate.pctWithin2.toFixed(0)}% within 2%)`);
    backtest.forEach((r) => {
      assert(r.band === "pass" && r.withinGate === true, `${r.label}: reconciles (${r.pctError.toFixed(4)}% error)`);
      assert(Math.abs(r.delta) < 0.005, `${r.label}: delta under half a cent (${r.delta.toFixed(4)} USD)`);
    });

    // Component-level reconciliation: the driver is the largest absolute delta.
    const recon = backtest[1]; // 2024
    assert(!!recon.driver && recon.driver.component === "commodity" || !!recon.driver,
      `reconciliation names a driver component (${recon.driver ? recon.driver.label : "none"})`);
    const worst = recon.componentDeltas.reduce((a, b) => (Math.abs(b.delta) > Math.abs(a.delta) ? b : a));
    assert(recon.driver === worst || Math.abs(recon.driver.delta - worst.delta) < 1e-12,
      "driver is the component with the largest absolute delta");

    // The bands: ≤2% passes, ≤5% warns, beyond warns fails.
    const mk = (total, actualExtra, optExtra) => calc.reconcileBill(
      Object.assign({ kwh: fx.sampleKwh, year: 2024, total }, actualExtra || {}),
      Object.assign({}, opts, optExtra || {}));
    assert(mk(fx.years["2024"].bill.total).band === "pass", "an exact bill passes");
    const warn = mk(97.50);
    assert(warn.band === "warn" && !warn.withinGate, `+${warn.pctError.toFixed(2)}% lands in the warn band`);
    const fail = mk(92.00);
    assert(fail.band === "fail" && !fail.withinGate, `+${fail.pctError.toFixed(2)}% fails outright`);
    assert(warn.pctError > calc.RATES.accuracy.passPct && warn.pctError <= calc.RATES.accuracy.warnPct,
      "warn case sits between the configured thresholds");

    // Threshold overrides apply per call (accuracyThresholds plumbing).
    const strict = mk(fx.years["2024"].bill.total, null, { thresholds: { passPct: 0 } });
    assert(strict.band === "warn" && strict.withinGate === false,
      "threshold overrides tighten a call: a 0.0002% miss fails a 0% gate");
    try { mk(fx.years["2024"].bill.total, null, { thresholds: { passPct: 10 } }); assert(false, "passPct > warnPct override should throw"); }
    catch (err) { assert(err.message.includes("warnPct"), `incoherent override rejected: "${err.message.slice(0, 52)}…"`);
    }

    // Errors: reconciliation refuses to guess the actual total; a $0 bill never divides by zero.
    try { calc.reconcileBill({ kwh: 300, year: 2024 }); assert(false, "should require actual.total"); }
    catch (err) { assert(err.message.includes("actual bill total"), `missing actual total rejected: "${err.message.slice(0, 48)}…"`);
    }
    const zero = mk(0);
    assert(!isFinite(zero.pctError) && zero.band === "fail",
      "a $0 actual bill yields ±∞ error and fails (no divide-by-zero)");

    // The gate itself: 95% of periods within 2% passes; one more miss fails; every
    // miss is listed, never averaged away.
    const ok = backtest[0];
    const twenty = Array(19).fill(ok).concat([warn]); // 19/20 within 2% = the gate edge
    const edgeGate = calc.accuracyGate(twenty);
    assert(edgeGate.gate === "pass" && edgeGate.within2 === 19 && edgeGate.within5 === 20,
      `19/20 within 2% passes the 95% gate (${edgeGate.pctWithin2.toFixed(0)}% / ${edgeGate.pctWithin5.toFixed(0)}%)`);
    const failedGate = calc.accuracyGate(twenty.slice(0, 18).concat([warn, fail]));
    assert(failedGate.gate === "fail" && failedGate.within2 === 18,
      "18/20 within 2% fails the gate");
    assert(failedGate.failures.length === 2 && failedGate.failures.every((f) => f.label && isFinite(f.pctError)),
      "every miss is listed with its label and error");
    assertClose(failedGate.maxPctError, fail.pctError, 1e-12, "maxPctError tracks the worst period");
    assertClose(failedGate.meanPctError, (ok.pctError * 18 + warn.pctError + fail.pctError) / 20, 1e-12,
      "meanPctError averages all periods");
    assert(calc.accuracyGate([]).gate === "fail", "no periods = gate fails (refuse by default)");
    console.log("");
  } catch (e) {
    console.log(`  ✗ Reconciliation/gate tests failed: ${e.message}`);
    testsFailed++;
    console.log("");
  }

  // Test 16: demand-plan pricing — the Steady Use & Smart Energy schedules bill
  // delivery on the average of the three highest hourly demands per month (peak
  // window: weekdays noon–8pm, seasonally split), hold supply + surcharges at the
  // standard flat non-delivery rate, and add the plan's customer charge per month.
  console.log("Test 16: Demand-plan pricing (Steady Use & Smart Energy schedules)");
  try {
    // Self-sufficient rate state: restore rates.json over the defaults (Test 5's
    // allIn override leaves the derived fields stale until Test 10 restores them).
    calc.applyRates(JSON.parse(fs.readFileSync(path.join(__dirname, "../public/rates.json"), "utf8")));
    const SU = calc.RATES.steadyUse, SE = calc.RATES.smartEnergy, STD = calc.RATES.standard;
    const nonDelivery = STD.allIn - STD.delivery;
    assert(SU.peakStart === 12 && SU.peakEnd === 20 && SE.peakStart === 12 && SE.peakEnd === 20,
      "both demand schedules publish the weekdays-noon–8pm peak window this test prices against");

    // Hand-built two-month dataset whose top-3 averages are readable constants:
    // July (summer): peak 9,7,5,1,1 → 7 kW; off 4,2,1,0.5 → 7/3 kW.
    // January (winter): peak 6,4,2,1 → 4 kW; off 3,2,1,0.5 → 2 kW.
    const hr = (ym, mo, hour, weekday, kwh) => ({ ym, mo, hour, weekday, kwh });
    const demandHours = [
      hr("2026-07", 7, 12, 3, 9), hr("2026-07", 7, 13, 3, 7), hr("2026-07", 7, 14, 3, 5),
      hr("2026-07", 7, 15, 3, 1), hr("2026-07", 7, 16, 3, 1),
      hr("2026-07", 7, 2, 3, 4), hr("2026-07", 7, 3, 3, 2), hr("2026-07", 7, 4, 3, 1), hr("2026-07", 7, 5, 3, 0.5),
      hr("2027-01", 1, 12, 4, 6), hr("2027-01", 1, 13, 4, 4), hr("2027-01", 1, 14, 4, 2), hr("2027-01", 1, 15, 4, 1),
      hr("2027-01", 1, 2, 4, 3), hr("2027-01", 1, 3, 4, 2), hr("2027-01", 1, 4, 4, 1), hr("2027-01", 1, 5, 4, 0.5),
    ];
    const kwhTotal = demandHours.reduce((s, h) => s + h.kwh, 0);
    assertClose(kwhTotal, 50, 1e-9, "fixture sanity: the demand dataset totals 50 kWh");

    const dLine = (r) => r.lines.find((l) => l.label === "Delivery (demand-based)");
    [["Steady Use", SU], ["Smart Energy", SE]].forEach(([label, plan]) => {
      const r = calc.costDemand(demandHours, plan);
      // Top-3 averages are literals; the seasonal rates come from the schedule under test.
      const expDelivery = 7 * plan.demand.peakSummer + (7 / 3) * plan.demand.off
        + 4 * plan.demand.peakWinter + 2 * plan.demand.off;
      assertClose(dLine(r).amount, expDelivery, 1e-6,
        `${label}: delivery = seasonal top-3 kW × the plan's $/kW rates`);
      assertClose(r.lines.find((l) => l.label === "Supply + surcharges (flat est.)").amount,
        kwhTotal * nonDelivery, 1e-6, `${label}: supply + surcharges held at the standard flat rate`);
      assertClose(r.lines.find((l) => l.label === "Basic service charge").amount,
        2 * plan.customer, 1e-6, `${label}: customer charge per month of data`);
      assertClose(r.total, expDelivery + kwhTotal * nonDelivery + 2 * plan.customer, 1e-6,
        `${label}: total = delivery + flat supply + customer charge`);
      assert(r.lines.length === 3, `${label}: itemized into 3 line items`);
    });

    // The peak window's edges: noon (peakStart) is inclusive, 8pm (peakEnd) is
    // exclusive, and weekends never bill at the peak rate — misplacing any of the
    // three moves the delivery line by hundreds of dollars.
    const edgeHours = [
      hr("2026-07", 7, 19, 3, 6),   // weekday 7pm → peak
      hr("2026-07", 7, 20, 3, 60),  // weekday 8pm → off (peakEnd is exclusive)
      hr("2026-07", 7, 11, 3, 5),   // weekday 11am → off (before peakStart)
      hr("2026-07", 7, 12, 3, 4),   // weekday noon → peak (peakStart is inclusive)
      hr("2026-07", 7, 13, 6, 50),  // Saturday 1pm → off (weekends are never peak)
    ];
    const expEdge = 5 * SU.demand.peakSummer + ((60 + 50 + 5) / 3) * SU.demand.off;
    assertClose(dLine(calc.costDemand(edgeHours, SU)).amount, expEdge, 1e-6,
      "peak-window edges: noon in, 8pm out, weekends out");

    // End to end: on a flat, heavy load both demand plans undercut both energy
    // plans, so the verdict itself names one — flagged as the estimate it is.
    const flatHours = [], flatMonths = [];
    [["2026-07", 7, true], ["2027-01", 1, false]].forEach(([ym, mo, summer]) => {
      for (let i = 0; i < 500; i++) flatHours.push(hr(ym, mo, i % 12, 1 + (i % 5), 4)); // 2000 kWh off-peak
      flatHours.push(hr(ym, mo, 12, 1, 1), hr(ym, mo, 13, 1, 1), hr(ym, mo, 14, 1, 1)); // 1 kW peak
      flatMonths.push({ ym, mo, summer, total: 2003, peak: 3, off: 2000 });
    });
    const aFlat = calc.analyze({ months: flatMonths, hours: flatHours, ndays: 61 });
    const steadyFlat = aFlat.plans.find((p) => p.key === "steady");
    const smartFlat = aFlat.plans.find((p) => p.key === "smart");
    assert(aFlat.hasDemand === true, "interval data prices the demand plans");
    assertClose(steadyFlat.cost, calc.costDemand(flatHours, SU).total, 1e-9,
      "analyze()'s Steady Use cost agrees with costDemand()");
    assert(steadyFlat.cost < smartFlat.cost && smartFlat.cost < aFlat.touCost && aFlat.touCost < aFlat.standardCost,
      "flat heavy load ranks: Steady Use < Smart Energy < TOU < Standard");
    assert(aFlat.switchTarget.key === "steady", "switch target is the cheapest eligible plan (Steady Use)");
    assert(/Switch to Steady Use Rate/.test(aFlat.recommendation),
      `verdict names the demand plan ("${aFlat.recommendation}")`);
    assertClose(aFlat.savingsIfSwitch, aFlat.standardCost - steadyFlat.cost, 1e-9,
      "savings are measured from the current plan to the switch target");
    assert(aFlat.comparison[0].key === "steady" && steadyFlat.demand === true,
      "comparison ranks the demand plan first, flagged as a demand entry");
    assert(aFlat.demandOpportunity === true, "flat-load home is flagged with the demand-opportunity caveat");
    console.log("");
  } catch (e) {
    console.log(`  ✗ Demand-plan pricing tests failed: ${e.message}`);
    testsFailed++;
    console.log("");
  }
}

// Test 17: Green Button Connect client core — config handling, the OAuth
// authorization request shape, callback/CSRF validation, the sessionStorage
// connection store, and ESPI feed-walk helpers. The full authorization flow
// (real Pages Function, mock ConEd) lives in test/gbc-sandbox.js.
console.log("Test 17: Green Button Connect core");
try {
  const gbc = require("../public/gbc.js");
  const shim = () => {
    const m = {};
    return {
      setItem: (k, v) => { m[k] = String(v); },
      getItem: (k) => (k in m ? m[k] : null),
      removeItem: (k) => { delete m[k]; }
    };
  };
  for (const fn of ["validateConfig", "loadConfig", "isConfigured", "randomState", "buildRedirectUri",
    "authorizeUrl", "parseCallback", "friendlyError", "exchangeToken", "saveConnection", "loadConnection",
    "clearConnection", "connectionIsFresh", "apiGet", "extractEntryIds", "connect", "refreshFeeds"]) {
    assert(typeof gbc[fn] === "function", `exports ${fn}()`);
  }

  // config: missing file degrades to unconfigured; configured:true demands the lot
  const throws = (fn, msg) => {
    try { fn(); assert(false, msg + " (did not throw)"); }
    catch (e) { assert(true, msg + ` — "${e.message.slice(0, 60)}"`); }
  };
  assert(gbc.validateConfig({}).configured === false, "missing config degrades to unconfigured");
  throws(() => gbc.validateConfig({ configured: true }), "configured:true without credentials rejected");
  const cfg = gbc.validateConfig({
    configured: true, clientId: "cid", authorizeUrl: "https://coned.example/authorize",
    apiBase: "https://api.example", scopes: ["FB=4_5_6"]
  });
  assert(cfg.configured === true, "complete config validates as configured");
  assert(cfg.intervalFeedPath === gbc.DEFAULT_PATHS.intervalFeedPath,
    "ESPI path templates default when the config omits them");

  // authorization request
  assert(/^[0-9a-f]{32}$/.test(gbc.randomState()), "randomState is 128-bit hex");
  throws(() => gbc.authorizeUrl(gbc.validateConfig({}), "s", "r/"),
    "authorizeUrl refuses an unconfigured deployment");
  const aUrl = new URL(gbc.authorizeUrl(cfg, "st4te", "https://site.example/"));
  assert(aUrl.searchParams.get("response_type") === "code", "authorize request is response_type=code");
  assert(aUrl.searchParams.get("client_id") === "cid" &&
    aUrl.searchParams.get("redirect_uri") === "https://site.example/" &&
    aUrl.searchParams.get("state") === "st4te" &&
    aUrl.searchParams.get("scope") === "FB=4_5_6",
    "authorize request carries client_id, redirect_uri, state, scope");
  assert(gbc.buildRedirectUri({ origin: "https://coned.jedarden.com" }) === "https://coned.jedarden.com/",
    "redirect URI is the registered site root");

  // callback validation (code/state/error; state mismatch = CSRF)
  const cb = gbc.parseCallback("?code=c1&state=st4te", "st4te");
  assert(cb.ok === true && cb.code === "c1", "valid callback accepted");
  assert(gbc.parseCallback("?code=c1&state=zzz", "st4te").error === "state_mismatch",
    "mismatched state rejected (CSRF guard)");
  assert(gbc.parseCallback("?state=st4te", "st4te").error === "missing_code", "codeless callback rejected");
  const denied = gbc.parseCallback("?error=access_denied", "st4te");
  assert(denied.ok === false && denied.error === "access_denied", "OAuth error callback surfaced");
  assert(/declined/.test(gbc.friendlyError(denied)), "OAuth errors map to friendly copy");

  // connection store (sessionStorage shim) + freshness
  const conn = { accessToken: "tok", tokenType: "Bearer", expiresAt: Date.now() + 3600e3 };
  const s1 = shim();
  gbc.saveConnection(conn, s1);
  assert(gbc.loadConnection(s1).accessToken === "tok", "connection round-trips through the store");
  assert(gbc.connectionIsFresh(conn, Date.now()), "fresh connection detected");
  assert(!gbc.connectionIsFresh({ accessToken: "tok", expiresAt: Date.now() + 10e3 }, Date.now()),
    "connection inside the 30s safety margin is not fresh");
  gbc.clearConnection(s1);
  assert(gbc.loadConnection(s1) === null, "clearConnection removes the stored connection");

  // ESPI feed walk helpers
  const miniFeed = `<feed xmlns="http://www.w3.org/2005/Atom">
    <id>https://api.example/espi/1_1/resource/Subscription</id>
    <entry><id>https://api.example/espi/1_1/resource/Subscription/77</id></entry>
    <entry><espi:id>https://api.example/espi/1_1/resource/Subscription/78</espi:id></entry>
  </feed>`;
  const ids = gbc.extractEntryIds(miniFeed);
  assert(ids.length === 2 && gbc.resourceIdOf(ids[0]) === "77",
    "extractEntryIds takes entry ids only (feed id excluded), prefix-tolerant");
  assert(gbc.resourceIdOf("https://api.example/x/UsagePoint/9") === "9", "resourceIdOf takes the last path segment");
  assert(gbc.expandPath("/Subscription/{subscription}/UsagePoint", { subscription: "77" }) === "/Subscription/77/UsagePoint",
    "expandPath substitutes ids into path templates");
  throws(() => gbc.expandPath("/UsagePoint/{usagePoint}", {}), "expandPath refuses a missing id");
  assert(JSON.stringify(gbc.parseCallback({}, "x")) === JSON.stringify({ ok: false, error: "missing_code", errorDescription: "no authorization code in the callback" }),
    "object-form query (URLSearchParams-free callers) behaves like the string form");

  console.log("");
} catch (e) {
  console.log(`  ✗ Green Button Connect core tests failed: ${e.message}`);
  testsFailed++;
  console.log("");
}

// Summary (printed after the async format tests finish)
function printSummary() {
  console.log("Test Results:");
  console.log(`  Passed: ${testsPassed}`);
  console.log(`  Failed: ${testsFailed}`);
  console.log(`  Total:  ${testsPassed + testsFailed}`);
  console.log("");

  if (testsFailed > 0) {
    process.exit(1);
  } else {
    console.log("All tests passed! ✓");
    process.exit(0);
  }
}

runFormatTests().then(printSummary).catch((e) => {
  console.log(`  ✗ Async test runner crashed: ${e.message}`);
  printSummary();
});
