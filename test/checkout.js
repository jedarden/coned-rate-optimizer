/* End-to-end checkout contract tests. Stripe is replaced by a fetch stub;
 * the real browser adapter, Pages Functions, and payment state machine still
 * run unchanged through the composed browser-to-provider paths. */
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
    const foreignCreate = await create.onRequestPost({
      request: request("https://app.test/api/checkout/create", "POST", { product: "report", policyVersion: 1 }, "https://evil.test"),
      env: baseEnv
    });
    assert.strictEqual(foreignCreate.status, 403, "cross-origin create is rejected before contacting Stripe");
    assert.strictEqual(stripeCall, undefined, "cross-origin create never reaches the provider");

    const contaminated = await create.onRequestPost({
      request: request("https://app.test/api/checkout/create", "POST", {
        product: "report", policyVersion: 1,
        amount: 0, currency: "eur", accountId: "acct_private",
        usage: { intervals: [{ start: "2026-01-01T00:00:00-05:00", kwh: 999 }] },
        billing: { total: 99999, periods: [{ start: "2026-01-01", end: "2026-02-01" }] }
      }), env: baseEnv
    });
    assert.strictEqual(contaminated.status, 400,
      "the create endpoint rejects usage, billing, account, and caller-supplied pricing fields");
    assert.strictEqual(stripeCall, undefined, "contaminated create input never reaches the provider");

    const made = await create.onRequestPost({
      request: request("https://app.test/api/checkout/create", "POST", { product: "report", policyVersion: 1 }),
      env: baseEnv
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
    assert.strictEqual(stripeForm.get("line_items[0][price_data][product_data][name]"),
      "ConEd Rate Optimizer self-service report", "the checkout product name is fixed");
    assert.strictEqual(stripeForm.get("metadata[product]"), "report", "checkout metadata names only the report product");
    assert.strictEqual(stripeForm.get("metadata[amount_cents]"), "2900", "checkout metadata carries the fixed amount");
    assert.strictEqual(stripeForm.get("metadata[policy_version]"), "1", "checkout metadata carries the fixed policy version");
    assert(!stripeCall.init.body.includes("acct_private") && !stripeCall.init.body.includes("intervals") &&
      !stripeCall.init.body.includes("billing") && !stripeCall.init.body.includes("99999"),
    "usage, billing, account, and caller-supplied pricing data never reach Stripe");

    // Compose the real browser adapter with both Pages Functions. The only
    // provider stub is the hosted-payment boundary; the browser request and
    // server verification still cross the same interfaces as production.
    const validSession = {
      id: "cs_fixture", mode: "payment", status: "complete", payment_status: "paid", amount_total: 2900,
      currency: "usd", metadata: { product: "report", amount_cents: "2900", policy_version: "1" }
    };
    const browserLocation = { search: "", assigned: null, assign(url) { this.assigned = url; } };
    const browserRequests = [];
    let providerSession = validSession;
    const serverFetch = async (url, init) => {
      const absolute = new URL(url, "https://app.test");
      browserRequests.push({ url: absolute, init });
      if (absolute.pathname === "/api/checkout/create") {
        const savedFetch = global.fetch;
        try {
          global.fetch = async () => response({ id: "cs_fixture", url: "https://checkout.stripe.test/session" });
          const created = await create.onRequestPost({
            request: new Request(absolute, init), env: baseEnv
          });
          return created;
        } finally { global.fetch = savedFetch; }
      }
      if (absolute.pathname === "/api/checkout/session") {
        const savedFetch = global.fetch;
        try {
          global.fetch = async () => response(providerSession);
          return await session.onRequestGet({ request: new Request(absolute, init), env: baseEnv });
        } finally { global.fetch = savedFetch; }
      }
      throw new Error("unexpected browser request: " + absolute.pathname);
    };
    const hosted = checkoutProvider({
      location: browserLocation,
      fetch: serverFetch
    });
    const redirect = await hosted.charge({
      product: "report", amount: 29, currency: "usd", policyVersion: 1,
      usage: { intervals: [{ kwh: 999 }] }, billing: { total: 99999 }
    });
    assert.strictEqual(redirect.status, "redirect", "the browser follows create into hosted checkout");
    assert.strictEqual(browserLocation.assigned, "https://checkout.stripe.test/session",
      "the hosted provider URL is handed to the browser");
    assert.deepStrictEqual(JSON.parse(browserRequests[0].init.body), { product: "report", policyVersion: 1 },
      "the composed browser-to-server request has exactly product and policyVersion");
    assert.strictEqual(browserRequests[0].init.method, "POST", "create uses POST");
    assert.strictEqual(browserRequests[0].init.body.includes("acct_private"), false,
      "account data is absent from the composed browser request");
    assert.strictEqual(browserRequests[0].init.body.includes("intervals"), false,
      "usage data is absent from the composed browser request");
    assert.strictEqual(browserRequests[0].init.body.includes("99999"), false,
      "billing data is absent from the composed browser request");

    let endToEndFlow = calc.paymentTransition(calc.newPaymentFlow(), "verdict", {
      paid: { eligible: true, collectible: true, reasons: [], noSavings: null }
    });
    endToEndFlow = calc.paymentTransition(endToEndFlow, "consent", {
      consent: { version: 1, sawPrice: true, sawContents: true, sawNoAffiliation: true,
        sawEstimateCaveat: true, authorizesCharge: true, grantedAt: 1700000000000 }
    });
    endToEndFlow = calc.paymentTransition(endToEndFlow, "charge");
    endToEndFlow = calc.paymentTransition(endToEndFlow, "redirected");
    const redirectingFlow = endToEndFlow;
    assert.strictEqual(endToEndFlow.state, "redirecting", "a create response never unlocks before return verification");
    browserLocation.search = "?checkout=success&session_id=cs_fixture";
    const verifiedReturn = await hosted.resume();
    assert.strictEqual(verifiedReturn.status, "succeeded", "the browser return uses the verified session outcome");
    assert.strictEqual(browserRequests[1].url.toString(),
      "https://app.test/api/checkout/session?session_id=cs_fixture",
    "return verification sends only the provider session id");
    assert.strictEqual(browserRequests[1].init.method, "GET", "return verification uses GET");
    assert.strictEqual(browserRequests[1].init.body, undefined, "return verification has no request body");
    endToEndFlow = calc.paymentTransition(endToEndFlow, "checkout_succeeded", {}, { now: 1700000000000 });
    assert.strictEqual(endToEndFlow.state, "paid", "only the verified hosted session unlocks the report");
    assert.strictEqual(browserRequests.length, 2, "the composed flow makes one create and one verify request");

    let successOnlyCalls = 0;
    const successOnly = checkoutProvider({
      location: { search: "?checkout=success", assign() {} },
      fetch: async () => { successOnlyCalls += 1; return response({ status: "succeeded" }); }
    });
    await assert.rejects(() => successOnly.resume(), (e) => e.code === "CHECKOUT_FAILED",
      "a success query without a provider session id cannot unlock the report");
    assert.strictEqual(successOnlyCalls, 0, "a success query alone never calls the verification endpoint");

    browserLocation.search = "?checkout=cancelled";
    const cancelledReturn = await hosted.resume();
    assert.strictEqual(cancelledReturn.status, "cancelled", "provider cancellation returns a non-paid outcome");
    const cancelledFlow = calc.paymentTransition(redirectingFlow, "checkout_cancelled");
    assert.strictEqual(cancelledFlow.state, "cancelled", "a hosted cancellation preserves the free result");

    providerSession = Object.assign({}, validSession, { status: "open", payment_status: "unpaid" });
    browserLocation.search = "?checkout=success&session_id=cs_fixture";
    const pendingReturn = await hosted.resume();
    assert.strictEqual(pendingReturn.status, "pending", "an uncompleted provider session does not unlock");
    const pendingFlow = calc.paymentTransition(redirectingFlow, "checkout_failed");
    assert.notStrictEqual(pendingFlow.state, "paid", "an uncompleted provider session cannot unlock");

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

    let providerSessionRequest;
    global.fetch = async (url, init) => {
      providerSessionRequest = { url, init };
      return response(validSession);
    };
    const verified = await session.onRequestGet({ request: request("https://app.test/api/checkout/session?session_id=cs_fixture"), env: baseEnv });
    assert.strictEqual(verified.status, 200, "a paid matching session verifies successfully");
    assert.deepStrictEqual(await verified.json(), { status: "succeeded", sessionId: "cs_fixture" },
      "successful verification returns only the unlock decision and session id");
    assert.strictEqual(providerSessionRequest.url,
      "https://api.stripe.com/v1/checkout/sessions/cs_fixture", "verification fetches only the requested provider session");
    assert.strictEqual(providerSessionRequest.init.body, undefined, "verification sends no provider request body");

    global.fetch = async () => response(Object.assign({}, validSession, { status: "expired", payment_status: "unpaid" }));
    const expired = await session.onRequestGet({ request: request("https://app.test/api/checkout/session?session_id=cs_fixture"), env: baseEnv });
    assert.strictEqual((await expired.json()).status, "cancelled", "an expired hosted session is cancelled, not paid");

    const identityMismatches = [
      ["session id", (s) => { s.id = "cs_other"; }],
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

    global.fetch = async () => { throw new Error("cross-origin request must not reach provider"); };
    const foreignSession = await session.onRequestGet({
      request: request("https://app.test/api/checkout/session?session_id=cs_fixture", "GET", undefined, "https://evil.test"),
      env: baseEnv
    });
    assert.strictEqual(foreignSession.status, 403, "cross-origin return verification is rejected before contacting Stripe");

    global.fetch = async () => { throw new Error("provider must not be called"); };
    const contaminatedReturn = await session.onRequestGet({
      request: request("https://app.test/api/checkout/session?session_id=cs_fixture&accountId=acct_private&usage=intervals&billing=99999"),
      env: baseEnv
    });
    assert.strictEqual(contaminatedReturn.status, 400,
      "return verification rejects account, usage, and billing query parameters");

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

    // A provider error is a retryable checkout failure, not a report unlock.
    let providerFailures = 0;
    const failingProvider = checkoutProvider({
      fetch: async () => { providerFailures += 1; return response({ code: "provider_error" }, 502); },
      location: { search: "", assign() {} }
    });
    const retryConsent = { version: P.policyVersion, sawPrice: true, sawContents: true,
      sawNoAffiliation: true, sawEstimateCaveat: true, authorizesCharge: true, grantedAt: 1700000000000 };
    let failedFlow = calc.paymentTransition(calc.newPaymentFlow(), "verdict", { paid: collectible });
    failedFlow = calc.paymentTransition(failedFlow, "consent", { consent: retryConsent });
    for (let attempt = 1; attempt <= P.maxPaymentAttempts; attempt += 1) {
      failedFlow = calc.paymentTransition(failedFlow, "charge");
      await assert.rejects(() => failingProvider.charge({ product: "report", amount: 29, currency: "usd", policyVersion: 1 }),
        (e) => e.code === "CHECKOUT_FAILED", "a provider error stays a failed checkout");
      failedFlow = calc.paymentTransition(failedFlow, "charge_failed");
      if (attempt < P.maxPaymentAttempts) {
        assert.strictEqual(failedFlow.state, "failed", "a provider error leaves a bounded retry available");
      }
    }
    assert.strictEqual(providerFailures, P.maxPaymentAttempts, "provider failures are attempted only up to the configured bound");
    assert.strictEqual(failedFlow.state, "abandoned", "the final provider failure withdraws the offer");
    assert.strictEqual(calc.paymentTransition(failedFlow, "charge").state, "abandoned",
      "an exhausted checkout cannot start a fourth attempt");
    assert.strictEqual(calc.paidConversion(qualified).eligible, true,
      "provider failure leaves the free eligible result available");

    // Every certification flag combination is fail-closed on the server. The
    // browser gate is checked separately below because it is an independent
    // deployment decision, not a provider response.
    for (const disabled of [
      { REPORT_CHARGING_CERTIFIED: "false", PAYMENT_PROVIDER_CERTIFIED: "true" },
      { REPORT_CHARGING_CERTIFIED: "true", PAYMENT_PROVIDER_CERTIFIED: "false" },
      { REPORT_CHARGING_CERTIFIED: "false", PAYMENT_PROVIDER_CERTIFIED: "false" }
    ]) {
      const disabledEnv = Object.assign({}, baseEnv, disabled);
      const disabledResult = await create.onRequestPost({
        request: request("https://app.test/api/checkout/create", "POST", { product: "report", policyVersion: 1 }),
        env: disabledEnv
      });
      assert.strictEqual(disabledResult.status, 503,
        "a disabled certification flag keeps server checkout unavailable");
    }
    P.chargingCertified = false;
    P.providerCertified = true;
    assert.strictEqual(calc.paidConversion(qualified).collectible, false,
      "disabled charging certification keeps the browser offer non-collectible");
    P.chargingCertified = true;
    P.providerCertified = false;
    assert.strictEqual(calc.paidConversion(qualified).collectible, false,
      "disabled provider certification keeps the browser offer non-collectible");
  } finally {
    P.chargingCertified = originalFlags.chargingCertified;
    P.providerCertified = originalFlags.providerCertified;
    P.provider = originalFlags.provider;
  }
  console.log("Checkout: successful, cancelled, failed, and ineligible paths passed");
}

run().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
