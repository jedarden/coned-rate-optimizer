/* Browser end-to-end for the Green Button Connect flow (conedrat-1d3bea35).
   Usage:
     NODE_PATH=/home/coding/spaxel/dashboard/node_modules \
     CHROME_PATH=/nix/store/…-chromium/bin/chromium \
     node tools/verify-gbc-browser.js

   Stands up the sandbox Third-Party App (test/gbc-sandbox.js: mock OAuth
   authorize/token + ESPI Data Custodian serving the shared interval fixture)
   plus a static server for public/ whose /api/gbc/token route delegates to
   the REAL Pages Function. Then drives a real Chromium through:

     1. the shipped unconfigured state  → connect panel hidden, page unchanged
     2. click Connect → mock authorize → redirect back → code exchanged
     3. interval + billing feeds pulled → verdict rendered ("ConEd account" label)
     4. access token present in this tab's sessionStorage
     5. Disconnect clears the token and resets the panel

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
 *  route always delegates to the real Pages Function. */
function startStatic(box) {
  const server = http.createServer((req, res) => {
    handler(req, res).catch((e) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(String(e && e.message));
    });
  });
  async function handler(req, res) {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/gbc-config.json") {
      if (box.staticMode === "configured") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({
          configured: true,
          clientId: box.clientId,
          authorizeUrl: box.origin + "/authorize",
          apiBase: box.origin,
          scopes: ["FB=4_5_6", "USAGE_READ"],
          tokenExchangePath: "/api/gbc/token"
        }));
      }
      return serveFile(res, "gbc-config.json");
    }
    if (u.pathname === "/api/gbc/token" && req.method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const response = await worker.onRequestPost({
        request: new Request("http://x/api/gbc/token", {
          method: "POST",
          headers: { "content-type": "application/json", "origin": "http://x" },
          body: Buffer.concat(chunks).toString("utf8")
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
      resolve({ server, origin: "http://127.0.0.1:" + server.address().port, stop: () => new Promise((d) => server.close(d)) });
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
    ok(await page.isVisible("#gbc-refresh") && await page.isVisible("#gbc-disconnect"), "connected controls (re-pull, disconnect) shown");
    const conn = await page.evaluate(() => JSON.parse(sessionStorage.getItem("gbc-connection") || "null"));
    ok(!!conn && conn.accessToken === box.accessToken, "access token lives in this tab's sessionStorage (and nowhere else)");
    ok(pageErrors.length === 0, "no page errors" + (pageErrors.length ? ` — ${pageErrors.join(" | ")}` : ""));

    console.log("\n4. Disconnect");
    await page.click("#gbc-disconnect");
    await page.waitForFunction(() => sessionStorage.getItem("gbc-connection") === null);
    ok(true, "disconnect removes the token from sessionStorage");
    await page.waitForSelector("#gbc-connect", { state: "visible" });
    ok(true, "panel resets to the connect state");
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
