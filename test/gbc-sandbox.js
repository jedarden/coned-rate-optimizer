/* Sandbox Third-Party App authorization for the Green Button Connect flow.
   Usage:  node test/gbc-sandbox.js

   Con Edison's real Share My Data sandbox requires third-party registration
   (client id, secret, and endpoint URLs are issued at onboarding — see
   docs/notes/gbc-data-boundary.md), so this harness stands up the *standard*
   GBCMD shapes locally: an OAuth 2.0 authorization server (authorize + token,
   single-use codes, HTTP Basic client auth, state round-trip) and an ESPI
   Data Custodian (Subscription → UsagePoint → interval Batch feed + billing
   UsageSummary feed, bearer-gated). The interval feed serves the same
   fixtures/sample-greenbutton.xml the file-upload tests use, so the connected
   path is proven to analyze byte-identical input identically.

   Everything real runs: public/gbc.js (authorize URL, callback validation,
   connection store, feed walk, ESPI parse via calc.js) and the actual Pages
   Function functions/api/gbc/token.js (invoked with Request/env objects, its
   /api/gbc/token route delegated to verbatim).

   The sandbox also enforces the data-handling boundary mechanically
   (docs/notes/gbc-data-boundary.md): every request it receives is recorded,
   and the run fails if anything other than the OAuth code shapes ever arrives
   in a request body — interval and billing payloads exist only in the
   responses the Data Custodian sends, never in anything received.

   Exports startSandbox() for the browser end-to-end (tools/verify-gbc-browser.js). */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const calc = require("../public/calc.js");
const gbc = require("../public/gbc.js");
const worker = require("../functions/api/gbc/token.js");

const FIXTURE = path.join(__dirname, "fixtures/sample-greenbutton.xml");
const SUB_ID = "77";
const UP_ID = "9";

const readBody = (req) => new Promise((resolve, reject) => {
  if (req.rawBody !== undefined) return resolve(req.rawBody);
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  req.on("error", reject);
});

const send = (res, status, body, type, extraHeaders) => {
  res.writeHead(status, Object.assign({ "content-type": type || "application/json" }, extraHeaders || {}));
  res.end(body);
};
const jsonText = (obj) => JSON.stringify(obj);

function atomFeed(feedId, entryIds) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>${feedId}</id>
${entryIds.map((id) => `  <entry>\n    <id>${id}</id>\n  </entry>`).join("\n")}
</feed>`;
}

function usageSummaryFeed(base) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>${base}/espi/1_1/resource/UsagePoint/${UP_ID}/UsageSummary</id>
  <entry>
    <id>${base}/espi/1_1/resource/UsageSummary/301</id>
    <content>
      <UsageSummary xmlns="http://naesb.org/espi">
        <billingPeriod>
          <start>1750353600</start>
          <end>1752945600</end>
        </billingPeriod>
        <cost>
          <currency>USD</currency>
          <value>11245</value>
        </cost>
        <statusTimeStamp>1752949200</statusTimeStamp>
      </UsageSummary>
    </content>
  </entry>
</feed>`;
}

/** Boots the mock authorization server + Data Custodian. Resolves with
 *  { server, origin, config, clientId, clientSecret, accessToken, fixtureXml, stop }. */
