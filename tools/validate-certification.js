/* Validate the durable accuracy/payment certification artifact.
 *
 * The artifact is evidence, not a switch.  This validator deliberately keeps
 * the two deployment flags separate from the evidence and only reports that a
 * release is eligible to arm them when the accuracy review, provider review,
 * and controlled-change requirements are all present.
 *
 * Usage: node tools/validate-certification.js --artifact <path>
 */
"use strict";

const fs = require("fs");

const TOP_KEYS = ["artifactVersion", "artifactId", "status", "generatedAt", "model", "accuracy", "diversity", "provider", "review", "enablement"];
const MODEL_KEYS = ["tool", "commit", "ratesAsOf", "policyVersion"];
const ACCURACY_KEYS = ["minimumAccounts", "passPct", "gateFractionPct", "aggregate", "accounts", "status"];
const AGGREGATE_KEYS = ["usableAccounts", "supportedPeriods", "within2Periods", "shareWithin2Pct", "meanPctError", "maxPctError"];
const ACCOUNT_KEYS = ["id", "cohort", "supportedPeriods", "within2Periods", "pctWithin2", "maxPctError", "misses"];
const MISS_KEYS = ["period", "modeledTotal", "actualTotal", "delta", "pctError", "band", "modeledComponents", "worstModeledComponent", "cause", "disposition", "owner", "resolution"];
const PROVIDER_KEYS = ["id", "status", "testedCommit", "testedAt", "checks"];
const CHECK_KEYS = ["id", "result", "command", "evidence"];
const REVIEW_KEYS = ["accuracy", "provider"];
const REVIEW_ENTRY_KEYS = ["status", "reviewer", "reviewedAt", "decisionRef"];
const ENABLEMENT_KEYS = ["chargingCertified", "providerCertified", "freeResultPreserved", "changeRef", "approvedBy", "rollback"];
const ROLLBACK_KEYS = ["changeRef", "procedure"];

function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function own(value, key) { return Object.prototype.hasOwnProperty.call(value, key); }
function unknownKeys(value, allowed, label, errors) {
  Object.keys(value).filter((key) => !allowed.includes(key)).forEach((key) => errors.push(`${label}.${key} is not in the certification schema`));
}
function required(value, key, label, errors) {
  if (!own(value, key)) errors.push(`${label}.${key} is required`);
}
function string(value, label, errors) {
  if (typeof value !== "string" || !value.trim()) errors.push(`${label} must be a non-empty string`);
}
function integer(value, label, errors, min) {
  if (!Number.isInteger(value) || (min !== undefined && value < min)) errors.push(`${label} must be an integer${min === undefined ? "" : ` ≥ ${min}`}`);
}
function number(value, label, errors, min) {
  if (typeof value !== "number" || !Number.isFinite(value) || (min !== undefined && value < min)) errors.push(`${label} must be a finite number${min === undefined ? "" : ` ≥ ${min}`}`);
}
function iso(value, label, errors) {
  string(value, label, errors);
  if (typeof value === "string" && isNaN(Date.parse(value))) errors.push(`${label} must be an ISO-8601 timestamp`);
}
function enumValue(value, allowed, label, errors) {
  if (!allowed.includes(value)) errors.push(`${label} must be one of ${allowed.join(", ")}`);
}
function closeEnough(actual, expected) {
  return Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) <= 0.0001;
}
function category(value) {
  return typeof value === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(value);
}
function categoryKey(value) {
  return typeof value === "string" && /^[a-z][A-Za-z0-9_-]{0,31}$/.test(value);
}
function safeId(value, label, errors) {
  string(value, label, errors);
  if (typeof value === "string" && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) errors.push(`${label} must be an opaque identifier, not an email, phone number, or free-form text`);
}

