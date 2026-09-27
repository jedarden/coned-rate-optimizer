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
    assert(calc.RATES.meta.version === "1.7.0", `Rate model version bumped (v${calc.RATES.meta.version})`);
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
