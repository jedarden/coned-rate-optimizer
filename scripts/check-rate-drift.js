/* Strict release check for the two copies of tariff data.

   rates.json is the browser's runtime override and calc.js contains the
   offline/fallback defaults. validate-rates.js deliberately reports numeric
   differences as warnings so local experiments remain possible. A release
   must be stronger: the deployed override and fallback must agree, or a
   failed fetch can show a different tariff from the one a normal page load
   uses.

   Usage: node scripts/check-rate-drift.js

   Exit codes: 0 = no release-data drift, 1 = drift or an unreadable file. */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const RATES_PATH = path.join(ROOT, "public", "rates.json");
const CALC_PATH = path.join(ROOT, "public", "calc.js");
const PLANS = ["standard", "tou", "smartChargeNY", "steadyUse", "smartEnergy"];
const TOP_LEVEL_DATA = ["bill", "accuracy", "pricing"];
const META_FIELDS = ["version", "asOf", "reviewedThrough", "switchTiming"];

function readRates() {
  return JSON.parse(fs.readFileSync(RATES_PATH, "utf8"));
}

function compare(pathName, expected, actual, drift) {
  if (expected === null || typeof expected !== "object") {
    if (JSON.stringify(expected) !== JSON.stringify(actual)) drift.push(pathName);
    return;
  }
  if (actual === null || typeof actual !== "object" || Array.isArray(actual) !== Array.isArray(expected)) {
    drift.push(pathName);
    return;
  }
  if (Array.isArray(expected)) {
    if (JSON.stringify(expected) !== JSON.stringify(actual)) drift.push(pathName);
    return;
  }
  Object.keys(expected).forEach((key) => {
    const child = pathName ? `${pathName}.${key}` : key;
    if (!Object.prototype.hasOwnProperty.call(actual, key)) drift.push(child);
    else compare(child, expected[key], actual[key], drift);
  });
}

/* Compare the release data present in rates.json. calc.js has a few
   intentional engine/derived fields that are not tariff data; those are not
   copied into this comparison. */
function findDrift(rates, calcRates) {
  const drift = [];
  const meta = {};
  META_FIELDS.forEach((field) => { meta[field] = rates.meta && rates.meta[field]; });
  compare("meta", meta, calcRates.meta, drift);
  PLANS.forEach((key) => compare(key, rates[key], calcRates[key], drift));
  TOP_LEVEL_DATA.forEach((key) => compare(key, rates[key], calcRates[key], drift));
  return drift;
}

function main() {
  let rates;
  try {
    rates = readRates();
  } catch (error) {
    console.error(`check-rate-drift: cannot read ${path.relative(ROOT, RATES_PATH)}: ${error.message}`);
    process.exit(1);
  }

  let calcRates;
  try {
    // Requiring calc.js here intentionally captures its untouched defaults.
    calcRates = require(CALC_PATH).RATES;
  } catch (error) {
    console.error(`check-rate-drift: cannot load ${path.relative(ROOT, CALC_PATH)}: ${error.message}`);
    process.exit(1);
  }

  const drift = findDrift(rates, calcRates);
  if (drift.length) {
    console.error(`check-rate-drift: ${drift.length} release data field(s) differ between rates.json and calc.js:`);
    drift.forEach((field) => console.error(`  - ${field}`));
    console.error("Update both copies in the same tariff release (or keep the change out of the deploy tree).");
    process.exit(1);
  }
  console.log(`check-rate-drift: OK — ${PLANS.length} plans, bill history, accuracy policy, pricing policy, and release metadata agree`);
}

if (require.main === module) main();

module.exports = { findDrift, readRates };
