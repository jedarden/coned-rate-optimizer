/* Automated test suite for calc.js core
   Usage: node test/test.js
   Tests parsing, analysis, and rate calculations */
const fs = require("fs");
const path = require("path");
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

// Summary
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
