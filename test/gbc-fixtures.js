/* Fixture-driven Green Button Connect contract tests.
   Usage: node test/gbc-fixtures.js

   The browser E2E in tools/verify-gbc-browser.js requires a local Chromium.
   This suite keeps the same high-value flow deterministic in Node: committed
   OAuth/XML/Atom fixtures drive the real gbc.js, calc.js, analytics.js, and
   Pages Function boundary, while separate local HTTP origins prove that the
   interval and billing response bytes go directly to the browser-side
   custodian origin rather than the application origin. */
"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const calc = require("../public/calc.js");
const gbc = require("../public/gbc.js");
const analytics = require("../public/analytics.js");

const ROOT = path.join(__dirname, "fixtures");
const flow = JSON.parse(fs.readFileSync(path.join(ROOT, "gbc-browser-flow.json"), "utf8"));
const fixture = (name) => fs.readFileSync(path.join(ROOT, name), "utf8");
const feeds = Object.fromEntries(Object.entries(flow.files).map(([key, name]) => [key, fixture(name)]));

let passed = 0;
let failed = 0;
function check(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.log(`  ✗ ${message}`);
    failed++;
  }
}

async function rejects(promise, pattern, message) {
  try {
    await promise;
    check(false, `${message} (did not reject)`);
  } catch (error) {
    check(pattern.test(error.message), `${message} — "${error.message.slice(0, 90)}"`);
  }
}

function memoryStorage() {
  const values = new Map();
  return {
    setItem: (key, value) => values.set(key, String(value)),
    getItem: (key) => values.has(key) ? values.get(key) : null,
    removeItem: (key) => values.delete(key)
  };
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function response(res, status, body, type) {
  res.writeHead(status, { "content-type": type || "application/json" });
  res.end(body);
}

async function startFixtureOrigins() {
  const appRequests = [];
  const custodianRequests = [];

  const app = http.createServer(async (req, res) => {
    const body = await readRequestBody(req);
    appRequests.push({ method: req.method, url: req.url, body, headers: req.headers });
    if (req.method === "POST" && req.url === "/api/gbc/token") {
      return response(res, 200, JSON.stringify({
        access_token: flow.connection.accessToken,
        token_type: flow.connection.tokenType,
        scope: flow.connection.scope,
        expires_in: flow.connection.expiresIn
      }));
    }
    return response(res, 404, JSON.stringify({ error: "not_found" }));
  });

  const custodian = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://custodian.example");
    custodianRequests.push({ method: req.method, url: u.pathname + u.search, headers: req.headers });
    const routes = {
      "/espi/1_1/resource/Subscription": feeds.subscription,
      "/espi/1_1/resource/Subscription/77/UsagePoint": feeds.usagePoint,
      "/espi/1_1/resource/Batch/UsagePoint/9": feeds.interval,
      "/espi/1_1/resource/UsagePoint/9/UsageSummary": feeds.billing,
      "/valid/covered-billing": feeds.coveredBilling,
      "/failure/empty-subscription": feeds.empty,
      "/failure/empty-usage-point": feeds.empty,
      "/failure/malformed-interval": feeds.malformedInterval,
      "/failure/incomplete-billing": feeds.billingNoTotal
    };
    if (u.pathname === "/failure/http") return response(res, 503, JSON.stringify({ error: "fixture_unavailable" }));
    if (u.pathname === "/failure/unauthorized") return response(res, 401, feeds.unauthorized);
    if (!(u.pathname in routes)) return response(res, 404, JSON.stringify({ error: "not_found" }));
    if (req.headers.authorization !== `Bearer ${flow.connection.accessToken}`) {
      return response(res, 401, JSON.stringify({ error: "invalid_token" }));
    }
    return response(res, 200, routes[u.pathname], "application/atom+xml");
  });

  await Promise.all([
    new Promise((resolve) => app.listen(0, "127.0.0.1", resolve)),
    new Promise((resolve) => custodian.listen(0, "127.0.0.1", resolve))
  ]);
  const appOrigin = `http://127.0.0.1:${app.address().port}`;
  const custodianOrigin = `http://127.0.0.1:${custodian.address().port}`;
  return {
    appOrigin,
    custodianOrigin,
    appRequests,
    custodianRequests,
    close: () => Promise.all([
      new Promise((resolve) => app.close(resolve)),
      new Promise((resolve) => custodian.close(resolve))
    ])
  };
}

