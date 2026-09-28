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

console.log("tariff-refresh: provenance, validation, bill-period policy, and strict mirror checks pass");
