/* Production-safe smoke check for the Pages Function's GBC configuration.
 *
 * The checker sends no client credentials to the Pages endpoint. It first
 * proves that a foreign-origin request is rejected before any upstream call,
 * then sends an intentionally malformed same-origin body, which the function
 * rejects before any upstream call; a 503 gbc_not_configured response proves a
 * required binding is missing. The final request uses a fresh synthetic
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

async function post(fetchImpl, endpoint, body, extraHeaders) {
  return request(fetchImpl, endpoint, {
    method: "POST",
    headers: Object.assign({
      "content-type": "application/json",
      accept: "application/json"
    }, extraHeaders || {}),
    body
  });
}

async function request(fetchImpl, endpoint, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetchImpl(endpoint, Object.assign({
      signal: controller.signal
    }, options));
  } catch (e) {
    throw new SmokeFailure("unreachable", "the production token endpoint could not be reached");
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(response, failureCode, message) {
  let text;
  try {
    text = await response.text();
  } catch (e) {
    throw new SmokeFailure(failureCode, message);
  }
  try {
    return text ? JSON.parse(text) : null;
  } catch (e) {
    throw new SmokeFailure(failureCode, message);
  }
}

async function verifyPublicConfig(endpoint, fetchImpl) {
  const parsedEndpoint = new URL(endpoint);
  const origin = parsedEndpoint.origin;
  const configResponse = await request(fetchImpl, origin + "/gbc-config.json", {
    method: "GET",
    headers: { accept: "application/json" }
  });
  if (!configResponse.ok) {
    throw new SmokeFailure("missing_configuration", `public GBC configuration is unavailable (HTTP ${configResponse.status})`);
  }
  const cfg = await readJson(configResponse, "invalid_configuration", "public GBC configuration is not JSON");
  if (!cfg || cfg.configured !== true) {
    throw new SmokeFailure("missing_configuration", "public GBC configuration is not enabled");
  }
  if (typeof cfg.clientId !== "string" || !cfg.clientId ||
      typeof cfg.authorizeUrl !== "string" || typeof cfg.apiBase !== "string" ||
      !cfg.authorizeUrl || !cfg.apiBase || !Array.isArray(cfg.scopes) || cfg.scopes.length === 0) {
    throw new SmokeFailure("invalid_configuration", "public GBC configuration is missing a client, endpoint, or scope");
  }
  const registeredRedirect = cfg.redirectUri;
  if (typeof registeredRedirect !== "string" || !registeredRedirect) {
    throw new SmokeFailure("redirect_mismatch", "public GBC configuration does not declare the registered redirect URI");
  }
  if (registeredRedirect !== origin + "/") {
    throw new SmokeFailure("redirect_mismatch", "registered GBC redirect URI is not the deployed site root");
  }
  let authorizeUrl, apiBase, tokenExchangePath;
  try {
    authorizeUrl = new URL(cfg.authorizeUrl);
    apiBase = new URL(cfg.apiBase);
    tokenExchangePath = new URL(cfg.tokenExchangePath || "/api/gbc/token", origin);
  } catch (e) {
    throw new SmokeFailure("invalid_configuration", "public GBC configuration contains an invalid URL");
  }
  if (authorizeUrl.protocol !== "https:" || apiBase.protocol !== "https:") {
    throw new SmokeFailure("invalid_configuration", "public GBC endpoints must use HTTPS");
  }
  if (tokenExchangePath.href !== endpoint.replace(/#.*$/, "")) {
    throw new SmokeFailure("token_path_mismatch", "public tokenExchangePath does not point at this Pages Function");
  }
  return { origin, redirectUri: registeredRedirect, authorizeUrl: authorizeUrl.href, apiBase: apiBase.href };
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

  const redirectUri = `${parsed.origin}/`;

  // A foreign-origin request must be rejected before its body is read or an
  // upstream call is made. This is the deployment's CSRF/relay guard.
  const foreign = await post(f, endpoint, JSON.stringify({
    code: "gbc-smoke-origin-check",
    redirectUri
  }), { origin: "https://foreign.invalid" });
  const foreignError = await responseErrorCode(foreign);
  if (foreign.status !== 403 || foreignError !== "origin_not_allowed") {
    throw new SmokeFailure("same_origin", "the token endpoint did not reject a foreign-origin request");
  }

  // Configuration preflight: the Pages Function checks env bindings before it
  // reads this body, so this cannot spend a code or call Con Edison.
  const preflight = await request(f, endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      origin: parsed.origin
    },
    body: "not-json"
  });
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
  const upstream = await post(f, endpoint, JSON.stringify({ code, redirectUri }), { origin: parsed.origin });
  const upstreamError = await responseErrorCode(upstream);

  if (upstream.status === 400 && upstreamError === "invalid_grant") {
    return {
      ok: true,
      foreignStatus: foreign.status,
      preflightStatus: preflight.status,
      upstreamStatus: upstream.status
    };
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
  const config = await verifyPublicConfig(endpoint, globalThis.fetch);
  const result = await runSmoke(endpoint);
  console.log(`GBC public config passed: redirect ${config.redirectUri}, token path and HTTPS upstream endpoints verified.`);
  console.log(`GBC same-origin guard passed (foreign HTTP ${result.foreignStatus}); configuration preflight passed (HTTP ${result.preflightStatus}); no response body was logged.`);
  console.log(`GBC upstream authentication passed: synthetic code received expected invalid_grant (HTTP ${result.upstreamStatus}).`);
}

if (require.main === module) {
  main().catch((error) => {
    const code = error && error.code ? error.code : "failed";
    console.error(`GBC production smoke check failed [${code}]: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { DEFAULT_ENDPOINT, SmokeFailure, runSmoke, verifyPublicConfig };