function config(origins, paths) {
  return gbc.validateConfig(Object.assign({
    configured: true,
    clientId: "fixture-third-party-app",
    authorizeUrl: origins.appOrigin + "/authorize",
    apiBase: origins.custodianOrigin,
    redirectUri: origins.appOrigin + "/",
    scopes: ["FB=4_5_6", "USAGE_READ"],
    tokenExchangePath: origins.appOrigin + "/api/gbc/token"
  }, paths || {}));
}

function rounded(value) {
  return Math.round(value * 1e8) / 1e8;
}

function parsedShape(parsed) {
  return {
    intervals: parsed.intervals,
    ndays: parsed.ndays,
    totalKwh: rounded(parsed.totalKwh),
    months: parsed.months.map((month) => ({
      ym: month.ym,
      total: rounded(month.total),
      peak: rounded(month.peak),
      off: rounded(month.off),
      ndays: month.ndays
    })),
    hours: parsed.hours.map((hour) => ({
      ym: hour.ym,
      mo: hour.mo,
      day: hour.day,
      hour: hour.hour,
      weekday: hour.weekday,
      kwh: rounded(hour.kwh)
    }))
  };
}

function analysisShape(analysis) {
  return {
    recommendation: analysis.recommendation,
    standardCost: rounded(analysis.standardCost),
    touCost: rounded(analysis.touCost),
    totalKwh: rounded(analysis.totalKwh),
    confidence: analysis.confidence,
    comparison: analysis.comparison.map((plan) => ({
      key: plan.key,
      current: plan.current,
      estimate: plan.estimate,
      avail: plan.avail,
      cost: rounded(plan.cost),
      annualCost: rounded(plan.annualCost),
      deltaAnnual: rounded(plan.deltaAnnual)
    })),
    reconciliation: {
      complete: analysis.reconciliation.complete,
      incomplete: analysis.reconciliation.incomplete,
      unsupported: analysis.reconciliation.unsupported,
      rows: analysis.reconciliation.rows.map((row) => ({
        label: row.label,
        kwh: rounded(row.kwh),
        observedDays: row.observedDays,
        billDays: row.billDays,
        supported: row.supported,
        band: row.band,
        pctError: rounded(row.pctError)
      })),
      gate: analysis.reconciliation.gate && {
        gate: analysis.reconciliation.gate.gate,
        periods: analysis.reconciliation.gate.periods,
        within2: analysis.reconciliation.gate.within2
      }
    }
  };
}

