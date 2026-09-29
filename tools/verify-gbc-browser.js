/* Browser end-to-end for the Green Button Connect flow (conedrat-1d3bea35).
   Usage:
     NODE_PATH=/home/coding/spaxel/dashboard/node_modules \
     CHROME_PATH=/nix/store/…-chromium/bin/chromium \
     node tools/verify-gbc-browser.js

   Stands up the sandbox Third-Party App (test/gbc-sandbox.js: mock OAuth
   authorize/token + ESPI Data Custodian serving the shared interval fixture)
   plus a static server for public/ whose /api/gbc/token route delegates to
   the REAL Pages Function. Then drives a real Chromium through:

     1. the shipped unconfigured state  → connect panel hidden, page unchanged;
        the sample verdict carries the unverified-confidence label (no bills)
     2. click Connect → mock authorize → redirect back → code exchanged
     3. interval + billing feeds pulled → verdict rendered ("ConEd account" label),
        the confidence call reflects the imported billing history, and the
        bill-replay section names what couldn't be checked
     3b. a grant revoked mid-session → Re-pull shows the friendly reconnect
        guidance (then a restored grant re-pulls the feeds)
     4. a file import merges into the retained monitoring series — the
        connected account's bill evidence stays live for its own periods
     5. Disconnect clears the token and resets the panel — but NOT the
        stored monitoring history (deletion is a separate, explicit act)
     6. reload restores the retained history; "Delete stored data" removes
        it from localStorage permanently and the page forgets
     7. OAuth callback validation, live in the page: a callback with no
        stored state or a tampered state is refused and its code is never
        exchanged; a valid state with a bogus code is the one refused shape
        allowed to reach the token endpoint, and the upstream refusal passes
        through the real function while storing no connection; an OAuth
        error callback renders its friendly copy
     8. sessionStorage token lifetime: expires_in becomes expiresAt, a
        revisit restores the still-fresh connection locally without
        re-pulling a single feed, an expired token is dropped on load and
        never touches ConEd, and a token inside the 30s freshness margin is
        not restored either
     9. whole-run boundary accounting (docs/notes/gbc-data-boundary.md,
        re-proven at browser level): every POST the app server received was
        the token exchange and every body was exactly {code, redirectUri};
        no usage byte and never the access token reached the app server; the
        interval and billing feeds were fetched directly by the browser from
        the Data Custodian, each GET riding the bearer token

   Not part of scripts/definition-of-done.sh (needs a browser); the Node-only
   authorization harness it mirrors runs there as node test/gbc-sandbox.js. */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");

let playwright;
try {
  playwright = require("playwright");
} catch (e) {
  console.error("playwright not found — run with NODE_PATH=/home/coding/spaxel/dashboard/node_modules");
  process.exit(2);
}

const { startSandbox } = require("../test/gbc-sandbox.js");
const worker = require("../functions/api/gbc/token.js");
const PUBLIC_DIR = path.join(__dirname, "..", "public");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".xml": "application/xml",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

/** Serves public/ statically. /gbc-config.json and /api/gbc/token are
 *  intercepted: the config follows `mode` ("unconfigured" = the shipped
 *  public/gbc-config.json, "configured" = the sandbox config), and the token
 *  route always delegates to the real Pages Function. Every request the app
 *  server receives is recorded — method, path, query, body, headers, and the
 *  response status — into the returned `requests` log; the section 9
 *  boundary accounting reads it. */