function validateArtifact(artifact) {
  const errors = [];
  if (!isObject(artifact)) return ["artifact must be a JSON object"];
  unknownKeys(artifact, TOP_KEYS, "artifact", errors);
  ["artifactVersion", "artifactId", "status", "generatedAt", "model", "accuracy", "diversity", "provider", "review", "enablement"].forEach((key) => required(artifact, key, "artifact", errors));
  if (artifact.artifactVersion !== 1) errors.push("artifact.artifactVersion must be 1");
  safeId(artifact.artifactId, "artifact.artifactId", errors);
  enumValue(artifact.status, ["draft", "approved", "revoked"], "artifact.status", errors);
  iso(artifact.generatedAt, "artifact.generatedAt", errors);

  const model = artifact.model;
  if (!isObject(model)) errors.push("artifact.model must be an object");
  else {
    unknownKeys(model, MODEL_KEYS, "artifact.model", errors);
    MODEL_KEYS.forEach((key) => required(model, key, "artifact.model", errors));
    string(model.tool, "artifact.model.tool", errors);
    if (typeof model.commit !== "string" || !/^[0-9a-f]{40}$/.test(model.commit)) errors.push("artifact.model.commit must be a full lowercase Git commit SHA");
    string(model.ratesAsOf, "artifact.model.ratesAsOf", errors);
    integer(model.policyVersion, "artifact.model.policyVersion", errors, 1);
  }

  const accuracy = artifact.accuracy;
  if (!isObject(accuracy)) errors.push("artifact.accuracy must be an object");
  else {
    unknownKeys(accuracy, ACCURACY_KEYS, "artifact.accuracy", errors);
    ACCURACY_KEYS.forEach((key) => required(accuracy, key, "artifact.accuracy", errors));
    if (accuracy.minimumAccounts !== 20) errors.push("artifact.accuracy.minimumAccounts must be exactly 20");
    if (accuracy.passPct !== 2) errors.push("artifact.accuracy.passPct must be exactly 2");
    if (accuracy.gateFractionPct !== 95) errors.push("artifact.accuracy.gateFractionPct must be exactly 95");
    integer(accuracy.minimumAccounts, "artifact.accuracy.minimumAccounts", errors, 20);
    number(accuracy.passPct, "artifact.accuracy.passPct", errors, 0);
    number(accuracy.gateFractionPct, "artifact.accuracy.gateFractionPct", errors, 95);
    enumValue(accuracy.status, ["pass", "fail", "incomplete"], "artifact.accuracy.status", errors);
    const aggregate = accuracy.aggregate;
    if (!isObject(aggregate)) errors.push("artifact.accuracy.aggregate must be an object");
    else {
      unknownKeys(aggregate, AGGREGATE_KEYS, "artifact.accuracy.aggregate", errors);
      AGGREGATE_KEYS.forEach((key) => required(aggregate, key, "artifact.accuracy.aggregate", errors));
      integer(aggregate.usableAccounts, "artifact.accuracy.aggregate.usableAccounts", errors, 0);
      integer(aggregate.supportedPeriods, "artifact.accuracy.aggregate.supportedPeriods", errors, 0);
      integer(aggregate.within2Periods, "artifact.accuracy.aggregate.within2Periods", errors, 0);
      number(aggregate.shareWithin2Pct, "artifact.accuracy.aggregate.shareWithin2Pct", errors, 0);
      number(aggregate.meanPctError, "artifact.accuracy.aggregate.meanPctError", errors, 0);
      number(aggregate.maxPctError, "artifact.accuracy.aggregate.maxPctError", errors, 0);
      if (Number.isInteger(aggregate.within2Periods) && Number.isInteger(aggregate.supportedPeriods) && aggregate.within2Periods > aggregate.supportedPeriods) errors.push("artifact.accuracy.aggregate.within2Periods cannot exceed supportedPeriods");
      if (Number.isFinite(aggregate.shareWithin2Pct) && aggregate.shareWithin2Pct > 100) errors.push("artifact.accuracy.aggregate.shareWithin2Pct cannot exceed 100");
      if (Number.isInteger(aggregate.supportedPeriods) && Number.isInteger(aggregate.within2Periods) && Number.isFinite(aggregate.shareWithin2Pct)) {
        const derivedShare = aggregate.supportedPeriods ? aggregate.within2Periods / aggregate.supportedPeriods * 100 : 0;
        if (!closeEnough(aggregate.shareWithin2Pct, derivedShare)) errors.push("artifact.accuracy.aggregate.shareWithin2Pct must be derived from within2Periods/supportedPeriods");
      }
    }
    if (!Array.isArray(accuracy.accounts)) errors.push("artifact.accuracy.accounts must be an array");
    else {
      const ids = new Set();
      let supported = 0, within2 = 0;
      accuracy.accounts.forEach((account, i) => {
        const label = `artifact.accuracy.accounts[${i}]`;
        if (!isObject(account)) { errors.push(`${label} must be an object`); return; }
        unknownKeys(account, ACCOUNT_KEYS, label, errors);
        ACCOUNT_KEYS.forEach((key) => required(account, key, label, errors));
        safeId(account.id, `${label}.id`, errors);
        if (ids.has(account.id)) errors.push(`${label}.id is duplicated`);
        ids.add(account.id);
        if (!isObject(account.cohort)) errors.push(`${label}.cohort must be a categorical object`);
        else Object.entries(account.cohort).forEach(([key, value]) => {
          if (!categoryKey(key) || !category(value)) errors.push(`${label}.cohort contains an invalid categorical value`);
        });
        integer(account.supportedPeriods, `${label}.supportedPeriods`, errors, 1);
        integer(account.within2Periods, `${label}.within2Periods`, errors, 0);
        number(account.pctWithin2, `${label}.pctWithin2`, errors, 0);
        number(account.maxPctError, `${label}.maxPctError`, errors, 0);
        if (Number.isInteger(account.within2Periods) && Number.isInteger(account.supportedPeriods) && account.within2Periods > account.supportedPeriods) errors.push(`${label}.within2Periods cannot exceed supportedPeriods`);
        if (Number.isInteger(account.within2Periods) && Number.isInteger(account.supportedPeriods)) {
          const derivedShare = account.within2Periods / account.supportedPeriods * 100;
          if (!closeEnough(account.pctWithin2, derivedShare)) errors.push(`${label}.pctWithin2 must be derived from within2Periods/supportedPeriods`);
        }
        if (!Array.isArray(account.misses)) errors.push(`${label}.misses must be an array`);
        else {
          const expectedMisses = Number.isInteger(account.supportedPeriods) && Number.isInteger(account.within2Periods) ? account.supportedPeriods - account.within2Periods : null;
          if (expectedMisses !== null && account.misses.length !== expectedMisses) errors.push(`${label}.misses must document every period outside the 2% gate (expected ${expectedMisses})`);
          const periods = new Set();
          account.misses.forEach((miss, j) => {
            validateMiss(miss, `${label}.misses[${j}]`, errors);
            if (isObject(miss) && periods.has(miss.period)) errors.push(`${label}.misses[${j}].period is duplicated`);
            if (isObject(miss)) periods.add(miss.period);
          });
          if (Number.isFinite(account.maxPctError) && account.misses.some((miss) => isObject(miss) && Number.isFinite(miss.pctError) && miss.pctError > account.maxPctError + 0.0001)) errors.push(`${label}.maxPctError must include every documented miss`);
        }
        if (Number.isInteger(account.supportedPeriods)) supported += account.supportedPeriods;
        if (Number.isInteger(account.within2Periods)) within2 += account.within2Periods;
      });
      if (isObject(aggregate) && aggregate.supportedPeriods !== supported) errors.push("artifact.accuracy.aggregate.supportedPeriods must equal the account sum");
      if (isObject(aggregate) && aggregate.within2Periods !== within2) errors.push("artifact.accuracy.aggregate.within2Periods must equal the account sum");
      if (isObject(aggregate) && aggregate.usableAccounts !== accuracy.accounts.length) errors.push("artifact.accuracy.aggregate.usableAccounts must equal the account count");
    }
  }

  const diversity = artifact.diversity;
  if (!isObject(diversity)) errors.push("artifact.diversity must be an object");
  else {
    unknownKeys(diversity, ["dimensions", "reviewerAttested"], "artifact.diversity", errors);
    required(diversity, "dimensions", "artifact.diversity", errors);
    required(diversity, "reviewerAttested", "artifact.diversity", errors);
    if (diversity.reviewerAttested !== true) errors.push("artifact.diversity.reviewerAttested must be true before certification");
    if (!isObject(diversity.dimensions)) errors.push("artifact.diversity.dimensions must be an object");
    else {
      const accountCount = artifact.accuracy && artifact.accuracy.accounts && artifact.accuracy.accounts.length;
      const diverseDimensions = Object.keys(diversity.dimensions).filter((dimension) => {
        if (!categoryKey(dimension)) { errors.push(`artifact.diversity.dimensions.${dimension} must be categorical`); return false; }
        const buckets = diversity.dimensions[dimension];
        if (!isObject(buckets)) { errors.push(`artifact.diversity.dimensions.${dimension} must be an object`); return false; }
        const total = Object.values(buckets).reduce((sum, count) => sum + (Number.isInteger(count) ? count : 0), 0);
        if (total !== accountCount) errors.push(`artifact.diversity.dimensions.${dimension} must sum to the account count`);
        Object.entries(buckets).forEach(([bucket, count]) => {
          if (!category(bucket)) errors.push(`artifact.diversity.dimensions.${dimension}.${bucket} must be categorical`);
          integer(count, `artifact.diversity.dimensions.${dimension}.${bucket}`, errors, 1);
        });
        return Object.keys(buckets).length >= 2;
      });
      if (diverseDimensions.length < 2) errors.push("artifact.diversity must span at least two dimensions with at least two buckets each");
    }
  }

  const provider = artifact.provider;
  if (!isObject(provider)) errors.push("artifact.provider must be an object");
  else {
    unknownKeys(provider, PROVIDER_KEYS, "artifact.provider", errors);
    PROVIDER_KEYS.forEach((key) => required(provider, key, "artifact.provider", errors));
    safeId(provider.id, "artifact.provider.id", errors);
    enumValue(provider.status, ["pass", "fail", "pending"], "artifact.provider.status", errors);
    if (typeof provider.testedCommit !== "string" || !/^[0-9a-f]{40}$/.test(provider.testedCommit)) errors.push("artifact.provider.testedCommit must be a full lowercase Git commit SHA");
    if (isObject(model) && provider.testedCommit !== model.commit) errors.push("artifact.provider.testedCommit must equal artifact.model.commit");
    iso(provider.testedAt, "artifact.provider.testedAt", errors);
    if (!Array.isArray(provider.checks) || provider.checks.length === 0) errors.push("artifact.provider.checks must contain the provider certification checks");
    else {
      const ids = new Set();
      provider.checks.forEach((check, i) => {
      const label = `artifact.provider.checks[${i}]`;
      if (!isObject(check)) { errors.push(`${label} must be an object`); return; }
      unknownKeys(check, CHECK_KEYS, label, errors);
      CHECK_KEYS.forEach((key) => required(check, key, label, errors));
      safeId(check.id, `${label}.id`, errors);
      if (ids.has(check.id)) errors.push(`${label}.id is duplicated`);
      ids.add(check.id);
      enumValue(check.result, ["pass", "fail"], `${label}.result`, errors);
      string(check.command, `${label}.command`, errors);
      string(check.evidence, `${label}.evidence`, errors);
      });
    }
  }

  const review = artifact.review;
  if (!isObject(review)) errors.push("artifact.review must be an object");
  else {
    unknownKeys(review, REVIEW_KEYS, "artifact.review", errors);
    REVIEW_KEYS.forEach((key) => required(review, key, "artifact.review", errors));
    REVIEW_KEYS.forEach((key) => validateReviewEntry(review[key], `artifact.review.${key}`, errors));
    if (isObject(review.accuracy) && isObject(review.provider) && review.accuracy.reviewer === review.provider.reviewer) errors.push("artifact.review accuracy and provider approvals must have distinct reviewers");
  }

  const enablement = artifact.enablement;
  if (!isObject(enablement)) errors.push("artifact.enablement must be an object");
  else {
    unknownKeys(enablement, ENABLEMENT_KEYS, "artifact.enablement", errors);
    ENABLEMENT_KEYS.forEach((key) => required(enablement, key, "artifact.enablement", errors));
    ["chargingCertified", "providerCertified", "freeResultPreserved"].forEach((key) => {
      if (typeof enablement[key] !== "boolean") errors.push(`artifact.enablement.${key} must be boolean`);
    });
    if (enablement.freeResultPreserved !== true) errors.push("artifact.enablement.freeResultPreserved must remain true");
    if (enablement.changeRef !== null) string(enablement.changeRef, "artifact.enablement.changeRef", errors);
    if (!Array.isArray(enablement.approvedBy)) errors.push("artifact.enablement.approvedBy must be an array");
    else {
      const approvers = new Set();
      enablement.approvedBy.forEach((reviewer, i) => {
        safeId(reviewer, `artifact.enablement.approvedBy[${i}]`, errors);
        if (approvers.has(reviewer)) errors.push(`artifact.enablement.approvedBy[${i}] is duplicated`);
        approvers.add(reviewer);
      });
      if (enablement.changeRef !== null && enablement.approvedBy.length < 2) errors.push("artifact.enablement.approvedBy must contain two distinct approvers for a change");
    }
    if (!isObject(enablement.rollback)) errors.push("artifact.enablement.rollback must be an object");
    else {
      unknownKeys(enablement.rollback, ROLLBACK_KEYS, "artifact.enablement.rollback", errors);
      ROLLBACK_KEYS.forEach((key) => required(enablement.rollback, key, "artifact.enablement.rollback", errors));
      string(enablement.rollback.changeRef, "artifact.enablement.rollback.changeRef", errors);
      string(enablement.rollback.procedure, "artifact.enablement.rollback.procedure", errors);
    }
  }

  return errors;
}

