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
    assert(calc.RATES.meta.version === "1.10.0", `Rate model version bumped (v${calc.RATES.meta.version})`);
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

  // Test 13b: fixture-driven eligibility/lock-in regression matrix. Every case
  // partitions the modeled inventory into eligible and excluded plans, then
  // checks that eligible alternatives still have a real priced comparison entry.
  console.log("Test 13b: Eligibility & lock-in regression matrix");
  try {
    const matrix = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/eligibility-lock-in-matrix.json"), "utf8"));
    const allPlanKeys = ["standard", "tou", "steady", "smart"];
    const ratesJson = JSON.parse(fs.readFileSync(path.join(__dirname, "../public/rates.json"), "utf8"));

    assert(calc.RATES.meta.switchTiming.includes(matrix.policy.switchTimingIncludes),
      "switch timing policy says enrollment takes effect with a future meter read");
    Object.keys(matrix.policy.lockIn).forEach((key) => {
      const expected = matrix.policy.lockIn[key];
      const actual = calc.RATES[key].lockIn;
      if (expected === null) {
        assert(actual === null, `${key} has no lock-in policy`);
        return;
      }
      Object.keys(expected).forEach((field) => {
        if (field === "noteIncludes") return;
        assert(actual && actual[field] === expected[field], `${key} lock-in ${field} is ${expected[field]}`);
      });
      (expected.noteIncludes || []).forEach((phrase) => {
        assert(actual && actual.note.includes(phrase), `${key} lock-in note documents "${phrase}"`);
      });
      assert(JSON.stringify(actual) === JSON.stringify(ratesJson[key].lockIn),
        `${key} lock-in policy remains mirrored in rates.json`);
    });

    const parsed = calc.parseGreenButton(fs.readFileSync(path.join(__dirname, "fixtures/sample-greenbutton.csv"), "utf8"));
    const monthsOnly = { months: parsed.months, ndays: parsed.ndays };
    matrix.cases.forEach((fixture) => {
      const input = fixture.input === "months-only" ? monthsOnly : parsed;
      const analysis = calc.analyze(input, { profile: fixture.profile });
      const verdicts = analysis.eligibility.verdicts;
      const expectedEligible = fixture.eligiblePlans.slice().sort();
      const expectedExcluded = Object.keys(fixture.excludedPlans || {}).sort();
      const actualEligible = allPlanKeys.filter((key) => verdicts[key].available).sort();
      assert(JSON.stringify(actualEligible) === JSON.stringify(expectedEligible),
        `${fixture.id}: eligible plan set matches the policy matrix`);
      assert(JSON.stringify(expectedExcluded) === JSON.stringify(allPlanKeys.filter((key) => !verdicts[key].available).sort()),
        `${fixture.id}: every ineligible plan is excluded`);
      assert(verdicts[fixture.currentPlan].current === true,
        `${fixture.id}: ${fixture.currentPlan} is the declared current plan`);
      if (fixture.currentPlanUnpriced) {
        assert(analysis.currentPlanPriced === false && !analysis.plans.some((plan) => plan.current),
          `${fixture.id}: an unpriceable current plan is not substituted into the priced inventory`);
        assert(analysis.switchTarget === null && analysis.savingsIfSwitch === 0,
          `${fixture.id}: an unpriceable current plan cannot produce valid savings`);
      } else {
        assert(analysis.plans.find((plan) => plan.current).key === fixture.currentPlan,
          `${fixture.id}: analysis carries the declared current plan`);
      }

      (fixture.blockers || []).forEach((phrase) => {
        assert(analysis.eligibility.blockers.some((note) => note.includes(phrase)),
          `${fixture.id}: blocker documents "${phrase}"`);
      });
      (fixture.globalNotes || []).forEach((phrase) => {
        assert(analysis.eligibility.notes.some((note) => note.includes(phrase)),
          `${fixture.id}: global note documents "${phrase}"`);
      });
      Object.keys(fixture.planNotes || {}).forEach((key) => {
        const notes = verdicts[key].notes.join(" ");
        fixture.planNotes[key].forEach((phrase) => {
          assert(notes.includes(phrase), `${fixture.id}: ${key} note documents "${phrase}"`);
        });
      });
      Object.keys(fixture.planNotesAbsent || {}).forEach((key) => {
        const notes = verdicts[key].notes.join(" ");
        fixture.planNotesAbsent[key].forEach((phrase) => {
          assert(!notes.includes(phrase), `${fixture.id}: ${key} omits "${phrase}" when not applicable`);
        });
      });

      allPlanKeys.forEach((key) => {
        const verdict = verdicts[key];
        const plan = analysis.plans.find((item) => item.key === key);
        const comparison = analysis.comparison.find((item) => item.key === key);
        if (fixture.excludedPlans && fixture.excludedPlans[key]) {
          assert(!verdict.available && verdict.reason.includes(fixture.excludedPlans[key]),
            `${fixture.id}: ${key} exclusion reason is documented ("${verdict.reason}")`);
          if (plan) assert(plan.avail === false && plan.excludedReason.includes(fixture.excludedPlans[key]),
            `${fixture.id}: ${key} priced output carries its exclusion reason`);
          if (comparison) assert(comparison.avail === false && comparison.excludedReason.includes(fixture.excludedPlans[key]),
            `${fixture.id}: ${key} comparison carries its exclusion reason`);
          return;
        }
        assert(verdict.available, `${fixture.id}: ${key} remains eligible`);
        if (plan) assert(plan.avail === true && Number.isFinite(plan.cost) && plan.cost > 0,
          `${fixture.id}: eligible ${key} plan is priced`);
        if (comparison) assert(comparison.avail === true && Number.isFinite(comparison.annualCost) && comparison.annualCost > 0,
          `${fixture.id}: eligible ${key} alternative has an annual price`);
      });
      analysis.dashboard.rows.forEach((row) => {
        assert(!row.bestKey || expectedEligible.includes(row.bestKey),
          `${fixture.id}: dashboard savings only use an eligible plan (${row.bestKey || "none"})`);
      });

      const alternatives = expectedEligible.filter((key) => key !== fixture.currentPlan);
      if (fixture.currentPlanUnpriced) {
        assert(analysis.eligibility.blockers.length > 0,
          `${fixture.id}: missing current-plan data blocks the recommendation`);
      } else if (alternatives.length) {
        assert(analysis.switchTarget && alternatives.includes(analysis.switchTarget.key),
          `${fixture.id}: switch target is an eligible alternative`);
        assert(analysis.switchTarget.key !== fixture.currentPlan,
          `${fixture.id}: current plan is never a switch target`);
      } else {
        assert(analysis.switchTarget === null, `${fixture.id}: no alternative is offered when none is eligible`);
      }
      if (fixture.timingCase) {
        assert(calc.RATES.meta.switchTiming.includes("future meter read"),
          `${fixture.id}: enrollment timing is retained in the published policy`);
        assert(calc.RATES.tou.peakSummer > calc.RATES.tou.peakWinter,
          `${fixture.id}: TOU summer peak pricing is higher than the rest-of-year rate`);
      }
    });

    const normalized = calc.checkEligibility({
      currentPlan: "steadyUse", solar: "false", esco: "true", heatPump: "0"
    }, { hasDemand: true });
    assert(normalized.profile.currentPlan === "steady" && normalized.profile.solar === false &&
           normalized.profile.esco === true && normalized.profile.heatPump === false,
      "eligibility profile normalization accepts plan aliases and does not treat string false as true");
    const mappedHistory = calc.checkEligibility({
      planHistory: { monthsSinceOptOut: { tou: "6" } }
    }, { hasDemand: true });
    assert(mappedHistory.profile.planHistory.monthsSinceOptOut.tou === 6 &&
           mappedHistory.verdicts.tou.available === false &&
           mappedHistory.verdicts.tou.reason.includes("18 months"),
      "plan-history normalization accepts per-plan opt-out ages and exposes the re-enrollment reason");
    console.log("");
  } catch (e) {
    console.log(`  ✗ Eligibility matrix tests failed: ${e.message}`);
    testsFailed++;
    console.log("");
  }

  // Test 14: bill reconstruction — the engine must reproduce ConEd's real published
  // bill history (test/fixtures/bill-history-sc1-nyc.json) before any counterfactual
  // built on it can be trusted (docs/product-strategy.md, "Historical backtest").
  console.log("Test 14: Bill reconstruction vs published bill history");
  try {
    const fx = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/bill-history-sc1-nyc.json"), "utf8"));
    const generated = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/bill-reconstruction-tests.json"), "utf8"));
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
    assert(generated.sampleKwh === fx.sampleKwh &&
      generated.cases.length === yearKeys.length &&
      generated.cases.every((c) => yearKeys.includes(String(c.year))),
      "generated reconstruction cases cover every published fixture period");

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
      const generatedCase = generated.cases.find((c) => c.year === y);
      assert(generatedCase, `${y}: generated reconstruction case exists`);
      const rec = calc.reconstructBill({ kwh: fx.sampleKwh, year: y }, { includeCustomerCharge: false });
      assert(rec.ratePeriod.year === y && rec.projected === false,
        `${y}: prices at its own published period (not projected)`);
      ["delivery", "commodity", "mac", "rdm", "surcharges"].forEach((c) => {
        assertClose(rec.components[c], generatedCase.expected[c], 5e-3,
          `${y}: reconstructed ${c} matches the generated published line`);
        assertClose(generatedCase.expected[c], pub.bill[c], 5e-3,
          `${y}: generated ${c} line matches the source fixture`);
      });
      assertClose(rec.total, generatedCase.expected.total, 5e-3,
        `${y}: reconstructed bill matches the generated published $${pub.bill.total.toFixed(2)}`);
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
    "clearConnection", "connectionIsFresh", "apiGet", "apiGetPages", "extractEntryIds", "extractNextLink", "mergeAtomPages", "connect", "refreshFeeds"]) {
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
    apiBase: "https://api.example", redirectUri: "https://site.example/", scopes: ["FB=4_5_6"]
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
  assert(gbc.buildRedirectUri({ origin: "https://site.example" }, cfg.redirectUri) === "https://site.example/",
    "configured redirect URI is used when it matches the site root");
  throws(() => gbc.buildRedirectUri({ origin: "https://other.example" }, cfg.redirectUri),
    "registered redirect URI cannot point at another origin");

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
  assert(gbc.extractNextLink('<feed><atom:link rel="next" href="/page-2?x=1&amp;y=2"/></feed>') === "/page-2?x=1&y=2",
    "extractNextLink accepts prefixed Atom links and decodes href entities");
  assert(gbc.mergeAtomPages(["<feed><entry><id>a</id></entry></feed>", "<feed><entry><id>b</id></entry></feed>"]).indexOf("<id>b</id>") >= 0,
    "mergeAtomPages combines page entries into one feed");
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

// Test 18: month-over-month dashboard — the per-period actual-vs-best table over
// analyze(), and the exact calendar/usage/rate/fixed change decomposition behind
// each row's "why did it change" (docs/product-strategy.md, "Month-over-month
// experience").
console.log("Test 18: Month-over-month dashboard & change decomposition");
try {
  // Self-sufficient rate state (earlier tests mutate RATES).
  calc.applyRates(JSON.parse(fs.readFileSync(path.join(__dirname, "../public/rates.json"), "utf8")));
  const billPeriods = calc.RATES.bill.periods;
  const rateOf = (y) => billPeriods.find((q) => q.year === y);
  const varRate = (y) => { const p = rateOf(y); return p.delivery + p.commodity + p.mac + p.rdm + p.surcharges; };

  // ---- decomposeChange: exact, no residual, sensible components ----
  // Hand case: 300 kWh over 30 days → 372 kWh over 31 days at a flat rate.
  const fixed = 16.33, rate = 0.30;
  const A = { kwh: 300, days: 30, total: 300 * rate + fixed, fixed };
  const B = { kwh: 372, days: 31, total: 372 * rate + fixed, fixed };
  const mom = calc.decomposeChange(A, B);
  assertClose(mom.calendar, (31 - 30) * (300 / 30) * rate, 1e-9,
    "calendar effect = extra billed days × prior daily usage × prior rate");
  assertClose(mom.usage, 31 * (372 / 31 - 300 / 30) * rate, 1e-9,
    "usage effect = day-weighted daily-usage change at the prior rate");
  assertClose(mom.rate, 0, 1e-9, "rate effect is zero when the rate is flat");
  assertClose(mom.fixed, 0, 1e-9, "fixed effect is zero when the customer charge is unchanged");
  assertClose(mom.calendar + mom.usage + mom.rate + mom.fixed, B.total - A.total, 1e-9,
    "components sum exactly to the total change (no residual)");
  assertClose(mom.total, 21.6, 1e-9, "hand case total change is $21.60");

  // Rate-only change: same usage, same days, the rate moves.
  const C2 = { kwh: 372, days: 31, total: 372 * 0.32 + fixed, fixed };
  const momRate = calc.decomposeChange(B, C2);
  assertClose(momRate.usage + momRate.calendar, 0, 1e-9, "flat usage puts nothing on calendar or usage");
  assertClose(momRate.rate, 0.02 * 372, 1e-9, "rate effect = Δrate × the later period's usage");

  // Property sweep — includes a zero-usage side (no divide-by-zero), a prorated
  // customer charge, and missing day counts: the parts always sum to Δtotal.
  [[300, 30, 372, 31, 16.33, 0.30, 0.30],
   [100, 28, 0, 31, 16.33, 0.25, 0.25],
   [0, 31, 50, 28, 0, 0.2, 0.21],
   [500, 31, 450, 30, 16.33, 0.28, 0.33],
   [1, 1, 999, 31, 0, 0.15, 0.4]].forEach((t, i) => {
    const a = { kwh: t[0], days: t[1], total: t[0] * t[5] + t[4], fixed: t[4] };
    const b = { kwh: t[2], days: t[3], total: t[2] * t[6] + t[4] + (i === 3 ? 8 : 0), fixed: t[4] + (i === 3 ? 8 : 0) };
    const m = calc.decomposeChange(a, b);
    assertClose(m.calendar + m.usage + m.rate + m.fixed, b.total - a.total, 1e-9,
      `sweep #${i + 1}: components sum to Δtotal`);
  });
  const noDays = calc.decomposeChange({ kwh: 10, total: 3, fixed: 0 }, { kwh: 10, total: 4, fixed: 0 });
  assertClose(noDays.rate, 1, 1e-9, "missing day counts fall back to a 1-day span (pure rate change)");

  // ---- rateDriver: names the published component behind a schedule change ----
  assert(calc.rateDriver(2025, 2026) === null, "2026 prices at the 2025 schedule — no rate driver across that boundary");
  const compDelta = (k) => rateOf(2025)[k] - rateOf(2024)[k];
  const biggest = ["delivery", "commodity", "mac", "rdm", "surcharges"]
    .reduce((x, y) => (Math.abs(compDelta(y)) > Math.abs(compDelta(x)) ? y : x));
  const drv = calc.rateDriver(2024, 2025);
  assert(drv.component === biggest && Math.abs(drv.delta - compDelta(biggest)) < 1e-12,
    `rate driver is the largest component move (${drv.component} ${(drv.delta * 100).toFixed(3)}¢/kWh)`);

  // ---- month buckets carry observed day counts; periodsFrom normalizes ----
  const csvText = fs.readFileSync(path.join(__dirname, "fixtures/sample-greenbutton.csv"), "utf8");
  const parsed = calc.parseGreenButton(csvText);
  assert(parsed.months[0].ndays === 2 && parsed.months[1].ndays === 1,
    `month buckets count observed days (got ${parsed.months.map((m) => m.ndays).join(", ")})`);
  const pers = calc.periodsFrom(parsed);
  assert(pers.length === 2 && pers[0].days === 2 && pers[1].days === 1,
    "periodsFrom exposes observed days as the period's day count");
  assert(pers[0].hours && pers[0].hours.length === 48, "periodsFrom buckets each period's hours");
  const feb = calc.periodsFrom({ months: [{ ym: "2026-02", month: 2, total: 100, peak: 60, off: 40, summer: false }] })[0];
  assert(feb.days === 28 && feb.observedDays === 0,
    "months-only input falls back to calendar days (2026-02 → 28) and claims no observed days");
  assert(calc.daysInMonth("2024-02") === 29 && calc.daysInMonth("2023-02") === 28,
    "daysInMonth handles leap years");

  // ---- pricePeriod: single-period slices that sum to the window models ----
  ["standard", "tou"].forEach((k) => {
    const per = parsed.months.reduce((s, m) => s + calc.pricePeriod(calc.periodsFrom({ months: [m] })[0], k).total, 0);
    const whole = k === "standard" ? calc.costStandard(parsed.months).total : calc.costTOU(parsed.months).total;
    assertClose(per, whole, 1e-9, `per-period ${k} slices sum to the whole-window ${k} cost`);
  });
  const touSlice = calc.pricePeriod(pers[0], "tou", { smartChargeNY: true });
  assertClose(touSlice.total, calc.costTOU([parsed.months[0]], { smartChargeNY: true }).total, 1e-9,
    "options (EV what-if) pass through to the TOU slice");
  ["steady", "smart"].forEach((k) => {
    const per = pers.reduce((s, p) => s + calc.pricePeriod(p, k).total, 0);
    const plan = k === "steady" ? calc.RATES.steadyUse : calc.RATES.smartEnergy;
    assertClose(per, calc.costDemand(parsed.hours, plan).total, 1e-9,
      `per-period ${k} slices sum to costDemand over all hours`);
  });
  assert(calc.pricePeriod({ kwh: 100, days: 30 }, "steady") === null,
    "demand plans are unpriceable without that period's hours");

  // ---- the dashboard over a real analysis ----
  const a = calc.analyze(parsed);
  const d = a.dashboard;
  assert(d && Array.isArray(d.rows) && d.rows.length === 2, "analyze() carries a per-period dashboard");
  const eligKeys = a.comparison.filter((e) => e.avail).map((e) => e.key);
  d.rows.forEach((r, i) => {
    assertClose(r.difference, r.actual.total - r.best.total, 1e-9, `${r.ym}: difference = actual − best`);
    eligKeys.forEach((k) => {
      const c = calc.pricePeriod(pers[i], k);
      if (c) assert(r.best.total <= c.total + 1e-9, `${r.ym}: best is the cheapest eligible plan (beats ${k})`);
    });
    if (r.mom) assertClose(r.mom.calendar + r.mom.usage + r.mom.rate + r.mom.fixed,
      r.actual.total - d.rows[i - 1].actual.total, 1e-9, `${r.ym}: MoM parts sum to the actual-charge change`);
  });
  assertClose(d.actualTotal, d.rows.reduce((s, r) => s + r.actual.total, 0), 1e-9,
    "dashboard totals equal the sum of the rows");
  assert(d.rows[0].mom === null && d.rows[1].mom !== null,
    "the first period has no month-over-month row; later ones do");
  assert(d.rows[0].partial === true, "a 2-of-30-day bucket is flagged a partial period");
  assertClose(d.rows[0].actual.total, calc.reconstructBill({ kwh: parsed.months[0].total, year: 2025 }).total, 1e-9,
    "a Standard-current home's actual is the reconstructed bill");

  // current plan other than Standard: actual is modeled, not reconstructed
  const aTou = calc.analyze(parsed, { profile: { currentPlan: "tou" } });
  const touRow = aTou.dashboard.rows[0];
  assert(touRow.actual.plan === "tou" && !touRow.actual.reconstructed,
    "a TOU-current home's actual is modeled on TOU, not Standard-reconstructed");
  assertClose(touRow.actual.total, calc.costTOU([parsed.months[0]]).total, 1e-9,
    "the modeled actual matches costTOU's single-period slice");

  // ---- a rate step: months straddling the 2024→2025 schedule ----
  const stepMonths = [
    { ym: "2024-11", month: 11, total: 400, peak: 300, off: 100, summer: false },
    { ym: "2024-12", month: 12, total: 420, peak: 310, off: 110, summer: false },
    { ym: "2025-01", month: 1, total: 390, peak: 290, off: 100, summer: false }
  ];
  const dStep = calc.analyze({ months: stepMonths, ndays: 92 }).dashboard;
  assert(dStep.rows.length === 3, "three periods in, three rows out");
  assertClose(dStep.rows[0].actual.total, calc.reconstructBill({ kwh: 400, year: 2024 }).total, 1e-9,
    "2024 usage prices at the 2024 published schedule");
  assert(dStep.rows[1].rateDriver === null, "within one schedule there is no named rate driver");
  const boundary = dStep.rows[2];
  assert(!!boundary.rateDriver, "crossing the 2024→2025 boundary names a rate driver");
  assertClose(boundary.mom.rate, (varRate(2025) - varRate(2024)) * 390, 1e-9,
    "rate effect = Δ published $/kWh × the later period's usage");
  assert(dStep.rows[2].projected === false, "a 2025 period is not projected");

  // Same usage and day count across the boundary: calendar and usage cancel and
  // the whole change is the rate effect.
  const flat = [
    { ym: "2024-12", month: 12, total: 300, peak: 200, off: 100, summer: false },
    { ym: "2025-01", month: 1, total: 300, peak: 200, off: 100, summer: false }
  ];
  const dFlat = calc.analyze({ months: flat, ndays: 62 }).dashboard;
  const flatMom = dFlat.rows[1].mom;
  assertClose(flatMom.calendar, 0, 1e-9, "equal day counts put nothing on the calendar effect");
  assertClose(flatMom.usage, 0, 1e-9, "equal usage puts nothing on the usage effect");
  assertClose(flatMom.rate, (varRate(2025) - varRate(2024)) * 300, 1e-9, "the whole change is the rate effect");
  assertClose(flatMom.total, flatMom.rate, 1e-9, "rate-only change sums to its rate effect");

  // A 2026 month prices at the 2025 schedule and is flagged projected.
  const dProj = calc.analyze({ months: [
    { ym: "2025-12", month: 12, total: 300, peak: 200, off: 100, summer: false },
    { ym: "2026-01", month: 1, total: 310, peak: 205, off: 105, summer: false }
  ], ndays: 62 }).dashboard;
  assert(dProj.rows[1].projected === true && dProj.rows[0].projected === false,
    "2026 months carry the projected-rates flag");
  assert(dProj.rows[1].rateDriver === null, "2025→2026 shows no rate driver (same published schedule)");

  // ---- the built-in sample (months-only, 13 buckets) end to end ----
  global.window = {};
  require("../public/sample.js");
  const sample = global.window.CONED_SAMPLE;
  const aS = calc.analyze({ months: sample.months, ndays: sample.ndays });
  assert(aS.dashboard.rows.length === 13 && aS.dashboard.rows.every((r) => r.actual && r.best),
    "sample dashboard prices all 13 monthly rows");
  assert(aS.dashboard.rows.every((r) => r.observedDays === 0 && !r.partial),
    "months-only rows claim no observed days and no partial flags");
  assert(aS.dashboard.rows[12].mom !== null && aS.dashboard.rows[0].mom === null,
    "sample MoM chain starts at the second row");
  assertClose(aS.dashboard.rows.reduce((s, r) => s + r.actual.total, 0), aS.dashboard.actualTotal, 1e-9,
    "sample dashboard totals reconcile with its rows");

  console.log("");
} catch (e) {
  console.log(`  ✗ Dashboard/decomposition tests failed: ${e.message}`);
  testsFailed++;
  console.log("");
}

// Test 19: billing-feed import, bill replay & confidence gating — actual bills (the
// Green Button Connect billing feed) are reconstructed at published rates and
// reconciled against what the customer actually paid; the outcome gates the confidence
// the verdict may claim (docs/product-strategy.md, "Accuracy gate" + free result).
console.log("Test 19: Billing-feed import, bill replay & confidence gating");
try {
  const DPM = 30.4375; // calc.js's DAYS_PER_MONTH — the customer-charge proration basis

  // -- parseBillingESPI: the sandbox's GBCMD shape (Atom entries, epoch dates, cents) --
  const sandboxShape = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>urn:usage-summary:301</id>
    <content>
      <UsageSummary xmlns="http://naesb.org/espi">
        <billingPeriod><start>1750353600</start><end>1752945600</end></billingPeriod>
        <cost><currency>USD</currency><value>11245</value></cost>
      </UsageSummary>
    </content>
  </entry>
</feed>`;
  const prefixedShape = sandboxShape.replace(/<(\/?)(entry|id|content|billingPeriod|start|end|cost|currency|value|UsageSummary)(?=[\s>])/g, "<$1espi:$2");
  const bp = calc.parseBillingESPI(sandboxShape);
  assert(bp.bills.length === 1 && bp.incomplete.length === 0, "sandbox billing feed parses one summary");
  assertClose(bp.bills[0].cost, 112.45, 1e-9, "cost converts from ESPI minor units (11245 → $112.45)");
  assert(bp.bills[0].days === 30 && bp.bills[0].ymdStart === 20250619 && bp.bills[0].ymdEnd === 20250719,
    `epoch billingPeriod resolves to NY-local calendar dates (${bp.bills[0].ymdStart}–${bp.bills[0].ymdEnd}, ${bp.bills[0].days}d)`);
  assert(calc.parseBillingESPI(prefixedShape).bills.length === 1, "a namespace-prefixed feed parses identically");

  const isoShape = sandboxShape
    .replace("<start>1750353600</start>", "<start>2025-03-05</start>")
    .replace("<end>1752945600</end>", "<end>2025-04-04</end>");
  const bpIso = calc.parseBillingESPI(isoShape);
  assert(bpIso.bills[0].days === 30 && bpIso.bills[0].ymdStart === 20250305,
    "ISO-date billing periods parse to the same shape as epoch ones");

  const noTotal = calc.parseBillingESPI(sandboxShape.replace(/<cost>[\s\S]*?<\/cost>/, ""));
  assert(noTotal.bills.length === 0 && noTotal.incomplete.length === 1 && noTotal.incomplete[0].reason === "no bill total",
    `a summary without a total is named incomplete ("${noTotal.incomplete[0].reason}")`);
  const backwards = calc.parseBillingESPI(isoShape.replace("<start>2025-03-05</start>", "<start>2025-04-04</start>")
    .replace("<end>2025-04-04</end>", "<end>2025-03-05</end>"));
  assert(backwards.incomplete[0].reason === "billing period ends before it starts", "an inverted period is rejected");
  const eur = calc.parseBillingESPI(isoShape.replace("<currency>USD</currency>", "<currency>EUR</currency>"));
  assert(eur.bills.length === 0 && eur.incomplete.length === 1 && /unsupported currency EUR/.test(eur.incomplete[0].reason),
    `a non-USD summary can't poison a USD gate ("${eur.incomplete[0].reason}")`);
  try { calc.parseBillingESPI("<feed><entry><id>x</id><content><title>no summaries here</title></content></entry></feed>"); assert(false, "feed without UsageSummaries should throw"); }
  catch (err) { assert(err.message.includes("UsageSummary"), `non-billing feed rejected: "${err.message.slice(0, 52)}…"`); }

  // -- normalizeBills: minimal { start, end, cost } objects, unusable ones named --
  const nb = calc.normalizeBills([
    { start: "2025-06-01", end: "2025-07-01", cost: 120 },
    { start: "2025-07-01", end: "2025-08-01" },
    { start: "2025-08-01", end: "2025-07-01", cost: 5 },
    "junk"
  ]);
  assert(nb.bills.length === 1 && nb.bills[0].days === 30 && nb.bills[0].label === "Jun 1 – Jul 1, 2025",
    `minimal bill objects normalize with day counts & labels ("${nb.bills[0].label}")`);
  assert(nb.incomplete.length === 2 && nb.incomplete.some((i) => i.reason === "missing period or total") &&
    nb.incomplete.some((i) => i.reason === "ends before it starts"), "unusable bills are named, never dropped");

  // -- reconcileBills: interval-supported bills replay against the model; coverage gaps excluded --
  const hours = [];
  for (let d = 1; d <= 30; d++) hours.push({ ym: "2025-06", mo: 6, day: d, hour: 12, weekday: new Date(Date.UTC(2025, 5, d)).getUTCDay(), kwh: 10 });
  const parsedJun = { months: [{ ym: "2025-06", ndays: 30 }], hours };
  const modeledJun = calc.reconstructBill({ kwh: 300, year: 2025, months: 30 / DPM });
  const juneBill = { start: "2025-06-01", end: "2025-07-01", cost: modeledJun.total, label: "June bill" };

  const good = calc.reconcileBills(parsedJun, [juneBill]);
  assert(good.rows.length === 1 && good.rows[0].supported === true, "a bill with interval coverage is checked");
  assertClose(good.rows[0].kwh, 300, 1e-9, "the bill's kWh come from the interval data (10 × 30 days)");
  assert(good.rows[0].band === "pass" && good.gate.gate === "pass",
    `exact reconstruction passes the gate (${(good.rows[0].pctError).toFixed(4)}% error)`);

  const bad10 = calc.reconcileBills(parsedJun, [Object.assign({}, juneBill, { cost: modeledJun.total * 1.10 })]);
  assert(bad10.rows.length === 1 && bad10.rows[0].band === "fail" && bad10.gate.gate === "fail",
    `a ${(bad10.rows[0].pctError).toFixed(1)}% miss fails the gate outright`);
  assert(bad10.gate.failures.length === 1 && bad10.gate.failures[0].label === "June bill", "the miss is named, never averaged away");

  const sepOnly = [{ start: "2025-09-01", end: "2025-10-01", cost: 100, label: "September bill" }];
  const mixed = calc.reconcileBills(parsedJun, [juneBill, sepOnly[0]]);
  assert(mixed.rows.length === 1 && mixed.unsupported.length === 1, "bills without interval coverage are excluded, not priced on invented usage");
  assert(mixed.unsupported[0].reason.includes("0 of 30 days"), `the coverage shortfall is stated ("${mixed.unsupported[0].reason}")`);
  const none = calc.reconcileBills(parsedJun, sepOnly);
  assert(none.rows.length === 0 && none.unsupported.length === 1 && none.gate === null, "nothing checkable → no gate (unverified ≠ failed)");

  // -- auditDataQuality: missing months, truncated months, holes in the bill chain --
  const dq = calc.auditDataQuality(
    { months: [{ ym: "2025-06", ndays: 30 }, { ym: "2025-08", ndays: 4 }], hours },
    [juneBill, sepOnly[0]]);
  assert(dq.missingMonths.join(",") === "2025-07", "a gap between export months is a missing month");
  assert(dq.partialMonths.join(",") === "2025-08", `a truncated month is flagged partial (4 of 31 days)`);
  assert(dq.billGaps.length === 1 && dq.billGaps[0].days === 62,
    `62 days between adjacent bills is a missing bill, named on both sides ("${dq.billGaps[0].after}" → "${dq.billGaps[0].before}")`);
  assert(dq.incompleteBills.length === 0, "usable bills carry no incomplete entries");

  // -- assessConfidence: the strategy's "calculation confidence and missing-data warnings" --
  const cleanAudit = { missingMonths: [], billGaps: [], incompleteBills: [] };
  const high = calc.assessConfidence({ reconciliation: good, audit: cleanAudit, hasHours: true, ndays: 365, profile: { territory: "nyc", currentPlan: "standard" } });
  assert(high.level === "high" && high.reasons[0].includes("95% accuracy gate"),
    `a passed gate reads as verified ("${high.reasons[0].slice(0, 64)}…")`);

  const unverified = calc.assessConfidence({ reconciliation: { complete: 0, incomplete: [], rows: [], unsupported: [], gate: null }, audit: cleanAudit, hasHours: true, ndays: 365, profile: {} });
  assert(unverified.level === "medium" && unverified.reasons[0].includes("no actual bills"), "no bills → medium, with the verify path named");

  const disagreement = calc.assessConfidence({ reconciliation: bad10, audit: cleanAudit, hasHours: true, ndays: 365, profile: {} });
  assert(disagreement.level === "low" && disagreement.reasons[0].includes("the model missed"),
    `a failed gate reads as low confidence ("${disagreement.reasons[0].slice(0, 56)}…")`);

  const partialCov = calc.assessConfidence({ reconciliation: good, audit: cleanAudit, hasHours: true, ndays: 365, profile: {} });
  assert(partialCov.level === "high", "an unsupported bill alongside a passed gate only warns, not downgrades the verified set");
  const warned = calc.assessConfidence({ reconciliation: mixed, audit: cleanAudit, hasHours: true, ndays: 365, profile: {} });
  assert(warned.level === "medium" && warned.reasons.some((r) => r.includes("couldn't be checked")),
    "an uncovered bill downgrades a passed gate and says which");

  const westchester = calc.assessConfidence({ reconciliation: good, audit: cleanAudit, hasHours: true, ndays: 365, profile: { territory: "westchester" } });
  assert(westchester.level === "medium" && westchester.reasons.some((r) => r.includes("NYC rates")), "Westchester pricing is a named downgrade");
  const monthly = calc.assessConfidence({ reconciliation: good, audit: cleanAudit, hasHours: false, ndays: 365, profile: {} });
  assert(monthly.level === "medium" && monthly.reasons.some((r) => r.includes("monthly totals only")), "monthly-only data can't check the load shape — named");
  const multi = calc.assessConfidence({ reconciliation: good, audit: { missingMonths: ["2025-07"], billGaps: [], incompleteBills: [] }, hasHours: true, ndays: 200, profile: {} });
  assert(multi.level === "medium" && multi.reasons.some((r) => r.includes("2025-07")) && multi.reasons.some((r) => r.includes("200 days")),
    "every downgrade is listed, not just the first");

  // -- analyze() end to end: confidence rides on the analysis result --
  const monthRow = { ym: "2025-06", month: 6, total: 300, peak: 270, off: 30, summer: true };
  const aNoBills = calc.analyze({ months: [monthRow], hours, ndays: 365 });
  assert(aNoBills.confidence.level === "medium" && aNoBills.confidence.reasons[0].includes("no actual bills"),
    "analyze() without billing history states its confidence as unverified");
  const aBills = calc.analyze({ months: [monthRow], hours, ndays: 365 }, { bills: [juneBill] });
  assert(aBills.confidence.level === "high", "analyze() with a reconciled bill states verified confidence");
  assert(aBills.reconciliation.rows.length === 1 && aBills.reconciliation.rows[0].label === "June bill",
    "analyze() exposes the per-bill reconciliation rows");
  assert(aBills.dataQuality.missingMonths.length === 0, "analyze() exposes the data-quality audit");
  const aSkipped = calc.analyze({ months: [monthRow], hours, ndays: 365 },
    { bills: [juneBill], profile: { currentPlan: "tou" } });
  assert(aSkipped.confidence.level === "medium" && aSkipped.reconciliation.gate === null && aSkipped.reconciliation.skipped,
    "non-Standard bills are skipped with the reason surfaced (reconstruction is Standard-basis)");

  console.log("");
} catch (e) {
  console.log(`  ✗ Billing-feed/confidence tests failed: ${e.message}`);
  testsFailed++;
  console.log("");
}

// Test 20: Paid conversion — the free-verdict-to-paid-result flow. The analysis is
// free and a no-savings result is never hidden behind payment: the $29 report is
// offered only when the projected first-year saving is real AND meaningful (measured
// at the LOW end of its uncertainty range), and a charge is taken only when the
// deployment is certified to charge at all.
console.log("Test 20: Paid conversion (offer gate, consent, payment flow, refunds)");
try {
  calc.applyRates(JSON.parse(fs.readFileSync(path.join(__dirname, "../public/rates.json"), "utf8")));
  const P = calc.RATES.pricing;
  assert(P.chargingCertified === false && P.providerCertified === false && P.provider && P.provider.id === "stripe-checkout",
    "this deployment ships with Stripe integrated but both charging certifications disabled: nothing can ever be charged");

  // -- savingsRange: the comparison's uncertainty is applied adversarially to both sides --
  const sr = calc.savingsRange(2000, 1800, 0.05);
  assertClose(sr.estimate, 200, 1e-9, "savingsRange's estimate is the plain difference");
  assertClose(sr.low, 2000 * 0.95 - 1800 * 1.05, 1e-9,
    "the low end prices the current plan at its cheap edge and the alternative at its dear one");
  assertClose(sr.high, 2000 * 1.05 - 1800 * 0.95, 1e-9, "the high end mirrors it");
  assert(sr.low < sr.estimate && sr.estimate < sr.high, "the range brackets the estimate");

  // -- paidConversion: every fork names its reason --
  const mkA = (over) => Object.assign({
    annualFactor: 1,
    plans: [
      { key: "standard", name: "Standard Residential", cost: 2000, current: true },
      { key: "tou", name: "Time-of-Use", cost: 1800 }
    ],
    switchTarget: { key: "tou", name: "Time-of-Use", cost: 1800 },
    eligibility: { blockers: [], notes: [] },
    confidence: { level: "high", reasons: [] }
  }, over || {});

  const none = calc.paidConversion(mkA({ switchTarget: null }));
  assert(none.eligible === false && none.offer === null && none.noSavings !== null,
    "no cheaper eligible plan lands on the honest no-savings fork, nothing hidden");
  assert(none.reasons[0].includes("nothing to sell"),
    `the no-savings reason says so outright ("${none.reasons[0].slice(0, 48)}…")`);

  const excludedTarget = calc.paidConversion(mkA({
    plans: [
      { key: "standard", name: "Standard Residential", cost: 2000, current: true, avail: true },
      { key: "tou", name: "Time-of-Use", cost: 900, avail: false, excludedReason: "not a ConEd account" }
    ],
    switchTarget: { key: "tou", name: "Time-of-Use", cost: 900 }
  }));
  assert(excludedTarget.eligible === false && excludedTarget.offer === null && excludedTarget.noSavings !== null,
    "the paid report gate refuses an excluded plan even when a stale target claims savings");

  const under = calc.paidConversion(mkA({}));
  assert(under.eligible === false && under.offer === null && under.noSavings === null,
    "a real but meaningless saving is neither offered nor dressed up as no-savings");
  assert(under.reasons[0].includes("under the $150/yr") && under.reasons[0].includes("range"),
    `the under-threshold reason quotes the estimate, its range, and the bar ("${under.reasons[0].slice(0, 52)}…")`);

  const exactFloor = mkA({ switchTarget: { key: "tou", name: "Time-of-Use", cost: 1666.6666666666667 } });
  const exact = calc.paidConversion(exactFloor);
  assert(exact.savings.low <= P.threshold && exact.eligible === false && exact.offer === null,
    "a savings floor exactly at $150 is not offered (the policy is strictly greater than the threshold)");

  const blocked = calc.paidConversion(mkA({ eligibility: { blockers: ["no smart meter"], notes: [] } }));
  assert(blocked.eligible === false && blocked.noSavings === null,
    "a blocked analysis offers nothing — and is not claimed as a no-savings result");
  assert(blocked.reasons[0].includes("blocked"), "the blocked reason names the block, not the savings");

  const distrust = calc.paidConversion(mkA({ switchTarget: { key: "tou", name: "Time-of-Use", cost: 1400 },
    confidence: { level: "low", reasons: [] } }));
  assert(distrust.eligible === false && distrust.offer === null,
    "a saving that clears the bar is still not offered against low confidence");
  assert(distrust.reasons[0].includes("disagrees"), "the low-confidence reason cites the model's disagreement with actual bills");

  const clear = mkA({ switchTarget: { key: "tou", name: "Time-of-Use", cost: 1400 } });
  const eligible = calc.paidConversion(clear);
  assert(eligible.eligible === true && eligible.offer !== null,
    "a meaningful saving on a trusted analysis earns the offer");
  assertClose(eligible.savings.low, 2000 * 0.95 - 1400 * 1.05, 1e-9,
    "the offer carries the pessimistic end it cleared the bar on");
  assert(eligible.offer.price === 29 && eligible.offer.currency === "usd" && eligible.offer.policyVersion === P.policyVersion,
    "the offer quotes the strategy's $29 report under the current policy version");
  assert(eligible.offer.includes.length === 6 && eligible.offer.includes[0] === "complete plan-by-plan comparison",
    "the offer's contents quote the strategy's paid-result list, never invented scope");
  assert(eligible.collectible === false && eligible.reasons[0].includes("charging isn't armed"),
    "but this deployment can't take the charge — the accuracy-gate certification is pending");

  const demand = calc.paidConversion(mkA({ switchTarget: { key: "steady", name: "Steady Use Rate", cost: 1400, demand: true } }));
  assertClose(demand.savings.bandPct, 0.10, 1e-9,
    "a demand-plan target gets the wider band (supply held flat, exact rates unpublished)");
  assert(demand.eligible === true && demand.offer.demandEstimate === true,
    "the wider band still clears the bar at this spread, and the offer flags the estimate");

  try {
    P.chargingCertified = true;
    P.provider = null;
    const noProvider = calc.paidConversion(clear);
    assert(noProvider.collectible === false && noProvider.reasons[0].includes("no payment provider"),
      "certified but provider-less still cannot collect");
    P.provider = { id: "test-provider" };
    const uncertified = calc.paidConversion(clear);
    assert(uncertified.collectible === false && uncertified.reasons[0].includes("no payment provider"),
      "an unrecognized provider cannot be armed by a certification flag");
    P.provider = { id: "stripe-checkout" };
    const stripeUncertified = calc.paidConversion(clear);
    assert(stripeUncertified.collectible === false && stripeUncertified.reasons[0].includes("not certified"),
      "a wired but uncertified Stripe provider still cannot collect");
    P.providerCertified = true;
    const armed = calc.paidConversion(clear);
    assert(armed.collectible === true && armed.reasons.length === 0,
      "certified and wired → collectible, with no reasons left standing");
  } finally {
    P.chargingCertified = false;
    P.providerCertified = false;
    P.provider = { id: "stripe-checkout", createEndpoint: "/api/checkout/create", sessionEndpoint: "/api/checkout/session" };
  }

  // -- validateConsent: explicit, version-bound, every acknowledgment named --
  const consent = { version: P.policyVersion, sawPrice: true, sawContents: true, sawNoAffiliation: true,
    sawEstimateCaveat: true, authorizesCharge: true, grantedAt: 1700000000000 };
  assert(calc.validateConsent(null).valid === false, "no consent recorded is invalid");
  const stale = calc.validateConsent(Object.assign({}, consent, { version: P.policyVersion - 1 }));
  assert(stale.valid === false && stale.reason.includes("re-consent"),
    "consent given under one price can't authorize a charge under another");
  const partial = calc.validateConsent(Object.assign({}, consent, { sawNoAffiliation: false }));
  assert(partial.valid === false && partial.missing.join("; ").includes("independent"),
    "a missing acknowledgment is named, not guessed");
  assert(calc.validateConsent(Object.assign({}, consent, { grantedAt: "recently" })).valid === false,
    "consent without a timestamp is invalid");
  assert(calc.validateConsent(consent).valid === true, "a complete, version-matched consent validates");

  // -- refundDecision: two doors, idempotent, nothing vague --
  const now = 1700000000000;
  const oldPurchase = { paidAt: now - 40 * 86400000, amount: 29, refunded: false };
  assert(calc.refundDecision(null, { reason: "change_of_mind" }, now).granted === false,
    "nothing paid → nothing to refund");
  assert(calc.refundDecision({ paidAt: now, amount: 29, refunded: true }, { reason: "savings_not_realized" }, now).granted === false,
    "an already-refunded purchase is never refunded twice");
  const late = calc.refundDecision(oldPurchase, { reason: "change_of_mind" }, now);
  assert(late.granted === false && late.reason.includes("14-day"),
    "change of mind past the window is refused — with the other door named");
  const notReal = calc.refundDecision(oldPurchase, { reason: "savings_not_realized" }, now);
  assert(notReal.granted === true && notReal.amount === 29,
    "a saving that didn't hold is refunded in full, any time");
  assert(calc.refundDecision(Object.assign({}, oldPurchase, { paidAt: now - 3 * 86400000 }),
    { reason: "change_of_mind" }, now).granted === true, "change of mind inside the window is granted");
  assert(calc.refundDecision(oldPurchase, { reason: "because" }, now).granted === false,
    "an unrecognized reason is refused");

  // -- paymentTransition: the only path from offered to charged --
  const offered0 = calc.newPaymentFlow();
  const offered = calc.paymentTransition(offered0, "verdict", { paid: { eligible: true, collectible: true, reasons: [], noSavings: null } });
  assert(offered.state === "offered", "an eligible, collectible verdict opens the offer");
  assert(offered0.state === "start", "transitions never mutate the flow they're given");
  assert(calc.paymentTransition(calc.newPaymentFlow(), "verdict",
      { paid: { eligible: false, collectible: false, reasons: [], noSavings: { message: "x" } } }).state === "not_offered",
    "the no-savings verdict never opens an offer");
  const unavailable = calc.paymentTransition(calc.newPaymentFlow(), "verdict",
    { paid: { eligible: true, collectible: false, reasons: ["charging isn't armed in this deployment"], noSavings: null } });
  assert(unavailable.state === "unavailable" && unavailable.reason.includes("isn't armed"),
    "an uncollectible verdict marks the offer unavailable, naming why");
  assert(calc.paymentTransition(calc.newPaymentFlow(), "consent", { consent: consent }).reason !== null,
    "consent can't start a charge the verdict never offered");

  const consented = calc.paymentTransition(offered, "consent", { consent: consent });
  assert(consented.state === "consented" && consented.consent.version === P.policyVersion,
    "a valid consent authorizes the pending charge");
  assert(calc.paymentTransition(offered, "consent", { consent: Object.assign({}, consent, { authorizesCharge: false }) }).state === "offered",
    "an incomplete consent is refused and the offer stays open");

  let f = calc.paymentTransition(consented, "charge");
  assert(f.state === "charging", "charge moves the flow into charging");
  f = calc.paymentTransition(f, "charge_failed");
  assert(f.state === "failed" && f.attempts === 1 && f.reason.includes("2 attempts left"),
    "a failed charge says how many attempts remain");
  f = calc.paymentTransition(calc.paymentTransition(f, "charge"), "charge_failed");
  assert(f.state === "failed" && f.attempts === 2, "the second retry keeps the offer alive");
  f = calc.paymentTransition(calc.paymentTransition(f, "charge"), "charge_failed");
  assert(f.state === "abandoned" && f.attempts === 3, "the third failure withdraws the offer for the session");
  assert(calc.paymentTransition(f, "charge").state === "abandoned",
    "an abandoned flow refuses further charges");

  let cancelled = calc.paymentTransition(calc.paymentTransition(consented, "charge"), "charge_cancelled");
  assert(cancelled.state === "cancelled" && cancelled.reason.includes("no charge was made"),
    "a cancelled checkout records no charge and preserves the free result");
  const cancelledRetry = calc.paymentTransition(cancelled, "consent", { consent: consent });
  assert(cancelledRetry.state === "consented", "a customer may retry after cancelling hosted checkout");

  const ineligibleCheckout = calc.paymentTransition(calc.newPaymentFlow(), "checkout_succeeded", {}, { now: 1700000000000 });
  assert(ineligibleCheckout.state === "start" && ineligibleCheckout.reason.includes("no provider-confirmed"),
    "a provider success cannot unlock a flow with no active offer");

  const t0 = 1700000000000;
  const paidF = calc.paymentTransition(calc.paymentTransition(consented, "charge"), "charge_succeeded", {}, { now: t0 });
  assert(paidF.state === "paid" && paidF.purchase.amount === 29 && paidF.purchase.refunded === false,
    "a succeeded charge records the purchase at the quoted price");
  const refunded = calc.paymentTransition(paidF, "refund_requested", { reason: "savings_not_realized" }, { now: t0 + 86400000 });
  assert(refunded.state === "refunded" && refunded.purchase.refunded === true && refunded.refund.amount === 29,
    "the report's claim not holding refunds in full — past the change-of-mind window too");
  assert(calc.paymentTransition(refunded, "refund_requested", { reason: "change_of_mind" }, { now: t0 + 86400000 }).state === "refunded",
    "a refunded flow is idempotent — there is nothing left to refund");
  assert(calc.paymentTransition(paidF, "refund_requested", { reason: "change_of_mind" }, { now: t0 + 40 * 86400000 }).state === "paid",
    "a change of mind past the window leaves the purchase standing (the savings door stays open)");

  // -- analyze() end to end: the verdict carries its own paid-conversion evidence --
  const sampleA = calc.analyze(calc.parseGreenButton(fs.readFileSync(path.join(__dirname, "fixtures/sample-greenbutton.csv"), "utf8")));
  assert(sampleA.savings && isFinite(sampleA.savings.low) && sampleA.savings.low <= sampleA.savings.estimate && sampleA.savings.estimate <= sampleA.savings.high,
    "analyze() publishes the annual-savings range alongside the free verdict");
  assert(sampleA.paid.eligible === false && sampleA.paid.noSavings !== null && sampleA.paid.offer === null,
    "the peak-heavy sample honestly lands on the no-savings fork");
  assert(sampleA.paid.noSavings.message.includes("nothing about this result is hidden behind payment"),
    "the free no-savings path explicitly promises no charge and no hidden result");

  const flatHours = [], flatMonths = [];
  [["2026-07", 7, true], ["2027-01", 1, false]].forEach(([ym, mo, summer]) => {
    for (let i = 0; i < 500; i++) flatHours.push({ ym, mo, hour: i % 12, weekday: 1 + (i % 5), kwh: 4 });
    flatHours.push({ ym, mo, hour: 12, weekday: 1, kwh: 1 }, { ym, mo, hour: 13, weekday: 1, kwh: 1 }, { ym, mo, hour: 14, weekday: 1, kwh: 1 });
    flatMonths.push({ ym, mo, summer, total: 2003, peak: 3, off: 2000 });
  });
  const flatA = calc.analyze({ months: flatMonths, hours: flatHours, ndays: 61 });
  assert(flatA.paid.eligible === true && flatA.paid.offer !== null && flatA.paid.collectible === false,
    "a flat heavy load clears the meaningful-savings bar on its demand target — offered, not collectible");
  assert(flatA.paid.reasons[0].includes("charging isn't armed"),
    "the offer names the certification gate it waits behind");
  assert(flatA.paid.offer.includes.includes("complete plan-by-plan comparison") &&
         flatA.paid.offer.includes.includes("step-by-step enrollment instructions"),
    "a purchase-eligible result advertises the complete comparison and switching guidance");

  console.log("");
} catch (e) {
  console.log(`  ✗ Paid-conversion tests failed: ${e.message}`);
  testsFailed++;
  console.log("");
}


// Test 21: persistent monthly monitoring — the retained series (monitor.js):
// merge/revision/retention, the plan timeline, the stitched per-period dashboard
// across a plan switch, realized switch savings, and the storage contract
// (round-trip, corrupt input, deletion), fingerprints, demo exclusion,
// raw-data privacy, and the no-network localStorage boundary. The
// retention/deletion behavior is the documented contract this test pins:
// newest 36 months kept, deletion removes everything, unreadable stores start
// fresh rather than crash.
console.log("Test 21: Persistent monthly monitoring");
try {
  // Self-sufficient rate state (earlier tests mutate RATES).
  calc.applyRates(JSON.parse(fs.readFileSync(path.join(__dirname, "../public/rates.json"), "utf8")));
  const mon = require("../public/monitor.js");
  const month = (ym, total, peak, ndays) => ({
    ym, month: +ym.slice(5, 7), total, peak, off: total - peak,
    summer: [6, 7, 8, 9].includes(+ym.slice(5, 7)), ndays: ndays || 30
  });

  // ---- in-memory storage: the contract load/save/clear run against -------
  const memStore = () => {
    const m = new Map();
    return { setItem: (k, v) => m.set(k, String(v)), getItem: (k) => (m.has(k) ? m.get(k) : null),
             removeItem: (k) => m.delete(k) };
  };

  // ---- ingest: newest-wins merge with revisions, backward extension -------
  let s = mon.blank();
  s = mon.ingest(s, { source: "file", label: "old.csv", plan: "standard", importedAt: 1000,
    months: [month("2025-06", 400, 280), month("2025-07", 420, 300)] });
  assert(s.months.length === 2 && s.imports === 1, "first import seeds the series");
  s = mon.ingest(s, { source: "file", label: "new.csv", plan: "standard", importedAt: 2000,
    months: [month("2025-07", 430, 305), month("2025-08", 380, 250)] });
  assert(s.months.map((m) => m.ym).join(",") === "2025-06,2025-07,2025-08",
    "a later import extends the window backward instead of erasing uncovered months");
  const jul = s.months.find((m) => m.ym === "2025-07");
  assert(jul.total === 430 && jul.revisions === 1, "overlapping month takes the newest data and counts a revision");
  assert(s.months.find((m) => m.ym === "2025-06").total === 400, "months the import doesn't cover stand as measured");
  assert(s.imports === 2 && s.lastImportedAt === 2000, "import count and timestamp track the series, not the file");

  // Bill summaries: a revised bill replaces its earlier self; others stand.
  const bill = (ymd1, ymd2, cost, label) => ({ start: ymd1, end: ymd2, days: 30, ymdStart: ymd1, ymdEnd: ymd2, cost, currency: "USD", label });
  s = mon.ingest(s, { source: "gbc", label: "pull", plan: "standard", importedAt: 3000,
    months: [], bills: [bill(20250601, 20250701, 151.6, "Jun 2025"), bill(20250701, 20250731, 207.9, "Jul 2025")] });
  s = mon.ingest(s, { source: "gbc", label: "pull2", plan: "standard", importedAt: 4000,
    months: [], bills: [bill(20250701, 20250731, 199.5, "Jul 2025")] });
  assert(s.bills.length === 2, "bill summaries merge on their period label");
  assert(s.bills.find((b) => b.label === "Jul 2025").cost === 199.5 &&
         s.bills.find((b) => b.label === "Jul 2025").revisions === 1,
    "a revised bill replaces its earlier self and counts the revision (strategy: preserve revisions)");
  s = mon.ingest(s, { source: "gbc", label: "pull3", plan: "standard", importedAt: 5000,
    months: [], bills: [bill(20250701, 20250731, 198.4, "Jul 2025")] });
  assert(s.bills.find((b) => b.label === "Jul 2025").cost === 198.4 &&
         s.bills.find((b) => b.label === "Jul 2025").revisions === 2,
    "repeated bill imports keep the newest summary and accumulate revision counts");

  // ---- retention: the newest 36 buckets are the window; bills fall with it
  s = mon.blank();
  const many = [];
  for (let i = 0; i < 40; i++) {
    const y = 2023 + Math.floor(i / 12), mo = (i % 12) + 1;
    many.push(month(`${y}-${String(mo).padStart(2, "0")}`, 300 + i, 200, 30));
  }
  s = mon.ingest(s, { source: "file", label: "big.csv", plan: "standard", importedAt: 5000, months: many,
    bills: [bill(20230101, 20230131, 100, "ancient bill"), bill(20230501, 20230531, 105, "window-edge bill"),
      bill(20260101, 20260131, 110, "recent bill")] });
  assert(s.months.length === mon.RETENTION_MONTHS && mon.RETENTION_MONTHS === 36,
    `retention keeps the newest ${mon.RETENTION_MONTHS} monthly buckets`);
  assert(s.months[0].ym === "2023-05" && s.trimmed === 4,
    "the OLDEST buckets age out (2023-01..04 trimmed, count reported)");
  assert(s.bills.some((b) => b.label === "recent bill") && s.bills.some((b) => b.label === "window-edge bill") &&
         !s.bills.some((b) => b.label === "ancient bill"),
    "bills outside the retained window fall out while the oldest in-window bill remains");
  s = mon.ingest(s, { source: "file", label: "new-month.csv", plan: "standard", importedAt: 6000,
    months: [month("2026-05", 340, 220)], bills: [] });
  assert(s.months.length === mon.RETENTION_MONTHS && s.months[0].ym === "2023-06" &&
         s.months[s.months.length - 1].ym === "2026-05" && s.trimmed === 5,
    "a later import rolls the window forward by dropping exactly its oldest bucket");
  assert(!s.bills.some((b) => b.label === "window-edge bill") &&
         s.bills.some((b) => b.label === "recent bill"),
    "a bill is pruned as soon as its period falls behind the rolling window");

  // ---- the plan timeline: import-declared switches, deduped ---------------
  let t = mon.blank();
  t = mon.ingest(t, { source: "file", label: "a", plan: "standard", importedAt: 1, months: [month("2025-01", 300, 200)] });
  t = mon.ingest(t, { source: "file", label: "b", plan: "standard", importedAt: 2, months: [month("2025-02", 300, 200)] });
  assert(t.timeline.length === 0, "a declaration matching the plan in effect records nothing");
  t = mon.ingest(t, { source: "gbc", label: "c", plan: "tou", importedAt: 3, months: [month("2025-03", 300, 200), month("2025-04", 300, 200)] });
  assert(t.timeline.length === 1 && t.timeline[0].from === "2025-03" && t.timeline[0].plan === "tou",
    "a plan change is dated to the earliest month the declaring import covered");
  assert(mon.planFor(t, "2025-02") === "standard" && mon.planFor(t, "2025-03") === "tou" && mon.planFor(t, "2025-09") === "tou",
    "planFor resolves the plan in effect per month");
  assert(JSON.stringify(mon.segments(t).map((g) => g.plan)) === '["standard","tou"]' && mon.segments(t)[0].yms.length === 2,
    "segments are contiguous same-plan runs over the retained months");

  // ---- restoreParsed: the stored series as analyze() input ----------------
  const rp = mon.restoreParsed(t);
  assert(rp.hours.length === 0, "restore carries no hourly data — retention keeps monthly buckets only");
  assert(rp.ndays === 120, "ndays sums the retained buckets' observed day counts (4 × 30)");
  assert(rp.months.every((m) => typeof m.summer === "boolean"), "restored buckets carry a real summer flag (costTOU reads it directly)");

  // ---- the persistent dashboard: single-plan passthrough vs stitch --------
  const a1 = calc.analyze(mon.restoreParsed(s), { profile: { currentPlan: "standard" } });
  const st1 = mon.stitch(s, a1, {});
  assert(st1.dashboard === a1.dashboard && st1.switched === false,
    "one plan throughout → the analysis's own dashboard passes through untouched");
  assertClose(st1.dashboard.difference, a1.dashboard.difference, 0, "passthrough keeps the cumulative difference");

  // t holds Jan–Apr 2025: standard through Feb, TOU from Mar (the import that
  // declared TOU covered Mar first).
  const a2 = calc.analyze(mon.restoreParsed(t), { profile: { currentPlan: "tou" } });
  const st2 = mon.stitch(t, a2, {});
  assert(st2.switched === true && st2.dashboard.rows.length === 4, "a recorded switch stitches every segment into one table");
  assert(st2.dashboard.rows[2].planSwitch === "tou" &&
         st2.dashboard.rows[0].planSwitch === undefined && st2.dashboard.rows[3].planSwitch === undefined,
    "the boundary row is tagged with the plan switched to; other rows aren't");
  const janRow = st2.dashboard.rows[0], febRow = st2.dashboard.rows[1], marRow = st2.dashboard.rows[2], aprRow = st2.dashboard.rows[3];
  assert(janRow.actual.plan === "standard" && febRow.actual.plan === "standard" &&
         marRow.actual.plan === "tou" && aprRow.actual.plan === "tou",
    "actual is priced on the plan in effect that month (the switch repriced the real bills)");
  assert(marRow.mom !== null && Math.abs(marRow.mom.total - (marRow.actual.total - febRow.actual.total)) < 1e-9,
    "the boundary's month-over-month decomposition still sums across the plan change");
  assertClose(st2.dashboard.actualTotal,
    janRow.actual.total + febRow.actual.total + marRow.actual.total + aprRow.actual.total, 1e-9,
    "stitched actual total = the sum of each month's own-plan actual");
  assertClose(st2.dashboard.difference, st2.dashboard.actualTotal - st2.dashboard.bestTotal, 1e-9,
    "cumulative difference is actual minus best over the whole stitched history");

  // ---- realized switch savings: the counterfactual you didn't live --------
  const rz = mon.realized(t, st2, a2, {});
  const stdMarApr = rp.months.slice(2).reduce((sum, m) =>
    sum + calc.pricePeriod(calc.periodsFrom({ months: [m] })[0], "standard").total, 0);
  const actualMarApr = marRow.actual.total + aprRow.actual.total;
  assertClose(rz.savings, stdMarApr - actualMarApr, 1e-9,
    "realized savings = the prior plan's price of the post-switch months minus what was actually paid");
  assert(rz.priorPlan === "standard" && rz.plan === "tou" && rz.from === "2025-03" && rz.months === 2,
    "realized names the switch: from which plan, to which, since when");
  assert(mon.realized(s, st1, a1, {}) === null, "no switch in the series → no realized figure");

  // Demand-plan counterfactual needs hourly data retention doesn't keep —
  // omitted with the reason, never approximated.
  const tDem = mon.ingest(mon.blank(), { source: "file", label: "d1", plan: "standard", importedAt: 1, months: [month("2025-01", 300, 200)] });
  const tDem2 = mon.ingest(tDem, { source: "gbc", label: "d2", plan: "smart", importedAt: 2, months: [month("2025-02", 300, 200)] });
  const aDem = calc.analyze(mon.restoreParsed(tDem2), { profile: { currentPlan: "smart" } });
  const stDem = mon.stitch(tDem2, aDem, {});
  const rzDem = mon.realized(tDem2, stDem, aDem, {});
  assert(rzDem && rzDem.savings === null && rzDem.unpriced.length === 1,
    "an unpriceable counterfactual (demand plan, no retained hours) is reported as unpriced, not zero");

  // ---- the storage contract: round-trip, corrupt input, deletion ----------
  const store = memStore();
  mon.save(s, store);
  const back = mon.load(store);
  assert(back && back.months.length === s.months.length && back.imports === s.imports,
    "save/load round-trips the series");
  assert(mon.load(memStore()) === null, "an empty store reads as no series (not a blank one) — nothing to restore");
  store.setItem(mon.KEY, "{not json");
  assert(mon.load(store).months.length === 0 && mon.load(store).schema === mon.SCHEMA,
    "corrupt stored JSON starts fresh instead of crashing the page");
  store.setItem(mon.KEY, JSON.stringify({ schema: 99, months: [] }));
  assert(mon.load(store).months.length === 0, "a series from another schema version starts fresh");
  store.setItem(mon.KEY, JSON.stringify({ schema: 1, months: "nope" }));
  assert(mon.load(store).months.length === 0, "a series with a malformed month list starts fresh");
  store.setItem(mon.KEY, JSON.stringify({ schema: mon.SCHEMA, months: [month("2026-02", 250, 150)] }));
  const compatible = mon.load(store);
  assert(compatible.schema === mon.SCHEMA && compatible.months.length === 1 && compatible.months[0].ym === "2026-02",
    "the current schema version remains loadable after compatibility checks");
  mon.save(s, store);
  mon.clear(store);
  assert(store.getItem(mon.KEY) === null && mon.load(store) === null,
    "deletion removes the whole series — permanently, immediately");

  // save() without storage throws — the caller must be able to say so rather
  // than lose an import silently.
  let threw = false;
  try { mon.save(s, null); } catch (e) { threw = true; }
  assert(threw, "saving with no storage available throws (the UI surfaces it, data isn't silently dropped)");

  // ---- privacy boundary: only the documented monthly summaries survive ---
  const secret = "DO_NOT_RETAIN_GREEN_BUTTON_SECRET_7f4d";
  const sampleMarker = "Sample NYC home · ~10,300 kWh/yr";
  const rawInterval = { timestamp: "2026-01-15T12:00:00Z", usage: 4.2, marker: secret };
  const privacySeries = mon.ingest(mon.blank(), {
    source: "file", plan: "standard", importedAt: 6000,
    months: [month("2026-01", 300, 200)],
    // These are deliberately connector-shaped fields. They must be ignored,
    // not copied into the local monitoring record.
    hours: [rawInterval], intervals: [rawInterval], rawIntervals: [rawInterval],
    accountId: secret, usagePointId: secret, accessToken: secret,
    authorizationCode: secret, sampleData: sampleMarker,
    profile: {
      territory: "nyc", currentPlan: "standard", meter: "smart",
      solar: false, esco: false, heatPump: false,
      planHistory: {lastPlan: "tou", monthsSinceExit: 2},
      accountId: secret, usagePointId: secret, token: secret,
      sampleData: sampleMarker
    }
  });
  const privacyJson = JSON.stringify(privacySeries);
  assert(!privacyJson.includes(secret) && !privacyJson.includes(sampleMarker),
    "raw intervals, account identifiers, tokens, and demo sample data never enter the retained series");
  assert(mon.restoreParsed(privacySeries).hours.length === 0,
    "restoring monitoring data never recreates hourly interval readings");
  assert(JSON.stringify(Object.keys(privacySeries.profile).sort()) ===
         '["currentPlan","esco","heatPump","meter","planHistory","solar","territory"]',
    "only the documented eligibility facts and bounded plan history are retained in the profile");
  assert(privacySeries.profile.planHistory.lastPlan === "tou" &&
         privacySeries.profile.planHistory.monthsSinceExit === 2,
    "bounded plan history survives monitoring persistence");

  const privacyStore = memStore();
  mon.save(privacySeries, privacyStore);
  assert(!privacyStore.getItem(mon.KEY).includes(secret) && !privacyStore.getItem(mon.KEY).includes(sampleMarker),
    "the serialized localStorage value excludes raw connector and sample payloads");
  privacyStore.setItem(mon.KEY, JSON.stringify({ schema: mon.SCHEMA, months: privacySeries.months,
    profile: { territory: "nyc", currentPlan: "standard", meter: "smart", token: secret } }));
  assert(!JSON.stringify(mon.load(privacyStore)).includes(secret),
    "loading an older or hand-written record also strips unknown profile fields");

  // ---- derived fingerprints: deterministic, input-sensitive, and local ----
  const fingerprintAnalysis = calc.analyze(mon.restoreParsed(privacySeries), { profile: privacySeries.profile });
  const firstFingerprint = mon.recheck(privacySeries, fingerprintAnalysis, { trigger: "usage", now: 7000 });
  assert(typeof firstFingerprint.state.usageFingerprint === "string" &&
         typeof firstFingerprint.state.profileFingerprint === "string" &&
         typeof firstFingerprint.state.rateFingerprint === "string",
    "a recheck stores usage, profile, and rate fingerprints instead of raw inputs");
  assert(firstFingerprint.state.rateFingerprint === mon.rateFingerprint(calc.RATES),
    "the persisted rate fingerprint is derived from the current published rates");
  const equivalentRates = JSON.parse(JSON.stringify(calc.RATES));
  assert(mon.rateFingerprint(equivalentRates) === firstFingerprint.state.rateFingerprint,
    "rate fingerprints are stable across equivalent object serialization");
  equivalentRates.tou.offPeak += 0.001;
  assert(mon.rateFingerprint(equivalentRates) !== firstFingerprint.state.rateFingerprint,
    "a tariff input change produces a different rate fingerprint");
  const changedFingerprintSeries = mon.ingest(privacySeries, {
    source: "file", importedAt: 8000, months: [month("2026-01", 301, 200)], profile: privacySeries.profile
  });
  changedFingerprintSeries.recheck = firstFingerprint.state;
  const changedFingerprint = mon.recheck(changedFingerprintSeries,
    calc.analyze(mon.restoreParsed(changedFingerprintSeries), { profile: privacySeries.profile }),
    { trigger: "usage", now: 8000 });
  assert(changedFingerprint.usageChanged === true &&
         changedFingerprint.state.usageFingerprint !== firstFingerprint.state.usageFingerprint,
    "a revised monthly bucket changes the usage fingerprint without retaining intervals");
  changedFingerprintSeries.recheck = changedFingerprint.state;
  const fingerprintStore = memStore();
  mon.save(changedFingerprintSeries, fingerprintStore);
  assert(mon.load(fingerprintStore).recheck.usageFingerprint === changedFingerprint.state.usageFingerprint &&
         !fingerprintStore.getItem(mon.KEY).includes(secret),
    "fingerprints round-trip through localStorage without carrying forbidden values");

  // The built-in sample is an analysis-only demo. Its button path renders the
  // sample directly and must never enter the real-import persistence path.
  const appSource = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  const sampleStart = appSource.indexOf('$("sample-btn").addEventListener("click"');
  const sampleEnd = appSource.indexOf("\n  });\n  if (evToggle", sampleStart);
  const sampleHandler = sampleStart >= 0 && sampleEnd > sampleStart ? appSource.slice(sampleStart, sampleEnd) : "";
  assert(sampleHandler.includes("window.CONED_SAMPLE") && !sampleHandler.includes("ingestAndRender") &&
         !sampleHandler.includes("M.ingest"),
    "the demo sample is analyzed in place and excluded from monitoring ingestion");

  // The monitor's storage boundary is localStorage only. Guard the common
  // browser network entry points while exercising the default-store path.
  const monitorSource = fs.readFileSync(path.join(__dirname, "../public/monitor.js"), "utf8");
  assert(!/\b(?:fetch|XMLHttpRequest|sendBeacon)\b/.test(monitorSource),
    "monitor.js contains no network read/write path");
  const oldFetch = global.fetch;
  const oldXHR = global.XMLHttpRequest;
  const hadLocalStorage = Object.prototype.hasOwnProperty.call(global, "localStorage");
  const oldLocalStorage = global.localStorage;
  let networkCalls = 0;
  const browserStore = memStore();
  global.fetch = () => { networkCalls++; throw new Error("unexpected monitor network call"); };
  global.XMLHttpRequest = function () { networkCalls++; throw new Error("unexpected monitor network call"); };
  global.localStorage = browserStore;
  try {
    mon.save(privacySeries);
    mon.load();
    mon.clear();
  } finally {
    if (oldFetch === undefined) delete global.fetch; else global.fetch = oldFetch;
    if (oldXHR === undefined) delete global.XMLHttpRequest; else global.XMLHttpRequest = oldXHR;
    if (hadLocalStorage) global.localStorage = oldLocalStorage; else delete global.localStorage;
  }
  assert(networkCalls === 0, "localStorage save/load/delete perform no network reads or writes");

  console.log("");
} catch (e) {
  console.log(`  ✗ Persistent-monitoring tests failed: ${e.message}`);
  console.log(e.stack);
  testsFailed++;
  console.log("");
}

// Test 22: recommendation rechecks — local baselines detect only decisions
// changed by new usage or changed tariffs, and explain the input that moved it.
console.log("Test 22: Recommendation rechecks");
try {
  calc.applyRates(JSON.parse(fs.readFileSync(path.join(__dirname, "../public/rates.json"), "utf8")));
  const mon = require("../public/monitor.js");
  const bucket = (total, peak) => ({ ym: "2025-07", month: 7, total, peak, off: total - peak,
    summer: true, ndays: 31 });
  const analyzeSeries = (s) => calc.analyze(mon.restoreParsed(s), { profile: { currentPlan: "standard" } });

  const offPeakAnalysis = calc.analyze({ months: [bucket(400, 10)], ndays: 31 },
    { profile: { currentPlan: "standard" } });
  const staleEligibility = Object.assign({}, offPeakAnalysis, {
    switchTarget: { key: "steady", name: "Steady Use Rate", cost: 1 },
    plans: offPeakAnalysis.plans.map((plan) => plan.key === "standard"
      ? plan : Object.assign({}, plan, { avail: false, excludedReason: "stale eligibility" }))
  });
  const sanitized = mon.recommendationSnapshot(staleEligibility);
  assert(sanitized.targetPlan === null && sanitized.outcome !== "switch",
    "monitoring rechecks cannot turn a stale or ineligible plan into a switch target");

  const demandWithoutHours = calc.analyze({ months: [bucket(400, 10)], ndays: 31 },
    { profile: { currentPlan: "steady" } });
  const blockedSnapshot = mon.recommendationSnapshot(demandWithoutHours);
  assert(blockedSnapshot.outcome === "blocked" && blockedSnapshot.targetPlan === null,
    "monitoring rechecks retain the eligibility block when the current demand plan is unpriceable");

  // First calculation establishes a local baseline and is never presented as an alert.
  let steady = mon.ingest(mon.blank(), { source: "file", importedAt: 1,
    months: [bucket(400, 300)], profile: { currentPlan: "standard" } });
  const first = analyzeSeries(steady);
  const initialized = mon.recheck(steady, first, { trigger: "usage", now: 10 });
  steady.recheck = initialized.state;
  assert(initialized.changed === false && initialized.initialized === true,
    "the first local analysis establishes a baseline without alerting");

  // A changed import that leaves the verdict alone is recorded but stays quiet.
  steady = mon.ingest(steady, { source: "file", importedAt: 2,
    months: [bucket(450, 340)], profile: { currentPlan: "standard" } });
  const stillStay = mon.recheck(steady, analyzeSeries(steady), { trigger: "usage", now: 20 });
  assert(stillStay.changed === false && stillStay.usageChanged === true && stillStay.alert === null,
    "new usage that does not change the recommendation produces no alert");
  steady.recheck = stillStay.state;

  // A published release can change prices or provenance without moving the
  // switch/stay boundary. It still gets a visible, non-alerting notice and
  // retains the old/new release identity for support and bug reports.
  const priorVersion = calc.RATES.meta.version;
  calc.RATES.meta.version = "1.10.1";
  const sameDecisionRate = mon.recheck(steady, analyzeSeries(steady), { trigger: "rates", now: 25 });
  assert(sameDecisionRate.changed === false && sameDecisionRate.rateChanged === true &&
         sameDecisionRate.alert === null && sameDecisionRate.notice &&
         sameDecisionRate.notice.reasonCodes.includes("rates"),
    "a rate refresh that leaves the decision unchanged is identified without an alert");
  assert(sameDecisionRate.rateChange.previous.version === priorVersion &&
         sameDecisionRate.rateChange.current.version === "1.10.1" &&
         sameDecisionRate.notice.message.includes("1.10.1"),
    "the unchanged result names both tariff releases");
  steady.recheck = sameDecisionRate.state;
  const revisit = mon.recheck(steady, analyzeSeries(steady), { trigger: "revisit", now: 26 });
  assert(revisit.changed === false && revisit.rateChanged === false && revisit.notice === null,
    "persisting the recheck baseline prevents the same release from alerting again on revisit");
  steady.recheck = revisit.state;
  calc.RATES.meta.version = priorVersion;

  // A newly imported off-peak load shape crosses from stay to switch and names usage.
  steady = mon.ingest(steady, { source: "file", importedAt: 3,
    months: [bucket(400, 10)], profile: { currentPlan: "standard" } });
  const usageChanged = mon.recheck(steady, analyzeSeries(steady), { trigger: "usage", now: 30 });
  assert(usageChanged.changed === true && usageChanged.usageChanged === true &&
         usageChanged.current.targetPlan === "tou" && usageChanged.alert.reasonCodes.includes("usage"),
    "new usage that changes the verdict alerts and identifies the load-profile change");
  assert(usageChanged.alert.message.includes("Stay on Standard") &&
         usageChanged.alert.message.includes("Switch to Time-of-Use") &&
         usageChanged.alert.reasons.some((r) => r.includes("usage")),
    "the changed-usage alert says what changed and why");
  steady.recheck = usageChanged.state;

  // Persisting the baseline is still local monitoring state, not a server record.
  const store = new Map();
  const localStore = { setItem: (k, v) => store.set(k, String(v)), getItem: (k) => store.get(k) || null,
    removeItem: (k) => store.delete(k) };
  mon.save(steady, localStore);
  assert(mon.load(localStore).recheck.recommendation.decision === usageChanged.current.decision,
    "the latest recommendation baseline round-trips through local storage");

  // A tariff mutation flips the same usage back to Standard and is attributed to rates.
  const originalOffPeak = calc.RATES.tou.offPeak;
  calc.RATES.tou.offPeak = 0.50;
  const rateChanged = mon.recheck(steady, analyzeSeries(steady), { trigger: "rates", now: 40 });
  assert(rateChanged.changed === true && rateChanged.rateChanged === true &&
         rateChanged.current.outcome === "stay" && rateChanged.alert.reasonCodes.includes("rates"),
    "a rate update that changes the verdict alerts and identifies the tariff change");
  assert(rateChanged.alert.reasons.some((r) => r.includes("Published rate data changed")),
    "the changed-rate alert names the published rate update");
  calc.RATES.tou.offPeak = originalOffPeak;
  calc.applyRates(JSON.parse(fs.readFileSync(path.join(__dirname, "../public/rates.json"), "utf8")));
  console.log("");
} catch (e) {
  console.log(`  ✗ Recommendation-recheck tests failed: ${e.message}`);
  console.log(e.stack);
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