async function run() {
  for (const name of ["fetch", "Request", "Response", "URLSearchParams"]) {
    if (typeof globalThis[name] !== "function") throw new Error(`Node 18+ is required (${name} is missing)`);
  }

  console.log("Green Button Connect fixture contracts\n");

  console.log("1. OAuth callback fixtures");
  const expectedState = flow.oauth.expectedState;
  flow.oauth.callbacks.forEach((testCase) => {
    const result = gbc.parseCallback(testCase.query, expectedState);
    check(result.ok === !!testCase.ok && (!testCase.ok || result.code === testCase.code) &&
      (!testCase.error || result.error === testCase.error), testCase.name);
    if (testCase.friendlyIncludes) {
      check(gbc.friendlyError(result).toLowerCase().includes(testCase.friendlyIncludes),
        `${testCase.name} has friendly provider copy`);
    }
  });
  const stateA = gbc.randomState(), stateB = gbc.randomState();
  check(/^[0-9a-f]{32}$/.test(stateA) && /^[0-9a-f]{32}$/.test(stateB) && stateA !== stateB,
    "each authorization attempt gets a fresh 128-bit state");
  const originsForUrl = { appOrigin: "https://app.example", custodianOrigin: "https://custodian.example" };
  const authCfg = config(originsForUrl);
  const authUrl = new URL(gbc.authorizeUrl(authCfg, expectedState, originsForUrl.appOrigin + "/"));
  check(authUrl.searchParams.get("state") === expectedState &&
    authUrl.searchParams.get("scope") === "FB=4_5_6 USAGE_READ",
  "authorization URL preserves the fixture state and documented scopes");

  console.log("\n2. sessionStorage token lifecycle fixtures");
  const store = memoryStorage();
  const anchor = 1_750_000_000_000;
  const storedConnection = Object.assign({}, flow.connection, {
    obtainedAt: anchor,
    expiresAt: anchor + 60_000
  });
  gbc.saveState(expectedState, store);
  gbc.saveConnection(storedConnection, store);
  check(gbc.loadState(store) === expectedState, "OAuth state round-trips through sessionStorage");
  check(!gbc.consumeState("wrong-state", store) && gbc.loadState(store) === expectedState,
    "a mismatched callback cannot consume the pending session state");
  check(gbc.consumeState(expectedState, store) && gbc.loadState(store) === null &&
    !gbc.consumeState(expectedState, store),
  "an exact callback consumes its state once and rejects replay");
  gbc.saveState(expectedState, store);
  check(gbc.loadConnection(store).accessToken === flow.connection.accessToken,
    "the access token round-trips through sessionStorage");
  check(gbc.connectionIsFresh(storedConnection, anchor), "a token outside the safety margin is fresh");
  check(!gbc.connectionIsFresh(storedConnection, anchor + 30_000),
    "a token exactly at the 30-second safety margin is stale");
  check(!gbc.connectionIsFresh(Object.assign({}, storedConnection, { accessToken: "" }), anchor),
    "a tokenless stored connection is stale");
  gbc.clearConnection(store);
  check(gbc.loadState(store) === null && gbc.loadConnection(store) === null,
    "disconnect removes both the token and the pending OAuth state");

  const origins = await startFixtureOrigins();
  try {
    const cfg = config(origins);
    console.log("\n3. XML/Atom fixtures and direct feed retrieval");
    const subscriptionIds = gbc.extractEntryIds(feeds.subscription);
    const usagePointIds = gbc.extractEntryIds(feeds.usagePoint);
    check(subscriptionIds.length === 1 && gbc.resourceIdOf(subscriptionIds[0]) === flow.ids.subscription,
      "Atom subscription fixture excludes the feed id and finds resource 77");
    check(usagePointIds.length === 1 && gbc.resourceIdOf(usagePointIds[0]) === flow.ids.usagePoint,
      "Atom usage-point fixture finds resource 9");
    check(gbc.extractNextLink(feeds.next) === "/espi/page-2?cursor=one&page=2",
      "Atom rel=next fixture decodes XML entities");

    const parsedInterval = calc.parseESPI(feeds.interval);
    const parsedImport = calc.parseGreenButton(feeds.imported);
    const parsedBilling = calc.parseBillingESPI(feeds.billing);
    check(parsedInterval.intervals === flow.expected.intervals,
      `ESPI interval fixture parses into ${parsedInterval.intervals} readings`);
    check(JSON.stringify(parsedShape(parsedInterval)) === JSON.stringify(parsedShape(parsedImport)),
      "the ESPI interval fixture normalizes to the equivalent imported CSV shape");
    check(parsedBilling.bills.length === flow.expected.billingEntries &&
      parsedBilling.bills[0].cost === flow.expected.billingCost,
    "UsageSummary fixture parses the USD minor-unit total into a bill");

    const connection = await gbc.connect(cfg, "fixture-code", cfg.redirectUri);
    check(connection.accessToken === flow.connection.accessToken && gbc.connectionIsFresh(connection),
      "fixture authorization code becomes a fresh in-tab connection");
    const result = await gbc.refreshFeeds(cfg, connection);
    check(result.subscriptionId === flow.ids.subscription && result.usagePointId === flow.ids.usagePoint,
      "refresh discovers the subscription and usage point from Atom fixtures");
    check(result.parsed.intervals === flow.expected.intervals && result.billingEntries === flow.expected.billingEntries,
      "refresh retrieves both interval and billing fixtures directly from the custodian");
    check(result.bills.length === 1 && result.bills[0].cost === flow.expected.billingCost,
      "refresh returns normalized billing evidence for rendering");

    const analysis = calc.analyze(result.parsed, { bills: result.bills });
    check(analysis.recommendation.includes(flow.expected.recommendationIncludes) &&
      analysis.confidence.level === flow.expected.confidenceLevel,
      "successful fixture import produces the expected rendered verdict and confidence label");

    const covered = await gbc.refreshFeeds(config(origins, { billingFeedPath: "/valid/covered-billing" }), connection);
    const coveredImportBill = calc.parseBillingESPI(feeds.coveredBilling).bills;
    const importedAnalysis = calc.analyze(parsedImport, { bills: coveredImportBill });
    const connectedAnalysis = calc.analyze(covered.parsed, { bills: covered.bills });
    check(covered.bills.length === 1 && covered.bills[0].cost === flow.expected.coveredBillCost,
      "covered UsageSummary fixture normalizes its USD total into one bill");
    check(covered.parsed.intervals === flow.expected.intervals &&
      covered.intervalXml === feeds.interval && covered.billingXml === feeds.coveredBilling,
      "covered feed retrieval keeps the connected interval and billing payloads intact");
    check(connectedAnalysis.reconciliation.rows.length === 1 &&
      connectedAnalysis.reconciliation.rows[0].supported === true &&
      connectedAnalysis.reconciliation.gate.gate === "pass" &&
      connectedAnalysis.confidence.reasons.some((reason) => reason.includes("accuracy gate")),
    "interval coverage reaches bill reconstruction and passes the connected accuracy gate");
    check(JSON.stringify(analysisShape(connectedAnalysis)) === JSON.stringify(analysisShape(importedAnalysis)),
      "connected ESPI analysis matches the equivalent imported CSV and billing data");

    console.log("\n4. Feed failure fixtures");
    const undiscovered = () => {
      const fresh = Object.assign({}, connection);
      delete fresh.subscriptionId;
      delete fresh.usagePointId;
      return fresh;
    };
    await rejects(gbc.refreshFeeds(config(origins, { subscriptionListPath: "/failure/empty-subscription" }), undiscovered()),
      /no usage subscription/, "empty subscription feed fails with actionable guidance");
    await rejects(gbc.refreshFeeds(config(origins, { usagePointsPath: "/failure/empty-usage-point" }), undiscovered()),
      /no usage point/, "empty usage-point feed fails with actionable guidance");
    await rejects(gbc.refreshFeeds(config(origins, { intervalFeedPath: "/failure/http" }), undiscovered()),
      /data request failed \(HTTP 503\)/, "HTTP feed failure is surfaced without a parser stack trace");
    await rejects(gbc.refreshFeeds(config(origins, { intervalFeedPath: "/failure/unauthorized" }), connection),
      /authorization has expired.*reconnect/, "a 401 authorization response fails with reconnect guidance");
    const incomplete = await gbc.refreshFeeds(config(origins, { billingFeedPath: "/failure/incomplete-billing" }), connection);
    check(incomplete.parsed.intervals === flow.expected.intervals && incomplete.bills.length === 0 &&
      incomplete.billingIncomplete === 1 && incomplete.billingError === null,
      "a billing summary without a total degrades bill evidence but keeps interval analysis usable");
    await rejects(gbc.refreshFeeds(config(origins, { intervalFeedPath: "/failure/malformed-interval" }), connection),
      /couldn't read as interval data/, "malformed interval XML rejects the connected import");

    console.log("\n5. Application-server boundary and analytics fixtures");
    const appPosts = origins.appRequests.filter((request) => request.method === "POST");
    const bodyShape = appPosts.length === 1 && (() => {
      const body = JSON.parse(appPosts[0].body);
      return JSON.stringify(Object.keys(body).sort()) === JSON.stringify(["code", "redirectUri"]) &&
        body.code === "fixture-code" && body.redirectUri === cfg.redirectUri;
    })();
    check(bodyShape, "the application server receives only {code, redirectUri}");
    const usageMarkers = ["IntervalReading", "IntervalBlock", "UsageSummary", "powerOfTenMultiplier"];
    const appWire = origins.appRequests.map((request) => `${request.url} ${request.body}`).join(" ");
    check(usageMarkers.every((marker) => !appWire.includes(marker)) &&
      !appWire.includes(flow.connection.accessToken),
      "interval, billing, and token bytes never reach the application server");
    const custodianGets = origins.custodianRequests.filter((request) => request.method === "GET");
    check(custodianGets.length >= 4 && custodianGets.every((request) =>
      request.headers.authorization === `Bearer ${flow.connection.accessToken}`),
    "all feed payloads are fetched as bearer GETs from the direct custodian origin");

    const previousCf = globalThis._cf;
    const sent = [];
    globalThis._cf = { event: (...args) => sent.push(args) };
    try {
      flow.analytics.events.forEach((event) => analytics.track(event, {
        interval: feeds.interval,
        billing: feeds.billing,
        token: flow.connection.accessToken,
        payload: flow.analytics.forbiddenPayloads.join("|")
      }));
      check(sent.length === flow.analytics.events.length && sent.every((args, i) =>
        args.length === 1 && args[0] === flow.analytics.events[i]),
      "documented analytics events emit as one bare fixture event name");
      check(!JSON.stringify(sent).includes(flow.analytics.forbiddenPayloads.join("|")) &&
        flow.analytics.forbiddenPayloads.every((value) => !JSON.stringify(sent).includes(value)),
      "analytics output contains none of the interval, billing, token, account, or filename fixtures");
      analytics.track("parse_error_" + flow.analytics.forbiddenPayloads[4]);
      check(sent.length === flow.analytics.events.length, "composed fixture-derived analytics names fail closed");
    } finally {
      if (previousCf === undefined) delete globalThis._cf;
      else globalThis._cf = previousCf;
    }
  } finally {
    await origins.close();
  }

  console.log(`\nFixture results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  if (failed) process.exitCode = 1;
}

run().catch((error) => {
  console.error(`  ✗ fixture suite crashed: ${error.stack || error}`);
  process.exitCode = 1;
});