function startStatic(box) {
  const requests = [];
  const server = http.createServer((req, res) => {
    handler(req, res).catch((e) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(String(e && e.message));
    });
  });
  async function handler(req, res) {
    const u = new URL(req.url, "http://x");
    const chunks = [];
    if (req.method === "POST") for await (const c of req) chunks.push(c);
    const rec = {
      method: req.method,
      path: u.pathname,
      query: u.search,
      body: Buffer.concat(chunks).toString("utf8"),
      headers: Object.assign({}, req.headers),
      status: 0
    };
    const writeHead = res.writeHead.bind(res);
    res.writeHead = function (code) { rec.status = code; return writeHead.apply(res, arguments); };
    requests.push(rec);
    if (u.pathname === "/gbc-config.json") {
      if (box.staticMode === "configured") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({
          configured: true,
          clientId: box.clientId,
          authorizeUrl: box.origin + "/authorize",
          apiBase: box.origin,
          redirectUri: box.origin + "/",
          scopes: ["FB=4_5_6", "USAGE_READ"],
          tokenExchangePath: "/api/gbc/token"
        }));
      }
      return serveFile(res, "gbc-config.json");
    }
    if (u.pathname === "/api/gbc/token" && req.method === "POST") {
      const response = await worker.onRequestPost({
        request: new Request("http://x/api/gbc/token", {
          method: "POST",
          headers: { "content-type": "application/json", "origin": "http://x" },
          body: rec.body
        }),
        env: { GBC_CLIENT_ID: box.clientId, GBC_CLIENT_SECRET: box.clientSecret, GBC_TOKEN_URL: box.origin + "/token" }
      });
      // Re-issue against the real origin so the browser's same-origin fetch works.
      const text = await response.text();
      res.writeHead(response.status, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(text);
    }
    const rel = path.normalize(u.pathname).replace(/^([/\\])+/, "");
    return serveFile(res, rel === "" ? "index.html" : rel);
  }
  function serveFile(res, rel) {
    const abs = path.join(PUBLIC_DIR, rel);
    if (!abs.startsWith(PUBLIC_DIR) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("not found: " + rel);
    }
    res.writeHead(200, { "content-type": TYPES[path.extname(abs)] || "application/octet-stream" });
    fs.createReadStream(abs).pipe(res);
  }
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        server,
        origin: "http://127.0.0.1:" + server.address().port,
        requests,
        stop: () => new Promise((d) => server.close(d))
      });
    });
  });
}

