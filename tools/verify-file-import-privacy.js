/* Browser privacy regression for the file-import boundary (conedrat-1487e245).
   Usage:
     NODE_PATH=/home/coding/spaxel/dashboard/node_modules \
     CHROME_PATH=/nix/store/...-chromium/bin/chromium \
     node tools/verify-file-import-privacy.js

   The page is served by a local application-origin server that records every
   request it receives. The Cloudflare beacon is replaced only at its network
   boundary with a local, name-only recorder so the real analytics.js,
   app.js, FileReader, parsers, and ZIP decompressor still run in Chromium.
   No imported bytes or filenames are sent to the application-origin server.
*/
"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const zlib = require("zlib");

let chromium;
try {
  ({ chromium } = require("playwright"));
} catch (e) {
  console.error(
    "playwright not resolvable — run with e.g.\n" +
    "  NODE_PATH=/home/coding/spaxel/dashboard/node_modules node tools/verify-file-import-privacy.js"
  );
  process.exit(2);
}

const ROOT = path.join(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const FIXTURES_DIR = path.join(ROOT, "test", "fixtures");
const ANALYTICS_ORIGIN = "https://privacy-test.invalid";
const EVENTS = new Set(["parse_success", "parse_error"]);
const STATIC_PATHS = new Set([
  "/", "/styles.css", "/calc.js", "/sample.js", "/gbc.js",
  "/analytics.js", "/monitor.js", "/checkout.js", "/app.js", "/gbc-config.json", "/rates.json"
]);
const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".xml": "application/xml",
  ".png": "image/png"
};

function startStaticServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url, "http://application.test");
      const body = Buffer.concat(chunks).toString("utf8");
      const record = {
        method: req.method,
        path: url.pathname,
        query: url.search,
        body,
        headers: Object.assign({}, req.headers),
        status: 0
      };
      requests.push(record);

      const relative = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const absolute = path.join(PUBLIC_DIR, path.normalize(relative));
      if (!absolute.startsWith(PUBLIC_DIR) || !fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
        record.status = 404;
        res.writeHead(404, { "content-type": "text/plain" });
        return res.end("not found");
      }
      record.status = 200;
      res.writeHead(200, { "content-type": CONTENT_TYPES[path.extname(absolute)] || "application/octet-stream" });
      fs.createReadStream(absolute).pipe(res);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      origin: "http://127.0.0.1:" + server.address().port,
      requests,
      stop: () => new Promise((done) => server.close(done))
    }));
  });
}