function validateMiss(miss, label, errors) {
  if (!isObject(miss)) { errors.push(`${label} must be an object`); return; }
  unknownKeys(miss, MISS_KEYS, label, errors);
  ["period", "modeledTotal", "actualTotal", "delta", "pctError", "band", "modeledComponents", "worstModeledComponent", "cause", "disposition", "owner", "resolution"].forEach((key) => required(miss, key, label, errors));
  string(miss.period, `${label}.period`, errors);
  ["modeledTotal", "actualTotal", "delta", "pctError"].forEach((key) => number(miss[key], `${label}.${key}`, errors));
  if (Number.isFinite(miss.modeledTotal) && Number.isFinite(miss.actualTotal) && Number.isFinite(miss.delta) && !closeEnough(miss.delta, miss.modeledTotal - miss.actualTotal)) errors.push(`${label}.delta must equal modeledTotal - actualTotal`);
  if (Number.isFinite(miss.actualTotal) && Number.isFinite(miss.modeledTotal) && Number.isFinite(miss.pctError)) {
    const derivedPct = miss.actualTotal === 0 ? (miss.modeledTotal === 0 ? 0 : Infinity) : Math.abs(miss.modeledTotal - miss.actualTotal) / Math.abs(miss.actualTotal) * 100;
    if (!closeEnough(miss.pctError, derivedPct)) errors.push(`${label}.pctError must be derived from delta/actualTotal`);
  }
  enumValue(miss.band, ["warn", "fail"], `${label}.band`, errors);
  if (Number.isFinite(miss.pctError)) {
    const expectedBand = miss.pctError <= 5 ? "warn" : "fail";
    if (miss.band !== expectedBand) errors.push(`${label}.band does not match the documented percentage error`);
  }
  if (!Array.isArray(miss.modeledComponents) || miss.modeledComponents.length === 0) errors.push(`${label}.modeledComponents must retain the modeled component breakdown`);
  else miss.modeledComponents.forEach((component, i) => {
    if (!isObject(component) || typeof component.component !== "string" || typeof component.amount !== "number") errors.push(`${label}.modeledComponents[${i}] must contain component and numeric amount`);
  });
  string(miss.worstModeledComponent, `${label}.worstModeledComponent`, errors);
  string(miss.cause, `${label}.cause`, errors);
  string(miss.disposition, `${label}.disposition`, errors);
  safeId(miss.owner, `${label}.owner`, errors);
  string(miss.resolution, `${label}.resolution`, errors);
}