let failed = 0;
const ok = (cond, msg) => {
  console.log(`  ${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failed++;
};

(async () => {
  const box = await startSandbox();
  box.staticMode = "unconfigured";
  const site = await startStatic(box);
  const executablePath = process.env.CHROME_PATH || undefined;
  const browser = await playwright.chromium.launch({ executablePath, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  try {
    console.log(`GBC browser E2E — site ${site.origin}, sandbox ${box.origin}\n`);

    console.log("1. Shipped (unconfigured) state");
    await page.goto(site.origin + "/", { waitUntil: "load" });
    await page.waitForFunction(() => document.getElementById("gbc-panel") !== null);
    ok(await page.isVisible("#gbc-panel") === false, "connect panel is hidden when gbc-config.json is unconfigured");
    ok(await page.isVisible("#drop"), "the file drop zone is unaffected");

    console.log("\n1b. Sample verdict carries its confidence label");
    await page.click("#sample-btn");
    await page.waitForSelector("#results", { state: "visible" });
    const sampleBody = await page.textContent("body");
    ok(/Confidence: medium/.test(sampleBody) && /no actual bills imported/.test(sampleBody),
      "no billing history → the estimate label renders above the verdict");
    ok(await page.$("#bill-table") === null, "no bill-replay table without a billing history");

    console.log("\n2. Configured: connect + authorize");
    box.staticMode = "configured";
    await page.reload({ waitUntil: "load" });
    await page.waitForSelector("#gbc-connect", { state: "visible", timeout: 10000 });
    ok(true, "connect panel appears once configured");
    await page.click("#gbc-connect");
    await page.waitForSelector("#results", { state: "visible", timeout: 15000 });
    ok(!/[?&]code=/.test(page.url()), "callback consumed — ?code= is gone from the address bar (" + page.url() + ")");

    console.log("\n3. Feeds pulled and analyzed");
    const body = await page.textContent("body");
    ok(/ConEd account · usage point 9/.test(body), "result is labelled as the connected-account import");
    ok(/billing summar/.test(body), "billing feed retrieval is surfaced");
    ok(/Confidence: medium/.test(body) && /nothing could be checked/.test(body),
      "imported bills the interval data can't cover → the confidence call says so, not 'verified'");
    ok(/not checked:/.test(body) && /interval data covers 0 of 30 days/.test(body),
      "the uncovered bill is named in the bill-replay section, never priced on invented usage");
    ok(await page.isVisible("#gbc-refresh") && await page.isVisible("#gbc-disconnect"), "connected controls (re-pull, disconnect) shown");
    const conn = await page.evaluate(() => JSON.parse(sessionStorage.getItem("gbc-connection") || "null"));
    ok(!!conn && conn.accessToken === box.accessToken, "access token lives in this tab's sessionStorage (and nowhere else)");
    ok(pageErrors.length === 0, "no page errors" + (pageErrors.length ? ` — ${pageErrors.join(" | ")}` : ""));

    console.log("\n3b. A grant revoked mid-session: the page's reconnect guidance");
    box.revokeToken();
    await page.click("#gbc-refresh");
    await page.waitForFunction(
      () => /reconnect your account/.test(document.getElementById("gbc-status").textContent),
      null, { timeout: 10000 }
    );
    ok(true, "re-pull on a revoked grant shows the friendly reconnect guidance, not a raw error");
    box.restoreToken();
    await page.click("#gbc-refresh");
    // The verdict is still on screen from the earlier successful connect (a failed
    // re-pull doesn't clear the analysis), so body text proves nothing here — the
    // panel status is the fresh signal: it went Connected → error → Connected.
    await page.waitForFunction(
      () => /Connected · subscription/.test(document.getElementById("gbc-status").textContent),
      null, { timeout: 15000 }
    );
    ok(true, "a restored grant re-pulls the feeds through the real page");

    console.log("\n4. File import merges into the retained monitoring series");
    await page.setInputFiles("#file", path.join(PUBLIC_DIR, "..", "test", "fixtures", "sample-greenbutton.csv"));
    await page.waitForFunction(() => /Showing: sample-greenbutton\.csv/.test(document.body.textContent));
    ok(true, "the file import renders under its own label");
    const status = await page.textContent("#monitor-status");
    // imports: 1 initial pull + 1 restored-grant re-pull (3b) + this file import = 3,
    // deterministic because the revoked re-pull errors before it can ingest.
    // revised periods: both months re-measured by the file import + the bill
    // summary re-pulled in 3b = 3.
    ok(/3 imports/.test(status) && /2 months retained/.test(status) && /3 periods revised/.test(status),
      "the Monitoring section reports the merged series (2 months retained · 3 imports · 3 periods revised)");
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("coned-monitor-series-v1") || "null"));
    ok(!!stored && stored.imports === 3 && stored.months.length === 2 && stored.schema === 1,
      "the series persisted to localStorage (schema 1, 2 monthly buckets, 3 imports)");
    ok(/not checked:/.test(await page.textContent("body")),
      "the connected account's bill evidence stays live for its own period — still uncovered, still named, never priced on invented usage");

    console.log("\n5. Disconnect");
    await page.click("#gbc-disconnect");
    await page.waitForFunction(() => sessionStorage.getItem("gbc-connection") === null);
    ok(true, "disconnect removes the token from sessionStorage");
    await page.waitForSelector("#gbc-connect", { state: "visible" });
    ok(true, "panel resets to the connect state");
    ok(await page.evaluate(() => localStorage.getItem("coned-monitor-series-v1")) !== null,
      "disconnect did NOT delete the stored monitoring history (deletion is a separate, explicit act)");

    console.log("\n6. Reload restores the retained history; Delete clears it permanently");
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(() => /Monitoring — your history, kept in this browser/.test(document.body.textContent));
    ok(/your retained monitoring history/.test(await page.textContent("body")),
      "a revisit restores the retained series and says so in the Showing line");
    const restored = await page.textContent("#monitor-status");
    ok(/2 months retained \(2025-06 through 2025-12\)/.test(restored),
      "the restored history reports its window (" + restored.trim().slice(0, 60) + "…)");
    ok(await page.evaluate(() => JSON.parse(localStorage.getItem("coned-monitor-series-v1")).bills.length === 1),
      "the retained bill summary survived the reload with its evidence");
    page.on("dialog", (d) => d.accept());
    await page.click("#monitor-delete");
    await page.waitForFunction(() => localStorage.getItem("coned-monitor-series-v1") === null);
    ok(true, "Delete stored data removes the series from localStorage");
    await page.waitForFunction(() => document.getElementById("results").hidden);
    ok(true, "the page forgets everything — results hidden until the next import");
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(() => document.getElementById("gbc-panel") !== null);
    ok(await page.evaluate(() => document.getElementById("results").hidden),
      "after deletion a revisit starts clean — nothing restores");
    console.log("\n7. OAuth callback validation, live in the page");
    // Disconnect (5) and the Delete (6) left no token and no CSRF state; start
    // from a proven-clean slate and walk the four callback shapes the page can
    // meet on a redirect back from ConEd.
    await page.evaluate(() => sessionStorage.clear());
    const exchangePosts = () => site.requests.filter((r) => r.method === "POST" && r.path === "/api/gbc/token");
    const postsBefore = exchangePosts().length; // section 2's successful connect
    const storedConn = () => page.evaluate(() => sessionStorage.getItem("gbc-connection"));

    await page.goto(site.origin + "/?code=auth_eavesdropped&state=eavesdropped", { waitUntil: "load" });
    await page.waitForFunction(() => document.getElementById("gbc-status").textContent.length > 0);
    ok(/state mismatch/.test(await page.textContent("#gbc-status")),
      "a callback the page never requested (no stored state) is refused as CSRF");
    ok(!/[?&](code|state)=/.test(page.url()), "the refused callback is consumed from the address bar");
    ok(await storedConn() === null, "an unrequested reply stores no connection");

    await page.evaluate(() => sessionStorage.setItem("gbc-state", "expectedstate"));
    await page.goto(site.origin + "/?code=auth_eavesdropped&state=tampered", { waitUntil: "load" });
    await page.waitForFunction(() => /state mismatch/.test(document.getElementById("gbc-status").textContent));
    ok(await storedConn() === null, "a tampered state is refused the same way — still no connection");
    ok(exchangePosts().length === postsBefore, "neither refused state ever reached the token endpoint");

    // The one refused shape allowed as far as the exchange: a well-signed
    // state carrying a code that was never issued. The real Pages Function
    // takes it upstream and passes ConEd's refusal back.
    await page.goto(site.origin + "/?code=auth_bogus&state=expectedstate", { waitUntil: "load" });
    await page.waitForFunction(() => /unknown, used, or expired code/.test(document.getElementById("gbc-status").textContent), null, { timeout: 10000 });
    ok(exchangePosts().length === postsBefore + 1, "exactly one exchange was attempted across all four callback shapes");
    const tried = exchangePosts()[exchangePosts().length - 1];
    ok(tried.body === JSON.stringify({ code: "auth_bogus", redirectUri: site.origin + "/" }),
      "the attempt carried exactly {code, redirectUri} — the registered redirect, nothing else about the page");
    ok(tried.status === 400, "the upstream refusal passed through the real function (HTTP 400)");
    ok(await storedConn() === null && await page.isVisible("#gbc-connect"),
      "a refused exchange stores no connection and leaves the panel connectable");

    await page.goto(site.origin + "/?error=access_denied&error_description=nope", { waitUntil: "load" });
    await page.waitForFunction(() => /declined the ConEd authorization/.test(document.getElementById("gbc-status").textContent));
    ok(exchangePosts().length === postsBefore + 1, "an OAuth error callback never touches the token endpoint either");

    console.log("\n8. sessionStorage token lifetime");
    await page.click("#gbc-connect");
    await page.waitForFunction(
      () => /Connected · subscription 77/.test(document.getElementById("gbc-status").textContent),
      null, { timeout: 15000 }
    );
    ok(/authorization expires in ~60 min · it lives only in this tab/.test(await page.textContent("#gbc-status")),
      "the panel names the token's lifetime and where it lives");
    const conn8 = await page.evaluate(() => JSON.parse(sessionStorage.getItem("gbc-connection")));
    ok(Math.abs(conn8.expiresAt - Date.now() - 3600e3) < 10000 && conn8.obtainedAt > 0,
      "expiresAt was computed from the response's expires_in (" + Math.round((conn8.expiresAt - Date.now()) / 1000) + "s out)");
    ok(/Stay on Standard/.test(await page.textContent("#results")),
      "the pulled feeds were parsed and analyzed in-page — the verdict renders from the connection");
    // Where the token lives, exactly: one carrier in web storage.
    const where = await page.evaluate((tok) => ({
      localStorage: Object.keys(localStorage).map((k) => k + "=" + localStorage.getItem(k)).join("|"),
      otherSession: Object.keys(sessionStorage).filter((k) => k !== "gbc-connection")
        .map((k) => k + "=" + sessionStorage.getItem(k)).join("|")
    }), box.accessToken);
    ok(!where.localStorage.includes(box.accessToken) && !where.otherSession.includes(box.accessToken),
      "no localStorage entry and no other sessionStorage key carries the token");

    const espiCount = () => box.requests.filter((r) => r.url.split("?")[0].startsWith("/espi/")).length;
    const beforeReload = espiCount();
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(
      () => /Connected · subscription 77/.test(document.getElementById("gbc-status").textContent),
      null, { timeout: 10000 }
    );
    ok(await page.isVisible("#gbc-disconnect"), "the connected controls are back after the reload");
    ok(espiCount() === beforeReload, "a revisit restores the still-fresh connection locally — not one feed re-pulled");

    await page.evaluate(() => {
      const c = JSON.parse(sessionStorage.getItem("gbc-connection"));
      c.expiresAt = Date.now() - 1000;
      sessionStorage.setItem("gbc-connection", JSON.stringify(c));
    });
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(() => sessionStorage.getItem("gbc-connection") === null);
    ok(await page.isVisible("#gbc-connect"), "an expired token is dropped on load, and the panel resets to connect");
    ok(espiCount() === beforeReload, "the dead token never touched ConEd on that load");

    await page.evaluate((tok) => sessionStorage.setItem("gbc-connection", JSON.stringify({
      accessToken: tok, tokenType: "Bearer", scope: "", expiresIn: 3600,
      obtainedAt: Date.now(), expiresAt: Date.now() + 15000
    })), box.accessToken);
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(() => sessionStorage.getItem("gbc-connection") === null);
    ok(true, "a token inside the 30s freshness margin is not restored either");

    console.log("\n9. Boundary accounting — everything the app server saw, whole run");
    const siteReqs = site.requests;
    const sitePosts = siteReqs.filter((r) => r.method === "POST");
    ok(sitePosts.length === 3 && sitePosts.every((r) => r.path === "/api/gbc/token"),
      `every POST the app server received was a token exchange (${sitePosts.length} across the whole run)`);
    ok(JSON.stringify(sitePosts.map((r) => r.status)) === JSON.stringify([200, 400, 200]),
      "exchange outcomes in order: connect, the refused bogus code, reconnect (" + sitePosts.map((r) => r.status).join(", ") + ")");
    const bodyShape = (r) => {
      try {
        const j = JSON.parse(r.body);
        return Object.keys(j).length === 2 && typeof j.code === "string" && typeof j.redirectUri === "string";
      } catch (e) { return false; }
    };
    ok(sitePosts.length > 0 && sitePosts.every(bodyShape),
      "only the authorization code reached the token endpoint — every body was exactly {code, redirectUri}");
    const usageMarkers = ["IntervalReading", "IntervalBlock", "UsageSummary", "powerOfTenMultiplier"];
    const carried = (r, s) => (r.body + " " + r.path + " " + r.query + " " + (r.headers.authorization || "")).includes(s);
    ok(siteReqs.length > 0 && siteReqs.every((r) => usageMarkers.every((m) => !carried(r, m))),
      `no interval or billing byte ever reached the app server (${siteReqs.length} requests logged)`);
    ok(siteReqs.every((r) => !carried(r, box.accessToken)), "the access token never reached the app server");
    ok(siteReqs.every((r) => !r.path.startsWith("/espi/")),
      "the app server never saw a feed request — nothing to relay, nothing to retain");

    const espi = box.requests.filter((r) => r.url.split("?")[0].startsWith("/espi/"));
    ok(espi.length > 0 && espi.every((r) => /Chrome/.test(r.headers["user-agent"] || "")),
      `every Data Custodian request came from the browser (${espi.length}, CORS preflights included)`);
    const espiGets = espi.filter((r) => r.method === "GET");
    ok(espiGets.length > 0 && espiGets.every((r) => r.headers.authorization === "Bearer " + box.accessToken),
      "every feed GET rode the bearer token, browser → ConEd directly");
    const fetched = new Set(espiGets.map((r) => r.url.split("?")[0]));
    ["/espi/1_1/resource/Subscription",
     `/espi/1_1/resource/Subscription/${conn8.subscriptionId}/UsagePoint`,
     `/espi/1_1/resource/Batch/UsagePoint/${conn8.usagePointId}`,
     `/espi/1_1/resource/UsagePoint/${conn8.usagePointId}/UsageSummary`
    ].forEach((p) => ok(fetched.has(p),
      "the browser fetched " + p.replace("/espi/1_1/resource/", "") + " directly"));

    ok(pageErrors.length === 0, "no page errors across the whole run" + (pageErrors.length ? ` — ${pageErrors.join(" | ")}` : ""));
  } catch (e) {
    ok(false, `E2E crashed: ${e.message.split("\n")[0]}`);
  } finally {
    await browser.close();
    await site.stop();
    await box.stop();
  }

  console.log(`\n${failed === 0 ? "GBC browser E2E passed ✓" : failed + " E2E check(s) failed ✗"}`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
