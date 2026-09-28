/* Deterministic checkout contract tests. Stripe is replaced by a fetch stub;
 * the real browser adapter and Pages Functions still run unchanged. */
"use strict";

const assert = require("assert");
const checkoutProvider = require("../public/checkout.js");
const calc = require("../public/calc.js");
const create = require("../functions/api/checkout/create.js");
const session = require("../functions/api/checkout/session.js");

function response(body, status) {
  return { ok: (status || 200) < 400, status: status || 200, json: async () => body };
}

function request(url, method, body, origin) {
  return new Request(url, {
    method: method || "GET",
    headers: Object.assign({ origin: origin || new URL(url).origin }, body ? { "content-type": "application/json" } : {}),
    body: body ? JSON.stringify(body) : undefined
  });
}

async function run() {
  console.log("Checkout: provider and certification paths");
  let calls = [];
  const location = { search: "", assigned: null, assign(url) { this.assigned = url; } };
  const provider = checkoutProvider({
    config: { createEndpoint: "/create", sessionEndpoint: "/session" }, location,
    fetch: async (url, init) => { calls.push({ url, init }); return response({ status: "succeeded", sessionId: "cs_fixture" }); }
  });
  const success = await provider.charge({
    product: "report", amount: 29, currency: "usd", policyVersion: 1,
    accountId: "acct_private", usage: { intervals: [{ kwh: 999 }] }, billing: { total: 99999 }
  });
  assert.strictEqual(success.status, "succeeded", "successful provider checkout resolves");
  assert.strictEqual(calls[0].url, "/create", "the adapter uses the configured create endpoint");
  assert.deepStrictEqual(JSON.parse(calls[0].init.body), { product: "report", policyVersion: 1 },
    "the browser sends only the fixed product and policy version to checkout");

  const cancelled = checkoutProvider({
    fetch: async () => response({ status: "cancelled" }), location: { search: "", assign() {} }
  });
  await assert.rejects(() => cancelled.charge({ product: "report", amount: 29, currency: "usd", policyVersion: 1 }),
    (e) => e.code === "CHECKOUT_CANCELLED", "cancelled checkout is not treated as paid");

  const failed = checkoutProvider({ fetch: async () => response({ code: "provider_error" }, 502) });
  await assert.rejects(() => failed.charge({ product: "report", amount: 29, currency: "usd", policyVersion: 1 }),
    (e) => e.code === "CHECKOUT_FAILED", "provider failure remains a failed checkout");

  const ineligible = checkoutProvider({ fetch: async () => response({ status: "succeeded" }) });
  await assert.rejects(() => ineligible.charge({ product: "report", amount: 28, currency: "usd" }),
    (e) => e.code === "CHECKOUT_INELIGIBLE", "a non-$29 request is rejected before provider use");
  await assert.rejects(() => ineligible.charge({ product: "report", amount: 29, currency: "usd", policyVersion: 2 }),
    (e) => e.code === "CHECKOUT_INELIGIBLE", "a stale pricing policy cannot start checkout");

  const resumed = checkoutProvider({
    location: { search: "?checkout=success&session_id=cs_fixture", assign() {} },
    fetch: async (url) => { assert(url.includes("session_id=cs_fixture")); return response({ status: "succeeded" }); }
  });
  assert.strictEqual((await resumed.resume()).status, "succeeded", "a returned session is verified before unlock");
  const resumedCancel = checkoutProvider({ location: { search: "?checkout=cancelled" } });
  assert.strictEqual((await resumedCancel.resume()).status, "cancelled", "cancel return is preserved");

  const baseEnv = { REPORT_CHARGING_CERTIFIED: "true", PAYMENT_PROVIDER_CERTIFIED: "true", STRIPE_SECRET_KEY: "fixture-key" };
  const unavailable = await create.onRequestPost({ request: request("https://app.test/api/checkout/create", "POST", { product: "report" }), env: {} });
  assert.strictEqual(unavailable.status, 503, "uncertified server keeps checkout unavailable");

  let stripeCall;
  const originalFetch = global.fetch;
  try {
    global.fetch = async (url, init) => {
      stripeCall = { url, init };
      return response({ id: "cs_fixture", url: "https://checkout.stripe.test/session" });
    };
    const made = await create.onRequestPost({
      request: request("https://app.test/api/checkout/create", "POST", {
        product: "report", policyVersion: 1,
        amount: 0, currency: "eur", accountId: "acct_private",
        usage: { intervals: [{ start: "2026-01-01T00:00:00-05:00", kwh: 999 }] },
        billing: { total: 99999, periods: [{ start: "2026-01-01", end: "2026-02-01" }] }
      }), env: baseEnv
    });
    assert.strictEqual(made.status, 200, "certified provider creates hosted checkout");
    const stripeForm = new URLSearchParams(stripeCall.init.body);
    const fixedStripeKeys = [
      "mode", "line_items[0][price_data][currency]", "line_items[0][price_data][unit_amount]",
      "line_items[0][price_data][product_data][name]", "line_items[0][quantity]",
      "success_url", "cancel_url", "metadata[product]", "metadata[amount_cents]", "metadata[policy_version]"
    ];
    assert.deepStrictEqual(Array.from(stripeForm.keys()).sort(), fixedStripeKeys.sort(),
      "Stripe receives only the fixed checkout form fields");
    assert.strictEqual(stripeForm.get("mode"), "payment", "checkout mode is fixed to one-time payment");
    assert.strictEqual(stripeForm.get("line_items[0][quantity]"), "1", "the fixed report quantity is sent");
    assert.strictEqual(stripeForm.get("line_items[0][price_data][currency]"), "usd", "checkout currency is fixed to USD");
    assert.strictEqual(stripeForm.get("line_items[0][price_data][unit_amount]"), "2900", "the server sends the fixed $29 report price");
    assert.strictEqual(stripeForm.get("metadata[product]"), "report", "checkout metadata names only the report product");
    assert.strictEqual(stripeForm.get("metadata[amount_cents]"), "2900", "checkout metadata carries the fixed amount");
    assert.strictEqual(stripeForm.get("metadata[policy_version]"), "1", "checkout metadata carries the fixed policy version");
    assert(!stripeCall.init.body.includes("acct_private") && !stripeCall.init.body.includes("intervals") &&
      !stripeCall.init.body.includes("billing") && !stripeCall.init.body.includes("99999"),
    "usage, billing, account, and caller-supplied pricing data never reach Stripe");

    for (const invalid of [
      { product: "concierge", policyVersion: 1 },
      { product: "report", policyVersion: 2 },
      { product: "report" }
    ]) {
      let forwarded = false;
      global.fetch = async () => { forwarded = true; return response({ id: "unexpected", url: "https://unexpected.test" }); };
      const rejected = await create.onRequestPost({
        request: request("https://app.test/api/checkout/create", "POST", invalid), env: baseEnv
      });
      assert.strictEqual(rejected.status, 400, `invalid checkout request is rejected (${JSON.stringify(invalid)})`);
      assert.strictEqual(forwarded, false, "invalid checkout input is rejected before contacting Stripe");
    }

    const validSession = {
      id: "cs_fixture", mode: "payment", status: "complete", payment_status: "paid", amount_total: 2900,
      currency: "usd", metadata: { product: "report", amount_cents: "2900", policy_version: "1" }
    };
    global.fetch = async () => response(validSession);
    const verified = await session.onRequestGet({ request: request("https://app.test/api/checkout/session?session_id=cs_fixture"), env: baseEnv });
    assert.strictEqual(verified.status, 200, "a paid matching session verifies successfully");
    assert.deepStrictEqual(await verified.json(), { status: "succeeded", sessionId: "cs_fixture" },
      "successful verification returns only the unlock decision and session id");

    global.fetch = async () => response(Object.assign({}, validSession, { status: "expired", payment_status: "unpaid" }));
    const expired = await session.onRequestGet({ request: request("https://app.test/api/checkout/session?session_id=cs_fixture"), env: baseEnv });
    assert.strictEqual((await expired.json()).status, "cancelled", "an expired hosted session is cancelled, not paid");

    const identityMismatches = [
      ["payment mode", (s) => { s.mode = "subscription"; }],
      ["product metadata", (s) => { s.metadata.product = "concierge"; }],
      ["amount metadata", (s) => { s.metadata.amount_cents = "1"; }],
      ["policy metadata", (s) => { s.metadata.policy_version = "2"; }],
      ["currency", (s) => { s.currency = "eur"; }],
      ["amount", (s) => { s.amount_total = 1; }]
    ];
    for (const [field, mutate] of identityMismatches) {
      const mismatched = JSON.parse(JSON.stringify(validSession));
      mutate(mismatched);
      global.fetch = async () => response(mismatched);
      const rejected = await session.onRequestGet({ request: request("https://app.test/api/checkout/session?session_id=cs_fixture"), env: baseEnv });
      assert.strictEqual(rejected.status, 502, `mismatched ${field} is rejected before report unlock`);
      assert.notStrictEqual((await rejected.json()).status, "succeeded", `mismatched ${field} cannot unlock the report`);
    }

    for (const [field, mutate] of [
      ["completion", (s) => { s.status = "open"; }],
      ["payment status", (s) => { s.payment_status = "unpaid"; }]
    ]) {
      const incomplete = JSON.parse(JSON.stringify(validSession));
      mutate(incomplete);
      global.fetch = async () => response(incomplete);
      const pending = await session.onRequestGet({ request: request("https://app.test/api/checkout/session?session_id=cs_fixture"), env: baseEnv });
      assert.strictEqual(pending.status, 200, `valid identity with wrong ${field} remains a provider response`);
      assert.strictEqual((await pending.json()).status, "pending", `wrong ${field} never unlocks the report`);
    }

    global.fetch = async () => response(validSession);
    const matchingSession = await session.onRequestGet({ request: request("https://app.test/api/checkout/session?session_id=cs_fixture"), env: baseEnv });
    assert.strictEqual(matchingSession.status, 200, "a matching completed session remains verifiable");

    const pendingProvider = checkoutProvider({
      location: { search: "?checkout=success&session_id=cs_fixture", assign() {} },
      fetch: async () => response({ status: "pending" })
    });
    assert.strictEqual((await pendingProvider.resume()).status, "pending", "the browser keeps an unverified return pending");
  } finally {
    global.fetch = originalFetch;
  }

  console.log("Checkout: offer-gate boundaries");
  const P = calc.RATES.pricing;
  const originalFlags = { chargingCertified: P.chargingCertified, providerCertified: P.providerCertified, provider: P.provider };
  const qualified = {
    annualFactor: 1,
    plans: [
      { key: "standard", name: "Standard Residential", current: true, avail: true, cost: 1000 },
      { key: "tou", name: "Time-of-Use", current: false, avail: true, cost: 700, lockIn: "one year" }
    ],
    switchTarget: { key: "tou", name: "Time-of-Use", cost: 700, avail: true, current: false, lockIn: "one year" },
    eligibility: { blockers: [] }, confidence: { level: "high" },
    savings: { estimate: 200, low: P.threshold + 1, high: 250 }
  };
  try {
    const atThreshold = calc.paidConversion(Object.assign({}, qualified, {
      savings: { estimate: 200, low: P.threshold, high: 250 }
    }));
    assert.strictEqual(atThreshold.threshold.cleared, false, "the offer threshold is strictly greater than the configured boundary");
    assert.strictEqual(atThreshold.eligible, false, "a savings range ending exactly at the threshold is not offered");
    assert.strictEqual(atThreshold.offer, null, "the exact threshold keeps the free result as the complete result");

    const aboveThreshold = calc.paidConversion(qualified);
    assert.strictEqual(aboveThreshold.eligible, true, "a savings range one dollar above the threshold is eligible");
    assert(aboveThreshold.offer && aboveThreshold.offer.product === "report" && aboveThreshold.offer.price === 29,
      "an eligible result offers only the fixed $29 report product");
    assert.strictEqual(aboveThreshold.collectible, false, "an eligible offer is not collectible before deployment certification");

    const noSavings = calc.paidConversion(Object.assign({}, qualified, { switchTarget: null,
      savings: { estimate: 0, low: 0, high: 0 } }));
    assert.strictEqual(noSavings.offer, null, "a no-savings result never offers a paid report");
    assert(noSavings.noSavings && /nothing about this result is hidden behind payment/.test(noSavings.noSavings.message),
      "the no-savings boundary explains that nothing is hidden behind payment");

    const blocked = calc.paidConversion(Object.assign({}, qualified, { eligibility: { blockers: ["not SC1"] } }));
    assert.strictEqual(blocked.offer, null, "an ineligible account cannot reach the paid offer gate");

    const lowConfidence = calc.paidConversion(Object.assign({}, qualified, { confidence: { level: "low" } }));
    assert.strictEqual(lowConfidence.eligible, false, "a failed bill-confidence gate prevents a charge");
    assert(lowConfidence.reasons.some((reason) => /model disagrees/.test(reason)),
      "the failed confidence gate names why the report is not chargeable");

    const staleTarget = calc.paidConversion(Object.assign({}, qualified, {
      plans: qualified.plans.map((plan) => plan.key === "tou" ? Object.assign({}, plan, { avail: false }) : plan)
    }));
    assert.strictEqual(staleTarget.eligible, false, "a hand-built target cannot bypass the plan eligibility gate");

    P.chargingCertified = true;
    P.providerCertified = false;
    const untrustedProvider = calc.paidConversion(qualified);
    assert.strictEqual(untrustedProvider.collectible, false, "provider certification is an independent collection gate");
    assert(untrustedProvider.reasons.some((reason) => /provider is not certified/.test(reason)),
      "the unavailable offer names the missing provider certification");

    P.providerCertified = true;
    const collectible = calc.paidConversion(qualified);
    assert.strictEqual(collectible.collectible, true, "both independent certifications are required before collection");
  } finally {
    P.chargingCertified = originalFlags.chargingCertified;
    P.providerCertified = originalFlags.providerCertified;
    P.provider = originalFlags.provider;
  }
  console.log("Checkout: successful, cancelled, failed, and ineligible paths passed");
}

run().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