function validateReviewEntry(entry, label, errors) {
  if (!isObject(entry)) { errors.push(`${label} must be an object`); return; }
  unknownKeys(entry, REVIEW_ENTRY_KEYS, label, errors);
  REVIEW_ENTRY_KEYS.forEach((key) => required(entry, key, label, errors));
  enumValue(entry.status, ["pending", "approved", "rejected"], `${label}.status`, errors);
  safeId(entry.reviewer, `${label}.reviewer`, errors);
  iso(entry.reviewedAt, `${label}.reviewedAt`, errors);
  string(entry.decisionRef, `${label}.decisionRef`, errors);
}

function eligibility(artifact) {
  const reasons = [];
  if (!isObject(artifact)) return { eligible: false, reasons: ["certification artifact is not a JSON object"] };
  if (validateArtifact(artifact).length) reasons.push("certification artifact schema is invalid");
  const a = artifact.accuracy, p = artifact.provider, r = artifact.review, e = artifact.enablement;
  if (!artifact || artifact.status !== "approved") reasons.push("certification artifact is not approved");
  if (!a || a.minimumAccounts !== 20) reasons.push("the certification gate requires exactly 20 minimum accounts");
  if (!a || a.passPct !== 2) reasons.push("the certification gate is fixed at 2% per supported period");
  if (!a || a.gateFractionPct !== 95) reasons.push("the certification gate is fixed at 95% of supported periods");
  if (!a || a.status !== "pass") reasons.push("accuracy gate is not passing");
  if (!a || !a.aggregate || a.aggregate.usableAccounts < a.minimumAccounts) reasons.push("fewer than 20 usable accounts are recorded");
  if (!a || !a.aggregate || a.aggregate.shareWithin2Pct < a.gateFractionPct) reasons.push("fewer than 95% of supported periods are within 2%");
  if (!p || p.status !== "pass" || !p.checks || p.checks.some((check) => check.result !== "pass")) reasons.push("payment provider certification is not passing");
  if (!p || !a || !artifact.model || p.testedCommit !== artifact.model.commit) reasons.push("payment provider was not tested at the candidate model commit");
  if (!r || r.accuracy.status !== "approved") reasons.push("accuracy review is not approved");
  if (!r || r.provider.status !== "approved") reasons.push("payment-provider review is not approved");
  if (!r || !r.accuracy || !r.provider || r.accuracy.reviewer === r.provider.reviewer) reasons.push("accuracy and provider approvals must be separate");
  if (!e || e.freeResultPreserved !== true) reasons.push("free-result preservation is not asserted");
  if (!e || !e.changeRef || !Array.isArray(e.approvedBy) || e.approvedBy.length < 2 || new Set(e.approvedBy).size < 2) reasons.push("the enablement change lacks two distinct approvers");
  if (!e || !e.rollback || !e.rollback.changeRef || !e.rollback.procedure) reasons.push("tested rollback evidence is missing");
  if (e && e.chargingCertified !== e.providerCertified) reasons.push("charging and provider certification flags must be enabled together");
  return { eligible: reasons.length === 0, reasons };
}

function main() {
  const args = process.argv.slice(2), index = args.indexOf("--artifact");
  if (index < 0 || !args[index + 1]) {
    console.error("usage: node tools/validate-certification.js --artifact <path>");
    process.exit(1);
  }
  let artifact;
  try { artifact = JSON.parse(fs.readFileSync(args[index + 1], "utf8")); }
  catch (error) { console.error(`error: cannot read certification artifact: ${error.message}`); process.exit(1); }
  const errors = validateArtifact(artifact);
  if (errors.length) {
    console.error(`CERTIFICATION ARTIFACT INVALID — ${errors.length} error(s)`);
    errors.forEach((error) => console.error(`  - ${error}`));
    process.exit(1);
  }
  const result = eligibility(artifact);
  console.log(JSON.stringify({ valid: true, eligible: result.eligible, reasons: result.reasons }, null, 2));
  process.exit(result.eligible ? 0 : 2);
}

if (require.main === module) main();
module.exports = { validateArtifact, eligibility };
