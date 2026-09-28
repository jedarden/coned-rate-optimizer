/* Deterministic tests for scripts/smoke-gbc-production.js. */
"use strict";

const assert = require("assert");
const { SmokeFailure, runSmoke } = require("../scripts/smoke-gbc-production.js");

function response(status, body) {
  return {
    status,
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
  const missing = fakeFetch([response(503, { error: "gbc_not_configured" })]);
  await expectFailure(runSmoke("https://example.test/api/gbc/token", missing), "missing_bindings");
  assert.strictEqual(missing.calls.length, 1, "missing bindings stop before an upstream probe");

  const invalidClient = fakeFetch([
    response(400, { error: "invalid_request" }),
    response(401, { error: "invalid_client", error_description: "withheld" })
  ]);
  await expectFailure(runSmoke("https://example.test/api/gbc/token", invalidClient), "upstream_authentication");
  assert.strictEqual(invalidClient.calls.length, 2, "client authentication failure reaches the upstream once");

  const healthy = fakeFetch([
    response(400, { error: "invalid_request" }),
    response(400, { error: "invalid_grant", error_description: "withheld" })
  ]);
  const result = await runSmoke("https://example.test/api/gbc/token", healthy);
  assert.deepStrictEqual(result, { ok: true, preflightStatus: 400, upstreamStatus: 400 });
  assert.strictEqual(healthy.calls.length, 2, "healthy check makes exactly two requests");
  assert.strictEqual(healthy.calls[0].options.body, "not-json");
  const exchange = JSON.parse(healthy.calls[1].options.body);
  assert.deepStrictEqual(Object.keys(exchange).sort(), ["code", "redirectUri"]);
  assert.match(exchange.code, /^gbc-smoke-/);
  assert.strictEqual(exchange.redirectUri, "https://example.test/");
  assert(!healthy.calls[1].options.headers.authorization, "smoke client sends no credential");

  const unreachable = fakeFetch([response(400, { error: "invalid_request" }), new Error("network")]);
  await expectFailure(runSmoke("https://example.test/api/gbc/token", unreachable), "unreachable");

  console.log("GBC production smoke tests: 4 passed");
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