function startSandbox(options) {
  options = options || {};
  const clientId = options.clientId || "sandbox-third-party-app";
  const clientSecret = options.clientSecret || crypto.randomBytes(16).toString("hex");
  const accessToken = options.accessToken || "sbx_" + crypto.randomBytes(12).toString("hex");
  const fixtureXml = fs.readFileSync(FIXTURE, "utf8");
  const codes = new Map(); // authorization code → {redirectUri, used}
  // Every request the sandbox receives — method, full URL, and any POST body.
  // One host plays both the app-origin role (static + /api/gbc/token) and the
  // ConEd role (/authorize, /token, /espi/*), so the boundary assertions in
  // run() key on where a request went and what bytes it carried, not on host.
  const requests = [];
  const server = http.createServer((req, res) => {
    const dispatch = () => handler(req, res).catch((e) => {
      send(res, 500, jsonText({ error: "sandbox_error", error_description: String(e && e.message) }));
    });
    const url = req.url || "";
    if (req.method === "POST") {
      readBody(req).then((body) => {
        req.rawBody = body;
        requests.push({ method: req.method, url, body });
        dispatch();
      }, dispatch);
    } else {
      requests.push({ method: req.method, url });
      dispatch();
    }
  });

  async function handler(req, res) {
    const origin = "http://" + (req.headers.host || "127.0.0.1");
    const u = new URL(req.url, origin);

    // ---- OAuth 2.0 authorization endpoint (GBCMD shape) ----
    if (u.pathname === "/authorize") {
      const sp = u.searchParams;
      const redirectUri = sp.get("redirect_uri") || "";
      if (sp.get("response_type") !== "code") return send(res, 400, jsonText({ error: "unsupported_response_type" }));
      if (sp.get("client_id") !== clientId) return send(res, 400, jsonText({ error: "invalid_client" }));
      if (!/^http:\/\/127\.0\.0\.1(:\d+)?\//.test(redirectUri)) return send(res, 400, jsonText({ error: "invalid_request", error_description: "unregistered redirect_uri" }));
      if (!sp.get("scope")) return send(res, 400, jsonText({ error: "invalid_scope" }));
      if (!sp.get("state")) return send(res, 400, jsonText({ error: "invalid_request", error_description: "missing state" }));
      const code = "auth_" + crypto.randomBytes(8).toString("hex");
      codes.set(code, { redirectUri, used: false });
      const sep = redirectUri.indexOf("?") >= 0 ? "&" : "?";
      res.writeHead(302, { location: redirectUri + sep + "code=" + code + "&state=" + encodeURIComponent(sp.get("state")) });
      return res.end();
    }

    // ---- OAuth 2.0 token endpoint (client auth: Basic or body) ----
    if (u.pathname === "/token" && req.method === "POST") {
      const form = new URLSearchParams(await readBody(req));
      const expectedBasic = Buffer.from(clientId + ":" + clientSecret).toString("base64");
      const givenBasic = String(req.headers.authorization || "").replace(/^Basic\s+/i, "");
      const bodyAuth = form.get("client_id") === clientId && form.get("client_secret") === clientSecret;
      if (givenBasic !== expectedBasic && !bodyAuth) return send(res, 401, jsonText({ error: "invalid_client" }));
      if (form.get("grant_type") !== "authorization_code") return send(res, 400, jsonText({ error: "unsupported_grant_type" }));
      const rec = codes.get(form.get("code"));
      if (!rec || rec.used) return send(res, 400, jsonText({ error: "invalid_grant", error_description: "unknown, used, or expired code" }));
      if (rec.redirectUri !== form.get("redirect_uri")) return send(res, 400, jsonText({ error: "invalid_grant", error_description: "redirect_uri mismatch" }));
      rec.used = true;
      return send(res, 200, JSON.stringify({ access_token: accessToken, token_type: "Bearer", expires_in: 3600, scope: form.get("scope") || "" }));
    }

    // ---- /api/gbc/token: delegate verbatim to the REAL Pages Function ----
    if (u.pathname === "/api/gbc/token" && req.method === "POST") {
      const body = await readBody(req);
      const request = new Request(origin + "/api/gbc/token", {
        method: "POST",
        headers: { "content-type": "application/json", "origin": origin },
        body
      });
      const response = await worker.onRequestPost({
        request,
        env: { GBC_CLIENT_ID: clientId, GBC_CLIENT_SECRET: clientSecret, GBC_TOKEN_URL: origin + "/token" }
      });
      return send(res, response.status, await response.text(), response.headers.get("content-type") || "application/json");
    }

    // ---- ESPI Data Custodian (bearer-gated; CORS open like a GBCMD data
    //      custodian serving browser third-party clients — the Authorization
    //      header makes every GET preflighted) ----
    if (u.pathname.startsWith("/espi/")) {
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, OPTIONS",
          "access-control-allow-headers": "Authorization"
        });
        return res.end();
      }
      const cors = { "access-control-allow-origin": "*" };
      if (req.headers.authorization !== "Bearer " + accessToken) {
        return send(res, 401, jsonText({ error: "invalid_token" }), "application/json", cors);
      }
      const base = origin + "/espi/1_1/resource";
      switch (u.pathname) {
        case "/espi/1_1/resource/Subscription":
          return send(res, 200, atomFeed(base + "/Subscription", [base + "/Subscription/" + SUB_ID]), "application/atom+xml", cors);
        case "/espi/1_1/resource/Subscription/" + SUB_ID + "/UsagePoint":
          return send(res, 200, atomFeed(base + "/Subscription/" + SUB_ID + "/UsagePoint", [base + "/UsagePoint/" + UP_ID]), "application/atom+xml", cors);
        case "/espi/1_1/resource/Batch/UsagePoint/" + UP_ID:
          return send(res, 200, fixtureXml, "application/atom+xml", cors);
        case "/espi/1_1/resource/UsagePoint/" + UP_ID + "/UsageSummary":
          return send(res, 200, usageSummaryFeed(origin), "application/atom+xml", cors);
        default:
          return send(res, 404, jsonText({ error: "not_found", error_description: u.pathname }), "application/json", cors);
      }
    }

    send(res, 404, jsonText({ error: "not_found", error_description: u.pathname }));
  }

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const origin = "http://127.0.0.1:" + server.address().port;
      const config = gbc.validateConfig({
        configured: true,
        clientId,
        authorizeUrl: origin + "/authorize",
        apiBase: origin,
        scopes: ["FB=4_5_6", "USAGE_READ"],
        tokenExchangePath: origin + "/api/gbc/token"
      });
      resolve({
        server,
        origin,
        config,
        clientId,
        clientSecret,
        accessToken,
        fixtureXml,
        requests,
        stop: () => new Promise((done) => server.close(done))
      });
    });
  });
}

