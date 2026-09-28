/* Certification artifact and enablement contract tests. */
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const validator = require("../tools/validate-certification.js");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "coned-certification-"));
const commit = "a".repeat(40);
const cohorts = [
  { territory: "nyc", currentPlan: "standard", loadShape: "winter-peaking", meter: "smart" },
  { territory: "westchester", currentPlan: "tou", loadShape: "summer-peaking", meter: "legacy" },
];

function miss() {
  return {
    period: "2025-02-01 – 2025-03-01", modeledTotal: 100, actualTotal: 106,
    delta: -6, pctError: 5.6604, band: "fail",
    modeledComponents: [{ component: "delivery", amount: 40 }, { component: "commodity", amount: 30 }],
    worstModeledComponent: "delivery ($40.00)", cause: "bill adjustment not represented",
    disposition: "accepted residual; model issue filed", owner: "reviewer-a",
    resolution: "reproduce after tariff refresh before any renewal",
  };
}

function artifact(overrides = {}) {
  const accounts = Array.from({ length: 20 }, (_, i) => ({
    id: `acct-${String(i + 1).padStart(2, "0")}`,
    cohort: cohorts[i % cohorts.length], supportedPeriods: 2,
    within2Periods: i === 0 ? 1 : 2, pctWithin2: i === 0 ? 50 : 100,
    maxPctError: i === 0 ? 5.6604 : 0, misses: i === 0 ? [miss()] : [],
  }));
  const base = {
    artifactVersion: 1, artifactId: "cert-2026-09-28-001", status: "draft",
    generatedAt: "2026-09-28T20:00:00Z",
    model: { tool: "tools/backtest-accounts.js", commit, ratesAsOf: "2026-09-28", policyVersion: 1 },
    accuracy: {
      minimumAccounts: 20, passPct: 2, gateFractionPct: 95,
      aggregate: { usableAccounts: 20, supportedPeriods: 40, within2Periods: 39, shareWithin2Pct: 97.5, meanPctError: 0.14, maxPctError: 5.6604 },
      accounts, status: "pass",
    },
    diversity: {
      dimensions: {
        territory: { nyc: 10, westchester: 10 },
        currentPlan: { standard: 10, tou: 10 },
        loadShape: { "winter-peaking": 10, "summer-peaking": 10 },
        meter: { smart: 10, legacy: 10 },
      }, reviewerAttested: true,
    },
    provider: {
      id: "stripe-checkout", status: "pass", testedCommit: commit, testedAt: "2026-09-28T20:05:00Z",
      checks: [
        { id: "fixed-price", result: "pass", command: "node test/checkout.js", evidence: "checkout test output: fixed $29 USD fields" },
        { id: "return-verification", result: "pass", command: "node test/checkout.js", evidence: "checkout test output: mismatched sessions do not unlock" },
      ],
    },
    review: {
      accuracy: { status: "approved", reviewer: "reviewer-a", reviewedAt: "2026-09-28T21:00:00Z", decisionRef: "review-accuracy-001" },
      provider: { status: "approved", reviewer: "reviewer-b", reviewedAt: "2026-09-28T21:05:00Z", decisionRef: "review-provider-001" },
    },
    enablement: {
      chargingCertified: false, providerCertified: false, freeResultPreserved: true,
      changeRef: null, approvedBy: [],
      rollback: { changeRef: "rollback-001", procedure: "disable server bindings, then revert client flags" },
    },
  };
  return merge(base, overrides);
}

function merge(base, overrides) {
  const copy = JSON.parse(JSON.stringify(base));
  Object.keys(overrides).forEach((key) => {
    copy[key] = overrides[key] && typeof overrides[key] === "object" && !Array.isArray(overrides[key])
      ? Object.assign(copy[key] || {}, overrides[key]) : overrides[key];
  });
  return copy;
}

function run(value) {
  const file = path.join(TMP, "artifact.json");
  fs.writeFileSync(file, JSON.stringify(value));
  const result = spawnSync(process.execPath, [path.join(__dirname, "../tools/validate-certification.js"), "--artifact", file], { encoding: "utf8" });
  return { result, file };
}

try {
  console.log("Certification workflow: artifact and enablement contracts");

  const draft = run(artifact());
  assert.strictEqual(draft.result.status, 2, "a structurally valid draft artifact is reported as not yet eligible");
  assert(/"eligible": false/.test(draft.result.stdout), "draft evidence is not eligible to arm flags");

  const approved = artifact({
    status: "approved",
    enablement: {
      chargingCertified: true, providerCertified: true, freeResultPreserved: true,
      changeRef: "release-2026-09-28-cert-001", approvedBy: ["reviewer-a", "reviewer-b"],
      rollback: { changeRef: "rollback-2026-09-28-cert-001", procedure: "disable server bindings, then revert client flags" },
    },
  });
  const approvedRun = run(approved);
  assert.strictEqual(approvedRun.result.status, 0, "approved accuracy and provider evidence is eligible");
  assert(/"eligible": true/.test(approvedRun.result.stdout), "eligible output is explicit");

  const undocumentedMiss = artifact();
  delete undocumentedMiss.accuracy.accounts[0].misses[0].cause;
  const missRun = run(undocumentedMiss);
  assert.strictEqual(missRun.result.status, 1, "a miss without a cause is invalid evidence");
  assert(/cause is required/.test(missRun.result.stderr), "the validation error names the missing miss disposition field");

  const unsafeFreeResult = artifact({ enablement: {
    chargingCertified: true, providerCertified: true, freeResultPreserved: false,
    changeRef: "release-unsafe", approvedBy: ["reviewer-a", "reviewer-b"],
    rollback: { changeRef: "rollback-unsafe", procedure: "disable server bindings" },
  } });
  const freeRun = run(unsafeFreeResult);
  assert.strictEqual(freeRun.result.status, 1, "enabling collection while dropping the free result is invalid");

  const providerPending = artifact({ provider: { status: "pending" } });
  const providerRun = run(providerPending);
  assert.strictEqual(providerRun.result.status, 2, "provider evidence can be structurally valid but not eligible");
  assert(/payment provider certification is not passing/.test(providerRun.result.stdout), "missing provider certification is explicit");

  const rates = JSON.parse(fs.readFileSync(path.join(__dirname, "../public/rates.json"), "utf8"));
  assert.strictEqual(rates.pricing.chargingCertified, false, "the repository ships with charging disabled");
  assert.strictEqual(rates.pricing.providerCertified, false, "the repository ships with provider collection disabled");
  const runbook = fs.readFileSync(path.join(__dirname, "../docs/notes/certification-enablement.md"), "utf8");
  assert(/free-result invariant/.test(runbook), "the runbook preserves the free-result invariant");
  assert(/every miss/i.test(runbook), "the runbook requires every miss to be documented");
  assert(/distinct approvers/.test(runbook), "the runbook requires controlled two-person enablement");
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log("Certification workflow: all checks passed");
