/* Focused regression checks for the tariff refresh release contract. */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { findDrift } = require("../scripts/check-rate-drift.js");
const { buildManifest } = require("../scripts/regenerate-reconstruction-tests.js");
const { loadCadences, validate } = require("../scripts/validate-rates.js");

const root = path.join(__dirname, "..");
const rates = JSON.parse(fs.readFileSync(path.join(root, "public/rates.json"), "utf8"));
const calc = require(path.join(root, "public/calc.js"));
const cadence = loadCadences(path.join(root, "docs/tariff-update-workflow.md"));

assert.strictEqual(cadence.errors.length, 0, `workflow source table must parse: ${cadence.errors.join("; ")}`);
const checked = validate(rates, calc.RATES, {
  now: new Date("2026-09-28T12:00:00Z"),
  cadences: cadence.byUrl,
});
assert.deepStrictEqual(checked.errors, [], `shipped tariff data must validate: ${checked.errors.join("; ")}`);
assert.strictEqual(rates.meta.version, calc.RATES.meta.version, "release version is mirrored");
assert.deepStrictEqual(findDrift(rates, calc.RATES), [], "rates.json and calc.js release data are mirrored");

const reconstructionManifest = JSON.parse(fs.readFileSync(
  path.join(root, "test/fixtures/bill-reconstruction-tests.json"), "utf8"));
assert.deepStrictEqual(reconstructionManifest, buildManifest(root),
  "generated reconstruction tests must be regenerated for the current tariff release and source fixture");
assert(reconstructionManifest.cases.length > 0, "generated reconstruction manifest contains published periods");

const changed = JSON.parse(JSON.stringify(rates));
changed.standard.allIn += 0.01;
assert(findDrift(changed, calc.RATES).includes("standard.allIn"), "numeric tariff drift is detected");

const changedVersion = JSON.parse(JSON.stringify(rates));
changedVersion.meta.version = "9.9.9";
assert(findDrift(changedVersion, calc.RATES).includes("meta.version"), "release-version drift is detected");

const scheduleFixture = JSON.parse(fs.readFileSync(
  path.join(root, "test/fixtures/rate-schedule-regression.json"), "utf8"));
const defaultScheduleResults = new Map();

function selectedSchedule(planKey, serviceMonth) {
  const monthStart = `${serviceMonth}-01`;
  return rates[planKey].rateSchedule
    .filter((period) => period.effectiveFrom <= monthStart)
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
    .pop();
}

function line(result, label) {
  const found = result.lines.find((entry) => entry.label === label);
  assert(found, `rate regression exposes a ${label} line`);
  return found;
}

function assertMoney(actual, expected, message) {
  assert(Math.abs(actual - expected) < 1e-9,
    `${message} (actual ${actual.toFixed(4)}, expected ${expected.toFixed(4)})`);
}

function checkScheduleCase(planKey, fixtureCase, expectedBaseline) {
  const expected = fixtureCase.expected;
  assert(/^2025|^2026/.test(fixtureCase.serviceMonth), `${fixtureCase.id} has a dated service month`);
  const schedule = selectedSchedule(planKey, fixtureCase.serviceMonth);
  assert(schedule, `${fixtureCase.id} resolves an effective schedule`);
  assert.strictEqual(schedule.effectiveFrom, expected.scheduleEffectiveFrom,
    `${fixtureCase.id} selects the expected effective period`);

  let result;
  if (planKey === "standard") {
    result = calc.costStandard([fixtureCase]);
    assert.strictEqual(schedule.commodity, expected.supplyRate,
      `${fixtureCase.id} selects the expected standard supply rate`);
    assertMoney(line(result, "Delivery").amount, expected.delivery, `${fixtureCase.id} delivery`);
    assertMoney(line(result, "Supply").amount, expected.supply, `${fixtureCase.id} supply`);
    assertMoney(line(result, "MAC / RDM / surcharges").amount, expected.nonDelivery, `${fixtureCase.id} non-delivery`);
    assertMoney(line(result, "Basic service charge").amount, expected.customer, `${fixtureCase.id} customer charge`);
    assertMoney(line(result, "Supply").amount / fixtureCase.total, expected.supplyRate, `${fixtureCase.id} supply rate`);
  } else {
    result = calc.costTOU([fixtureCase]);
    assert.strictEqual(schedule.peakSummer, expected.summerPeakSupplyRate,
      `${fixtureCase.id} carries the expected summer TOU supply rate`);
    assert.strictEqual(schedule.peakWinter, expected.winterPeakSupplyRate,
      `${fixtureCase.id} carries the expected winter TOU supply rate`);
    assert.strictEqual(schedule.offPeak, expected.offPeakSupplyRate,
      `${fixtureCase.id} carries the expected off-peak TOU supply rate`);
    assert.strictEqual(schedule.gross, expected.gross, `${fixtureCase.id} carries the expected TOU gross-up`);
    assertMoney(line(result, "Delivery + surcharges").amount, expected.deliveryAndSurcharges,
      `${fixtureCase.id} delivery and surcharges`);
    assertMoney(line(result, "Supply (time-of-use)").amount, expected.supply, `${fixtureCase.id} TOU supply`);
    assertMoney(line(result, "Basic service charge").amount, expected.customer, `${fixtureCase.id} customer charge`);
  }
  assertMoney(result.total, expected.total, `${fixtureCase.id} total`);
  if (expectedBaseline) {
    assertMoney(result.total, expectedBaseline.total, `${fixtureCase.id} matches rates.json override and calc.js default`);
    result.lines.forEach((entry, index) => {
      assertMoney(entry.amount, expectedBaseline.lines[index].amount,
        `${fixtureCase.id} ${entry.label} matches rates.json override and calc.js default`);
    });
  }
  return result;
}

scheduleFixture.standard.forEach((fixtureCase) => {
  defaultScheduleResults.set(fixtureCase.id, checkScheduleCase("standard", fixtureCase));
});
scheduleFixture.tou.forEach((fixtureCase) => {
  defaultScheduleResults.set(fixtureCase.id, checkScheduleCase("tou", fixtureCase));
});

assert(scheduleFixture.standard.some((fixtureCase) => fixtureCase.serviceMonth.startsWith("2025-")),
  "standard regression retains a directly comparable 2025 case");
assert(scheduleFixture.standard.some((fixtureCase) => fixtureCase.serviceMonth.startsWith("2026-")),
  "standard regression includes 2026 cases");
assert(scheduleFixture.tou.some((fixtureCase) => fixtureCase.serviceMonth.startsWith("2025-")),
  "TOU regression retains a directly comparable 2025 case");
assert(scheduleFixture.tou.some((fixtureCase) => fixtureCase.serviceMonth.startsWith("2026-")),
  "TOU regression includes 2026 cases");

// The browser applies rates.json over calc.js at runtime. Re-run the same dated
// cases through that path and require both copies to produce identical results.
calc.applyRates(rates);
assert.deepStrictEqual(findDrift(rates, calc.RATES), [],
  "rates.json overrides and calc.js defaults have no release-data drift");
scheduleFixture.standard.forEach((fixtureCase) => {
  checkScheduleCase("standard", fixtureCase, defaultScheduleResults.get(fixtureCase.id));
});
scheduleFixture.tou.forEach((fixtureCase) => {
  checkScheduleCase("tou", fixtureCase, defaultScheduleResults.get(fixtureCase.id));
});

console.log("tariff-refresh: provenance, validation, bill-period policy, and strict mirror checks pass");
