/* Deterministic checkout contract tests. Stripe is replaced by a fetch stub;
 * the real browser adapter and Pages Functions still run unchanged. */
"use strict";

const assert = require("assert");
const checkoutProvider = require("../public/checkout.js");
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
  const success = await provider.charge({ product: "report", amount: 29, currency: "usd", policyVersion: 1 });
  assert.strictEqual(success.status, "succeeded", "successful provider checkout resolves");
  assert.strictEqual(calls[0].url, "/create", "the adapter uses the configured create endpoint");

  const cancelled = checkoutProvider({
    fetch: async () => response({ status: "cancelled" }), location: { search: "", assign() {} }
  });
  await assert.rejects(() => cancelled.charge({ product: "report", amount: 29, currency: "usd" }),
    (e) => e.code === "CHECKOUT_CANCELLED", "cancelled checkout is not treated as paid");

  const failed = checkoutProvider({ fetch: async () => response({ code: "provider_error" }, 502) });
  await assert.rejects(() => failed.charge({ product: "report", amount: 29, currency: "usd" }),
    (e) => e.code === "CHECKOUT_FAILED", "provider failure remains a failed checkout");

  const ineligible = checkoutProvider({ fetch: async () => response({ status: "succeeded" }) });
  await assert.rejects(() => ineligible.charge({ product: "report", amount: 28, currency: "usd" }),
    (e) => e.code === "CHECKOUT_INELIGIBLE", "a non-$29 request is rejected before provider use");

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
      request: request("https://app.test/api/checkout/create", "POST", { product: "report", policyVersion: 1 }), env: baseEnv
    });
    assert.strictEqual(made.status, 200, "certified provider creates hosted checkout");
    assert(stripeCall.init.body.includes("line_items%5B0%5D%5Bquantity%5D=1"), "the fixed report quantity is sent");
    assert(stripeCall.init.body.includes("line_items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=2900"), "the server sends the fixed $29 report price");

    global.fetch = async () => response({ id: "cs_fixture", mode: "payment", status: "complete", payment_status: "paid", amount_total: 2900, currency: "usd", metadata: { product: "report" } });
    const verified = await session.onRequestGet({ request: request("https://app.test/api/checkout/session?session_id=cs_fixture"), env: baseEnv });
    assert.strictEqual(verified.status, 200, "a paid matching session verifies successfully");

    global.fetch = async () => response({ id: "cs_fixture", mode: "payment", status: "expired", payment_status: "unpaid", amount_total: 2900, currency: "usd", metadata: { product: "report" } });
    const expired = await session.onRequestGet({ request: request("https://app.test/api/checkout/session?session_id=cs_fixture"), env: baseEnv });
    assert.strictEqual((await expired.json()).status, "cancelled", "an expired hosted session is cancelled, not paid");
  } finally {
    global.fetch = originalFetch;
  }
  console.log("Checkout: successful, cancelled, failed, and ineligible paths passed");
}

run().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
