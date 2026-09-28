/* Production-safe smoke check for the Pages Function's GBC configuration.
 *
 * The checker sends no client credentials to the Pages endpoint. The first
 * request has an intentionally malformed body, which the function rejects
 * before any upstream call; a 503 gbc_not_configured response proves a
 * required binding is missing. The second request uses a fresh synthetic
 * authorization code. A healthy
 * upstream rejects that code as invalid_grant; invalid_client means the Pages
 * bindings reached the upstream but its client authentication failed.
 * Response bodies are inspected only for these machine-readable error codes
 * and are never printed.
 */
"use strict";

const crypto = require("crypto");

const DEFAULT_ENDPOINT = "https://coned.jedarden.com/api/gbc/token";
const REQUEST_TIMEOUT_MS = 15000;

class SmokeFailure extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SmokeFailure";
    this.code = code;
  }
}

function errorCode(body) {
  return body && typeof body.error === "string" ? body.error : "";
}

async function responseErrorCode(response) {
  let text;
  try {
    text = await response.text();
  } catch (e) {
    return "";
  }
  if (!text) return "";
  try {
    return errorCode(JSON.parse(text));
  } catch (e) {
    return "";
  }
}

async function post(fetchImpl, endpoint, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json"
      },
      body,
      signal: controller.signal
    });
  } catch (e) {
    throw new SmokeFailure("unreachable", "the production token endpoint could not be reached");
  } finally {
    clearTimeout(timer);
  }
}

async function runSmoke(endpoint, fetchImpl) {
  const f = fetchImpl || globalThis.fetch;
  if (typeof f !== "function") {
    throw new SmokeFailure("client", "Node 18+ with built-in fetch is required");
  }
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch (e) {
    throw new SmokeFailure("client", "the smoke endpoint is not a valid URL");
  }
  if (parsed.username || parsed.password) {
    throw new SmokeFailure("client", "the smoke endpoint must not contain URL credentials");
  }

  // Configuration preflight: the Pages Function checks env bindings before it
  // reads this body, so this cannot spend a code or call Con Edison.
  const preflight = await post(f, endpoint, "not-json");
  const preflightError = await responseErrorCode(preflight);
  if (preflight.status === 503 && preflightError === "gbc_not_configured") {
    throw new SmokeFailure("missing_bindings", "one or more required Pages bindings are missing");
  }
  if (preflight.status !== 400 || preflightError !== "invalid_request") {
    throw new SmokeFailure("unexpected_preflight", `unexpected configuration response (HTTP ${preflight.status})`);
  }

  // A random code is safe to submit: it is not a real customer grant and is
  // not a credential. The redirect URI matches the production origin shape,
  // allowing the provider to reach its normal invalid_grant decision.
  const code = `gbc-smoke-${crypto.randomUUID()}`;
  const redirectUri = `${parsed.origin}/`;
  const upstream = await post(f, endpoint, JSON.stringify({ code, redirectUri }));
  const upstreamError = await responseErrorCode(upstream);

  if (upstream.status === 400 && upstreamError === "invalid_grant") {
    return { ok: true, preflightStatus: preflight.status, upstreamStatus: upstream.status };
  }
  if ((upstream.status === 400 || upstream.status === 401 || upstream.status === 403) &&
      upstreamError === "invalid_client") {
    throw new SmokeFailure("upstream_authentication", "the upstream rejected the configured client authentication");
  }
  if (upstream.status === 503 && upstreamError === "gbc_not_configured") {
    throw new SmokeFailure("missing_bindings", "required Pages bindings became unavailable during the check");
  }
  if (upstream.status === 502 && upstreamError === "upstream_unreachable") {
    throw new SmokeFailure("unreachable", "the Pages Function could not reach the configured token endpoint");
  }
  throw new SmokeFailure("unexpected_upstream", `unexpected upstream response (HTTP ${upstream.status})`);
}

function printUsage() {
  console.log("Usage: node scripts/smoke-gbc-production.js [https://host/api/gbc/token]");
  console.log("       GBC_SMOKE_URL=https://host/api/gbc/token node scripts/smoke-gbc-production.js");
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    printUsage();
    return;
  }
  if (args.length > 1) throw new SmokeFailure("client", "provide at most one smoke endpoint URL");
  const endpoint = args[0] || process.env.GBC_SMOKE_URL || DEFAULT_ENDPOINT;
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch (e) {
    throw new SmokeFailure("client", "the smoke endpoint is not a valid URL");
  }
  if (parsed.protocol !== "https:") {
    throw new SmokeFailure("client", "production smoke checks require an https endpoint");
  }
  const result = await runSmoke(endpoint);
  console.log(`GBC configuration preflight passed (HTTP ${result.preflightStatus}); no response body was logged.`);
  console.log(`GBC upstream authentication passed: synthetic code received expected invalid_grant (HTTP ${result.upstreamStatus}).`);
}

if (require.main === module) {
  main().catch((error) => {
    const code = error && error.code ? error.code : "failed";
    console.error(`GBC production smoke check failed [${code}]: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { DEFAULT_ENDPOINT, SmokeFailure, runSmoke };