// The browser-side ZIP path accepts ordinary deflate streams. Build one in
// memory so this regression test does not add a binary fixture to the repo.
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function deflatedZip(name, input) {
  const filename = Buffer.from(name, "utf8");
  const source = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const compressed = zlib.deflateRawSync(source);
  const crc = crc32(source);

  const local = Buffer.alloc(30 + filename.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(source.length, 22);
  local.writeUInt16LE(filename.length, 26);
  filename.copy(local, 30);

  const central = Buffer.alloc(46 + filename.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(source.length, 24);
  central.writeUInt16LE(filename.length, 28);
  filename.copy(central, 46);

  const directoryOffset = local.length + compressed.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(directoryOffset, 16);
  return Buffer.concat([local, compressed, central, end]);
}

function fileBuffer(name, contents, mimeType) {
  return { name, mimeType, buffer: Buffer.isBuffer(contents) ? contents : Buffer.from(contents) };
}

let failures = 0;
function check(condition, message) {
  console.log(`  ${condition ? "✓" : "✗"} ${message}`);
  if (!condition) failures++;
}

function requestText(record) {
  return JSON.stringify(record) + "\n" + record.body + "\n" + Object.values(record.headers || {}).join("\n");
}

async function waitForAnalytics(events, count) {
  const deadline = Date.now() + 5000;
  while (events.length < count && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
}

(async () => {
  const csv = fs.readFileSync(path.join(FIXTURES_DIR, "sample-greenbutton.csv"));
  const xml = fs.readFileSync(path.join(FIXTURES_DIR, "sample-greenbutton.xml"));
  const site = await startStaticServer();
  const analytics = [];
  let browser;

  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROME_PATH || undefined,
      args: ["--no-sandbox"]
    });
    const page = await browser.newPage();
    const browserRequests = [];
    const pageErrors = [];
    page.on("request", (request) => browserRequests.push({
      method: request.method(),
      url: request.url(),
      body: request.postData() || ""
    }));
    page.on("pageerror", (error) => pageErrors.push(String(error)));

    // Keep the real analytics choke point and the real page code in play. The
    // stand-in emits the exact one-name event as a JSON network body, which is
    // sufficient to inspect what a future call site would send to Cloudflare.
    await page.route("https://static.cloudflareinsights.com/beacon.min.js", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/javascript",
        body: `window._cf={event:function(name){navigator.sendBeacon(${JSON.stringify(ANALYTICS_ORIGIN + "/event")},JSON.stringify({event:name}));}};`
      })
    );
    await page.route(ANALYTICS_ORIGIN + "/event", async (route) => {
      const request = route.request();
      analytics.push({ method: request.method(), url: request.url(), body: request.postData() || "" });
      await route.fulfill({ status: 204 });
    });

    console.log(`File-import privacy browser regression — site ${site.origin}\n`);
    console.log("1. Load only the required page assets");
    const ratesRequest = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return url.origin === site.origin && url.pathname === "/rates.json";
    });
    await page.goto(site.origin + "/", { waitUntil: "load", timeout: 30000 });
    await ratesRequest;
    await page.waitForSelector("#file", { state: "attached" });
    check(pageErrors.length === 0, "page loads without browser errors");

    const importFile = async (payload, label) => {
      const expectedEventCount = analytics.length + 1;
      await page.setInputFiles("#file", payload);
      await page.waitForFunction((expected) => document.body.textContent.includes("Showing: " + expected), label);
      await waitForAnalytics(analytics, expectedEventCount);
    };
    const failedImport = async (payload) => {
      const expectedEventCount = analytics.length + 1;
      await page.setInputFiles("#file", payload);
      await page.waitForSelector("#error", { state: "visible" });
      await waitForAnalytics(analytics, expectedEventCount);
    };

    console.log("\n2. Successful CSV, XML/ESPI, and deflated ZIP imports");
    await importFile(fileBuffer("ConEd_ACCOUNT_552811_usage_2025.csv", csv, "text/csv"),
      "ConEd_ACCOUNT_552811_usage_2025.csv");
    await importFile(fileBuffer("ConEd_ACCOUNT_552811_billing_2025.xml", xml, "application/xml"),
      "ConEd_ACCOUNT_552811_billing_2025.xml");
    const zipName = "ConEd_ACCOUNT_552811_billing_2025.xml";
    const zip = deflatedZip(zipName, xml);
    await importFile(fileBuffer("ConEd_ACCOUNT_552811_usage_bundle.zip", zip, "application/zip"),
      "ConEd_ACCOUNT_552811_usage_bundle.zip");
    check(analytics.filter((event) => event.body.includes("parse_success")).length === 3,
      "each successful import produced one documented parse_success event");

    console.log("\n3. Failed CSV, XML, and ZIP parses stay local");
    await failedImport(fileBuffer("ConEd_ACCOUNT_552811_invalid_usage.csv",
      "DATE,START TIME,USAGE (kWh)\nnot-a-date,not-a-time,not-a-number\n", "text/csv"));
    await failedImport(fileBuffer("ConEd_ACCOUNT_552811_invalid_billing.xml",
      "<?xml version=\"1.0\"?><feed><entry><id>CONED_ACCOUNT_552811</id></entry></feed>", "application/xml"));
    await failedImport(fileBuffer("ConEd_ACCOUNT_552811_corrupt_usage.zip",
      Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]), "application/zip"));
    await waitForAnalytics(analytics, 6);
    check(analytics.filter((event) => event.body.includes("parse_error")).length === 3,
      "each failed parse produced one documented parse_error event");

    console.log("\n4. Application-origin request allowlist and data-boundary accounting");
    const allowedSiteRequests = site.requests.every((request) =>
      request.method === "GET" && request.status === 200 && STATIC_PATHS.has(request.path) &&
      request.query === "" && request.body === ""
    );
    check(allowedSiteRequests,
      "the application server received only empty-body GETs for required static paths" +
      (allowedSiteRequests ? "" : " — " + site.requests.map((r) => `${r.method} ${r.path}${r.query}`).join(", ")));
    check(site.requests.length > 0, "application-origin requests were recorded");
    check(site.requests.length === STATIC_PATHS.size &&
      new Set(site.requests.map((request) => request.path)).size === STATIC_PATHS.size &&
      [...STATIC_PATHS].every((requestPath) => site.requests.some((request) => request.path === requestPath)),
      "the recorded static request set is exactly the page's required assets");

    const markerValues = [
      "ConEd_ACCOUNT_552811_usage_2025.csv",
      "ConEd_ACCOUNT_552811_billing_2025.xml",
      "ConEd_ACCOUNT_552811_usage_bundle.zip",
      "ConEd_ACCOUNT_552811_invalid_usage.csv",
      "ConEd_ACCOUNT_552811_invalid_billing.xml",
      "ConEd_ACCOUNT_552811_corrupt_usage.zip",
      "2025-06-01",
      "0.15",
      "IntervalReading",
      "powerOfTenMultiplier",
      "UsageSummary",
      "billingPeriod",
      "CONED_ACCOUNT_552811",
      "8e2f41c0-coned-sample-0000-000000000001",
      "1750353600"
    ];
    markerValues.forEach((marker) => check(
      site.requests.every((request) => !requestText(request).includes(marker)),
      `application server never received ${marker}`
    ));
    check(site.requests.every((request) => request.method !== "POST" && request.method !== "PUT" && request.method !== "PATCH"),
      "no application-server write request occurred during any import");

    console.log("\n5. Network-wide request classification");
    const expectedStaticBeacon = "https://static.cloudflareinsights.com/beacon.min.js";
    const unknownRequests = browserRequests.filter((request) => {
      const url = new URL(request.url);
      if (url.origin === site.origin) return false;
      if (request.url === expectedStaticBeacon && request.method === "GET" && request.body === "") return false;
      if (url.origin === ANALYTICS_ORIGIN && url.pathname === "/event") return false;
      return true;
    });
    check(unknownRequests.length === 0,
      "the browser made no request outside the application server, required beacon script, and recorded analytics endpoint" +
      (unknownRequests.length ? " — " + unknownRequests.map((r) => r.url).join(", ") : ""));
    check(browserRequests.some((request) => request.url === expectedStaticBeacon),
      "the intentional analytics beacon script request was recorded");

    const validAnalytics = analytics.length === 6 && analytics.every((event) => {
      if (event.method !== "POST") return false;
      try {
        const payload = JSON.parse(event.body);
        return Object.keys(payload).length === 1 && EVENTS.has(payload.event) &&
          event.body === JSON.stringify({ event: payload.event });
      } catch (e) {
        return false;
      }
    });
    check(validAnalytics,
      "analytics requests contain exactly one documented bare event name and no payload fields");
    markerValues.forEach((marker) => check(
      analytics.every((event) => !requestText(event).includes(marker)),
      `analytics never received ${marker}`
    ));
    check(pageErrors.length === 0, "no browser errors occurred across successful and failed imports" +
      (pageErrors.length ? ` — ${pageErrors.join(" | ")}` : ""));
  } catch (error) {
    check(false, `browser regression crashed: ${error.message.split("\n")[0]}`);
  } finally {
    if (browser) await browser.close();
    await site.stop();
  }

  console.log(`\n${failures === 0 ? "File-import privacy browser regression passed ✓" : `${failures} check(s) failed ✗`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((error) => {
  console.error("verification run failed:", error);
  process.exit(2);
});
