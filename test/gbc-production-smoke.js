/* Deterministic tests for scripts/smoke-gbc-production.js. */
"use strict";

const assert = require("assert");
const { SmokeFailure, runSmoke, verifyPublicConfig } = require("../scripts/smoke-gbc-production.js");
const { startSandbox } = require("./gbc-sandbox.js");
const gbc = require("../public/gbc.js");
const tokenWorker = require("../functions/api/gbc/token.js");

function response(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body)
  };
}

function fakeFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

async function expectFailure(promise, expectedCode) {
  await assert.rejects(promise, (error) => {
    assert(error instanceof SmokeFailure);
    assert.strictEqual(error.code, expectedCode);
    return true;
  });
}

(async () => {
  const missing = fakeFetch([
    response(403, { error: "origin_not_allowed" }),
    response(503, { error: "gbc_not_configured" })
  ]);
  await expectFailure(runSmoke("https://example.test/api/gbc/token", missing), "missing_bindings");
  assert.strictEqual(missing.calls.length, 2, "missing bindings stop before an upstream probe");
  assert.strictEqual(missing.calls[0].options.headers.origin, "https://foreign.invalid");

  const invalidClient = fakeFetch([
    response(403, { error: "origin_not_allowed" }),
    response(400, { error: "invalid_request" }),
    response(401, { error: "invalid_client", error_description: "withheld" })
  ]);
  await expectFailure(runSmoke("https://example.test/api/gbc/token", invalidClient), "upstream_authentication");
  assert.strictEqual(invalidClient.calls.length, 3, "client authentication failure reaches the upstream once");

  const healthy = fakeFetch([
    response(403, { error: "origin_not_allowed" }),
    response(400, { error: "invalid_request" }),
    response(400, { error: "invalid_grant", error_description: "withheld" })
  ]);
  const result = await runSmoke("https://example.test/api/gbc/token", healthy);
  assert.deepStrictEqual(result, { ok: true, foreignStatus: 403, preflightStatus: 400, upstreamStatus: 400 });
  assert.strictEqual(healthy.calls.length, 3, "healthy check makes the guard, preflight, and exchange requests");
  assert.strictEqual(healthy.calls[1].options.body, "not-json");
  assert.strictEqual(healthy.calls[1].options.headers.origin, "https://example.test");
  const exchange = JSON.parse(healthy.calls[2].options.body);
  assert.deepStrictEqual(Object.keys(exchange).sort(), ["code", "redirectUri"]);
  assert.match(exchange.code, /^gbc-smoke-/);
  assert.strictEqual(exchange.redirectUri, "https://example.test/");
  assert(!healthy.calls[2].options.headers.authorization, "smoke client sends no credential");
  assert(!healthy.calls[2].options.body.includes("IntervalReading"), "exchange body has no interval data");
  assert(!healthy.calls[2].options.body.includes("UsageSummary"), "exchange body has no billing data");

  const unreachable = fakeFetch([
    response(403, { error: "origin_not_allowed" }),
    response(400, { error: "invalid_request" }),
    new Error("network")
  ]);
  await expectFailure(runSmoke("https://example.test/api/gbc/token", unreachable), "unreachable");

  const config = fakeFetch([response(200, {
    configured: true,
    clientId: "registered-client",
    authorizeUrl: "https://coned.example/authorize",
    apiBase: "https://coned.example",
    redirectUri: "https://example.test/",
    scopes: ["USAGE_READ"],
    tokenExchangePath: "/api/gbc/token"
  })]);
  const publicConfig = await verifyPublicConfig("https://example.test/api/gbc/token", config);
  assert.strictEqual(publicConfig.redirectUri, "https://example.test/");
  assert.strictEqual(config.calls[0].url, "https://example.test/gbc-config.json");

  const badRedirect = fakeFetch([response(200, {
    configured: true,
    clientId: "registered-client",
    authorizeUrl: "https://coned.example/authorize",
    apiBase: "https://coned.example",
    redirectUri: "https://other.example/",
    scopes: ["USAGE_READ"],
    tokenExchangePath: "/api/gbc/token"
  })]);
  await expectFailure(
    verifyPublicConfig("https://example.test/api/gbc/token", badRedirect),
    "redirect_mismatch"
  );

  // Deployment contract smoke: use the same disposable OAuth/Data Custodian
  // that backs the full sandbox, but keep this check focused on the four
  // production boundaries named by the runbook.
  const box = await startSandbox();
  try {
    const redirectUri = gbc.buildRedirectUri({ origin: box.origin }, box.config.redirectUri);
    const state = gbc.randomState();
    const authorization = await fetch(gbc.authorizeUrl(box.config, state, redirectUri), { redirect: "manual" });
    const callbackLocation = new URL(authorization.headers.get("location"));
    const callback = gbc.parseCallback(callbackLocation.search, state);
    assert(callback.ok && callback.code, "authorization callback accepts the matching code and state");

    const foreign = await tokenWorker.onRequestPost({
      request: new Request(box.origin + "/api/gbc/token", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://foreign.invalid" },
        body: JSON.stringify({ code: callback.code, redirectUri })
      }),
      env: {
        GBC_CLIENT_ID: box.clientId,
        GBC_CLIENT_SECRET: box.clientSecret,
        GBC_TOKEN_URL: box.origin + "/token"
      }
    });
    assert.strictEqual(foreign.status, 403, "foreign-origin token relay is rejected");
    assert.strictEqual((await foreign.json()).error, "origin_not_allowed");

    const conn = await gbc.connect(box.config, callback.code, redirectUri);
    const feeds = await gbc.refreshFeeds(box.config, conn);
    assert.strictEqual(feeds.parsed.intervals, 72, "authorized interval feed is fetched directly");
    assert.strictEqual(feeds.billingEntries, 1, "authorized billing feed is fetched directly");

    const appPosts = box.requests.filter((request) => request.method === "POST" &&
      request.url.split("?")[0] === "/api/gbc/token");
    assert(appPosts.length > 0 && appPosts.every((request) => {
      const body = JSON.parse(request.body);
      return Object.keys(body).sort().join(",") === "code,redirectUri" &&
        !request.body.includes("IntervalReading") && !request.body.includes("UsageSummary") &&
        !request.body.includes(box.accessToken);
    }), "token endpoint receives only code and redirect URI, never usage, billing, or token bytes");
    const feedRequests = box.requests.filter((request) => request.url.split("?")[0].startsWith("/espi/"));
    assert(feedRequests.length > 0 && feedRequests.every((request) => request.method === "GET"),
      "Data Custodian feeds are retrieved as direct browser/client GETs");
  } finally {
    await box.stop();
  }

  console.log("GBC production smoke tests: 10 passed");
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