function shimStorage() {
  const m = {};
  return {
    setItem: (k, v) => { m[k] = String(v); },
    getItem: (k) => (k in m ? m[k] : null),
    removeItem: (k) => { delete m[k]; }
  };
}

// ---- self-test ---------------------------------------------------------

async function run() {
  for (const name of ["fetch", "Request", "Response", "URLSearchParams"]) {
    if (typeof globalThis[name] !== "function") {
      console.log(`  ✗ Node ${process.version} lacks global ${name} — need Node 18+`);
      process.exit(1);
    }
  }
  const box = await startSandbox();
  const cfg = box.config;
  const store = shimStorage();
  let passed = 0, failed = 0;
  const ok = (cond, msg) => {
    if (cond) { console.log(`  ✓ ${msg}`); passed++; }
    else { console.log(`  ✗ ${msg}`); failed++; }
  };
  const throws = (fn, msg) => {
    try { fn(); ok(false, msg + " (did not throw)"); }
    catch (e) { ok(true, `${msg} — "${e.message.slice(0, 72)}"`); }
  };

  console.log(`Sandbox Third-Party App authorization — ${box.origin}\n`);
  console.log("Sandbox setup");
  ok(box.fixtureXml.includes("IntervalReading"), "interval feed serves the shared ESPI fixture");
  ok(cfg.configured, "sandbox config validates as configured");

  console.log("\n1. Config handling");
  ok(gbc.validateConfig({}).configured === false, "missing gbc-config.json degrades to unconfigured");
  throws(() => gbc.validateConfig({ configured: true, clientId: "x" }), "configured:true with missing fields rejected");
  throws(() => gbc.authorizeUrl({}, "s", "r"), "authorizeUrl on an unconfigured config throws");

  console.log("\n2. Authorization request");
  const state = gbc.randomState();
  ok(/^[0-9a-f]{32}$/.test(state), "randomState is 128-bit hex");
  const redirectUri = gbc.buildRedirectUri({ origin: box.origin });
  const aUrl = new URL(gbc.authorizeUrl(cfg, state, redirectUri));
  ok(aUrl.pathname === "/authorize", "authorize URL targets the sandbox authorize endpoint");
  ok(aUrl.searchParams.get("response_type") === "code", "response_type=code");
  ok(aUrl.searchParams.get("client_id") === box.clientId, "client_id carries the sandbox third-party id");
  ok(aUrl.searchParams.get("redirect_uri") === redirectUri, "redirect_uri is the registered site root");
  ok(aUrl.searchParams.get("scope") === "FB=4_5_6 USAGE_READ", "scopes are joined space-separated");
  ok(aUrl.searchParams.get("state") === state, "state rides the authorization request");
  const ar = await fetch(gbc.authorizeUrl(cfg, state, redirectUri), { redirect: "manual" });
  ok(ar.status === 302, "authorize endpoint replies 302");
  const loc = new URL(ar.headers.get("location"));
  ok(loc.origin + loc.pathname === redirectUri, "redirect lands on the registered redirect_uri");
  ok(loc.searchParams.get("state") === state, "authorization response echoes the state");
  const code = loc.searchParams.get("code");
  ok(/^auth_/.test(code || ""), "authorization response carries a code");

  console.log("\n3. Callback validation");
  const cb = gbc.parseCallback(loc.search, state);
  ok(cb.ok && cb.code === code, "valid callback accepted (code + state match)");
  ok(gbc.parseCallback(loc.search, "deadbeef").error === "state_mismatch", "foreign state rejected (CSRF)");
  const deny = gbc.parseCallback("?error=access_denied&error_description=nope", state);
  ok(!deny.ok && deny.error === "access_denied", "OAuth error callback surfaced");
  ok(/declined/.test(gbc.friendlyError(deny)), "access_denied maps to a friendly message");

  console.log("\n4. Token exchange through the real Pages Function");
  const conn = await gbc.connect(cfg, code, redirectUri);
  ok(conn.accessToken === box.accessToken, "authorization code exchanged for the access token");
  ok(conn.tokenType === "Bearer", "token type is Bearer");
  ok(Math.abs(conn.expiresAt - Date.now() - 3600e3) < 5000, "expiry computed from expires_in (~1h)");
  ok(gbc.connectionIsFresh(conn), "connection is fresh after exchange");
  await gbc.connect(cfg, code, redirectUri).then(
    () => ok(false, "authorization code reuse must be rejected"),
    (e) => ok(/invalid_grant|used/.test(e.message), `authorization code reuse rejected ("${e.message.slice(0, 48)}")`)
  );
  await gbc.connect(cfg, "auth_bogus", redirectUri).then(
    () => ok(false, "bogus authorization code must be rejected"),
    (e) => ok(/invalid_grant|unknown/.test(e.message), `bogus code rejected ("${e.message.slice(0, 48)}")`)
  );

  console.log("\n5. Connection store");
  gbc.saveConnection(conn, store);
  ok(JSON.parse(store.getItem(gbc.TOKEN_KEY)).accessToken === box.accessToken, "connection round-trips through the store");
  ok(gbc.loadConnection(store).accessToken === box.accessToken, "loadConnection restores it");
  ok(!gbc.connectionIsFresh({ accessToken: "x", expiresAt: Date.now() - 1000 }), "expired connection is not fresh");
  ok(!gbc.connectionIsFresh({ accessToken: "", expiresAt: Date.now() + 9e6 }), "tokenless connection is not fresh");
  gbc.clearConnection(store);
  ok(store.getItem(gbc.TOKEN_KEY) === null && store.getItem(gbc.STATE_KEY) === null, "clearConnection removes token and state");

  console.log("\n6. Feed retrieval + analysis (interval & billing)");
  const direct = calc.parseESPI(box.fixtureXml);
  const res = await gbc.refreshFeeds(cfg, conn);
  ok(res.subscriptionId === "77", `subscription discovered from the feed (id ${res.subscriptionId})`);
  ok(res.usagePointId === "9", `usage point discovered from the feed (id ${res.usagePointId})`);
  ok(res.parsed.intervals === 72, `interval feed parsed: ${res.parsed.intervals} readings`);
  ok(JSON.stringify(res.parsed) === JSON.stringify(direct), "connected-feed analysis is byte-identical to parsing the file fixture");
  ok(res.billingEntries === 1, `billing (UsageSummary) feed retrieved: ${res.billingEntries} entry`);
  ok(/UsageSummary/.test(res.billingXml), "billing feed XML retained for display");

  console.log("\n7. Negative access paths");
  await gbc.apiGet("wrong-token", box.origin + "/espi/1_1/resource/Subscription").then(
    () => ok(false, "wrong bearer token must fail"),
    (e) => ok(/expired|reconnect/.test(e.message), `bad token gets a friendly 401 message ("${e.message.slice(0, 48)}")`)
  );
  await gbc.refreshFeeds(cfg, { accessToken: "wrong-token", expiresAt: Date.now() + 9e6 }).then(
    () => ok(false, "feeds with a bad token must fail"),
    (e) => ok(true, `refreshFeeds with a bad token fails cleanly ("${e.message.slice(0, 40)}")`)
  );
  await gbc.refreshFeeds(cfg, { accessToken: "x", expiresAt: Date.now() - 1 }).then(
    () => ok(false, "stale connection must not fetch"),
    (e) => ok(/reconnect/.test(e.message), "stale connection refused before any request")
  );

  console.log("\n8. Pages Function guard rails (invoked directly)");
  const call = (env, body, headers) => worker.onRequestPost({
    request: new Request(box.origin + "/api/gbc/token", {
      method: "POST", headers: Object.assign({ "content-type": "application/json" }, headers || {}), body: JSON.stringify(body)
    }),
    env
  });
  const noEnv = await call({}, { code: "x", redirectUri: "http://127.0.0.1/" });
  ok(noEnv.status === 503 && (await noEnv.json()).error === "gbc_not_configured", "missing env bindings → 503 gbc_not_configured");
  const badBody = await call({ GBC_CLIENT_ID: "a", GBC_CLIENT_SECRET: "b", GBC_TOKEN_URL: box.origin + "/token" }, { redirectUri: "http://127.0.0.1/" });
  ok(badBody.status === 400, "missing code → 400");
  const foreign = await call({ GBC_CLIENT_ID: "a", GBC_CLIENT_SECRET: "b", GBC_TOKEN_URL: box.origin + "/token" },
    { code: "x", redirectUri: "http://127.0.0.1/" }, { origin: "https://evil.example" });
  ok(foreign.status === 403, "cross-origin exchange attempt → 403");
  const bodyAuth = await worker.onRequestPost({
    request: new Request(box.origin + "/api/gbc/token", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "x", redirectUri: "http://127.0.0.1/" })
    }),
    env: { GBC_CLIENT_ID: box.clientId, GBC_CLIENT_SECRET: box.clientSecret, GBC_TOKEN_URL: box.origin + "/token", GBC_TOKEN_AUTH: "body" }
  });
  ok(bodyAuth.status === 400, "body-style client auth reaches the token endpoint (bogus code → upstream 400 passthrough)");

  console.log("\n9. Data boundary — no usage payload ever reaches the application server");
  // Across the WHOLE run above: one host plays both the app origin and ConEd,
  // so the invariant is stated on requests, not hosts. Usage bytes may only
  // ever leave this server as Data Custodian *responses* — they must never
  // arrive inside any request body (docs/notes/gbc-data-boundary.md).
  const pathOf = (r) => r.url.split("?")[0];
  const posts = box.requests.filter((r) => r.method === "POST");
  ok(posts.length > 0 && posts.every((r) => ["/api/gbc/token", "/token"].includes(pathOf(r))),
     `every POST went to the token exchange or its upstream call (${posts.length} POSTs)`);
  const exchangePosts = posts.filter((r) => pathOf(r) === "/api/gbc/token");
  const exchangeShape = (r) => {
    try {
      const b = JSON.parse(r.body);
      return Object.keys(b).length === 2 && typeof b.code === "string" && typeof b.redirectUri === "string";
    } catch (e) { return false; }
  };
  ok(exchangePosts.length > 0 && exchangePosts.every(exchangeShape),
     `every exchange request body was exactly {code, redirectUri} (${exchangePosts.length} attempt(s))`);
  const usageMarkers = ["IntervalReading", "IntervalBlock", "UsageSummary", "powerOfTenMultiplier"];
  ok(posts.every((r) => usageMarkers.every((m) => !r.body.includes(m))),
     "no request body carried interval or billing payload bytes");
  ok(posts.every((r) => !r.body.includes(box.accessToken)),
     "the access token never appears in a request body");
  const espiReqs = box.requests.filter((r) => pathOf(r).startsWith("/espi/"));
  ok(espiReqs.length > 0 && espiReqs.every((r) => r.method === "GET"),
     `every Data Custodian request was a direct GET (${espiReqs.length} feed requests)`);

  await box.stop();
  console.log(`\nSandbox results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  if (failed > 0) process.exit(1);
  console.log("Sandbox Third-Party App authorization passed ✓");
  process.exit(0);
}

module.exports = { startSandbox };
if (require.main === module) {
  run().catch((e) => { console.error(`  ✗ sandbox crashed: ${e.stack || e}`); process.exit(1); });
}
