/* Analytics privacy contract tests
   Usage: node test/analytics-privacy.js
   The written contract: docs/notes/analytics-privacy.md.
   The enforcement choke point: public/analytics.js.

   Proves that the only analytics this site sends — the sample-button click,
   the parse-success and parse-error funnel events — reach Cloudflare Web
   Analytics as a bare event name and can carry no interval data, billing
   data, account identifiers, tokens, filenames, or raw file content:

   1. the allowlist is exactly the contract's three events, each documented
   2. each allowed event ships as its bare name — one call, one argument
   3. fields never ride along, even when a caller tries to pass them
   4. dynamically composed or unknown names fail closed — nothing is sent
   5. static scan: the Cloudflare sender is touched only inside analytics.js
   6. every .track() call site passes a single static allowlisted literal
   7. the beacon in index.html is configured with nothing but the site token
   8. README, privacy notes, and the page copy document the same boundary */
const fs = require("fs");
const path = require("path");
const analytics = require("../public/analytics.js");

let testsPassed = 0;
let testsFailed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    testsPassed++;
  } else {
    console.log(`  ✗ ${message}`);
    testsFailed++;
  }
}

const ROOT = path.join(__dirname, "..");
const CONTRACT_EVENTS = ["parse_error", "parse_success", "sample_click"];

// Capture whatever reaches the beacon sender (analytics.js reads root._cf at
// call time, so a stub on globalThis in Node is exactly the browser seam).
const sent = [];
globalThis._cf = { event: (...args) => sent.push(args) };
const reset = () => { sent.length = 0; };

// Test 1: The allowlist is exactly the contract's event set
console.log("Test 1: The allowlist is exactly the contract's event set");
const allowed = Object.keys(analytics.ALLOWED_EVENTS).sort();
assert(JSON.stringify(allowed) === JSON.stringify([...CONTRACT_EVENTS].sort()),
  `allowlist is exactly {${CONTRACT_EVENTS.join(", ")}} (found: ${allowed.join(", ") || "empty"})`);
CONTRACT_EVENTS.forEach((name) =>
  assert(typeof analytics.ALLOWED_EVENTS[name] === "string" && analytics.ALLOWED_EVENTS[name].length > 0,
    `"${name}" documents when it fires`));
console.log("");

// Test 2: Each allowed event ships as its bare name
console.log("Test 2: Each allowed event ships as its bare name — one call, one argument");
CONTRACT_EVENTS.forEach((name) => {
  reset();
  analytics.track(name);
  assert(sent.length === 1, `"${name}" produces exactly one beacon call`);
  assert(sent.length === 1 && sent[0].length === 1, `"${name}" reaches the beacon with exactly one argument`);
  assert(sent.length === 1 && sent[0][0] === name, `"${name}" forwards the bare name, unmodified`);
});
reset();
console.log("");

// Test 3: Fields never ride along — every forbidden class is discarded
console.log("Test 3: No forbidden payload can ride along — extra arguments are discarded");
const fixtureXml = fs.readFileSync(path.join(ROOT, "test/fixtures/sample-greenbutton.xml"), "utf8");
const fixtureCsv = fs.readFileSync(path.join(ROOT, "test/fixtures/sample-greenbutton.csv"), "utf8");
// One live value per class the contract forbids — including the two things a
// "helpful" implementation would most want to attach: the failing filename and
// the on-screen parse-error message.
const forbidden = {
  filename: "greenbutton_nov2024_export.xml",
  rawFileContent: fixtureXml.slice(0, 400),
  intervalData: fixtureCsv.split("\n").find((l) => /\d{4}-\d{2}-\d{2}/.test(l)) || "",
  billingData: "$87.42 total — supply $31.10, delivery $56.32",
  accountIdentifier: "CONED-88123456789 (SC1)",
  // Synthetic and GBC-shaped ("sbx_" + hex, the way the sandbox mints them),
  // composed at runtime so no credential-looking literal sits in source.
  token: "sbx_" + "0123456789abcdef".repeat(2),
  errorMessage: "Couldn't read that file: unexpected <entry> at line 12"
};
const forbiddenValues = Object.values(forbidden);
assert(forbiddenValues.every((v) => typeof v === "string" && v.length > 3),
  "contamination battery has a live value for every forbidden class");

CONTRACT_EVENTS.forEach((name) => {
  reset();
  analytics.track(name, forbidden);
  assert(sent.length === 1 && sent[0].length === 1,
    `"${name}" with a fields object attached still ships one bare argument`);
  const shipped = JSON.stringify(sent);
  forbiddenValues.forEach((v) =>
    assert(!shipped.includes(v),
      `"${name}": forbidden payload absent from what shipped (${v.slice(0, 34).replace(/\n/g, " ")}…)`));
});

reset();
analytics.track("parse_error", "Couldn't read greenbutton.csv: line 12");
analytics.track("parse_error", ["greenbutton.csv", fixtureXml]);
assert(JSON.stringify(sent) === JSON.stringify([["parse_error"], ["parse_error"]]),
  "string and array fields are discarded as well — only the name ships");
reset();
console.log("");

// Test 4: Composed or unknown names fail closed
console.log("Test 4: Composed or unknown names fail closed — nothing is sent");
const file = "greenbutton_nov2024.xml";
reset();
analytics.track("parse_error_" + file);   // name composed from a filename
analytics.track("conn_" + "sbx_token");   // name composed from a token
analytics.track(file);                    // a filename used AS the name
analytics.track("");                      // empty
analytics.track();                        // missing
analytics.track("parse sucess");          // unregistered (typo'd) name
assert(sent.length === 0,
  "none of the composed, mistyped, or unregistered names reached the beacon");
assert(typeof analytics.track("parse_success", {}) === "undefined",
  "track() returns nothing — it is fire-and-forget, never a data channel");
reset();
console.log("");

// Test 5: Static scan — the sender is reachable only through the choke point
console.log("Test 5: Static scan — the Cloudflare sender is touched only inside analytics.js");
const jsFiles = [];
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
  const p = path.join(dir, e.name);
  if (e.isDirectory()) walk(p);
  else if (e.name.endsWith(".js")) jsFiles.push(p);
});
walk(path.join(ROOT, "public"));
walk(path.join(ROOT, "functions"));
const SENDER = /\b_cf\b|cloudflareinsights|sendBeacon/;
const chokePoint = path.join(ROOT, "public", "analytics.js");
jsFiles.filter((f) => f !== chokePoint).forEach((f) => {
  const rel = path.relative(ROOT, f);
  const offending = fs.readFileSync(f, "utf8").split("\n")
    .map((line, i) => (SENDER.test(line) ? `${rel}:${i + 1}` : null))
    .filter(Boolean);
  assert(offending.length === 0,
    `${rel} never touches the analytics sender${offending.length ? " — " + offending.join(", ") : ""}`);
});
assert(SENDER.test(fs.readFileSync(chokePoint, "utf8")),
  "public/analytics.js is the one place that touches the sender");
console.log("");

// Test 6: Every call site passes a single static allowlisted literal
console.log("Test 6: Every call site passes a single static allowlisted literal");
const callSites = [];
jsFiles.filter((f) => f !== chokePoint).forEach((f) => {
  const rel = path.relative(ROOT, f);
  fs.readFileSync(f, "utf8").split("\n").forEach((line, i) => {
    if (line.includes(".track(")) callSites.push({ where: `${rel}:${i + 1}`, line });
  });
});
assert(callSites.length === CONTRACT_EVENTS.length,
  `exactly ${CONTRACT_EVENTS.length} call sites send events (found ${callSites.length})`);
const siteNames = [];
callSites.forEach(({ where, line }) => {
  const args = (line.match(/\.track\((.*)\)/) || [])[1];
  const name = typeof args === "string" ? (args.match(/^'([a-z_]+)'$/) || [])[1] : undefined;
  assert(!!name, `${where} passes a single static string literal (${line.trim().slice(0, 48)})`);
  if (name) siteNames.push(name);
});
assert(JSON.stringify(siteNames.sort()) === JSON.stringify([...CONTRACT_EVENTS].sort()),
  "the call sites' event set equals the allowlist — no drift in either direction");
console.log("");

// Test 7: The beacon itself is configured with nothing but the site token
console.log("Test 7: The beacon in index.html is configured with nothing but the site token");
const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
const tags = html.match(/data-cf-beacon='([^']*)'/g) || [];
assert(tags.length === 1, "index.html loads exactly one Cloudflare beacon");
let cfg = null;
try { cfg = JSON.parse((tags[0].match(/data-cf-beacon='([^']*)'/) || ["", ""])[1]); } catch (e) { /* reported below */ }
assert(!!cfg && JSON.stringify(Object.keys(cfg)) === '["token"]',
  `the beacon config carries only {"token"} (found: ${cfg ? Object.keys(cfg).join(", ") : "unparseable"})`);
assert((html.match(/cloudflareinsights/g) || []).length === 1,
  "the beacon script is the only Cloudflare endpoint referenced in the page");
assert(!/\b_cf\b/.test(html), "the page (including its inline scripts) never touches the sender");
const anaIdx = html.indexOf('src="analytics.js"');
const appIdx = html.indexOf('src="app.js"');
assert(anaIdx !== -1 && appIdx !== -1 && anaIdx < appIdx,
  "index.html loads the choke point (analytics.js) before app.js");
console.log("");

// Test 8: Documentation regression — distinguish the application-server
// boundary from the intentional Cloudflare analytics request. This keeps a
// future copy edit from restoring the old, broader "nothing is sent anywhere"
// promise while the beacon remains enabled.
console.log("Test 8: Documentation distinguishes file data from Cloudflare analytics");
const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
const analyticsDoc = fs.readFileSync(path.join(ROOT, "docs/notes/analytics-privacy.md"), "utf8");
const boundaryDoc = fs.readFileSync(path.join(ROOT, "docs/notes/gbc-data-boundary.md"), "utf8");
const pageCopy = fs.readFileSync(path.join(ROOT, "public/index.html"), "utf8");
const compact = (value) => value.replace(/\s+/g, " ").toLowerCase();
const readmeCopy = compact(readme);
const analyticsCopy = compact(analyticsDoc);
const boundaryCopy = compact(boundaryDoc);
const pageCopyText = compact(pageCopy);
assert(readmeCopy.includes("file-import path makes no application-server data request") &&
       readmeCopy.includes("uploads no file, usage, or billing data"),
  "README documents that file imports do not send file or usage data to the application server");
assert(readmeCopy.includes("anonymous pageview and allowlisted parse events may still reach cloudflare"),
  "README documents the intentional Cloudflare analytics exception");
assert(analyticsCopy.includes("file imports make no application-server data request") &&
       analyticsCopy.includes("no file, usage, or billing content is sent to the application server or included in analytics"),
  "analytics privacy note documents the application-server and payload boundary");
assert(analyticsCopy.includes("the cloudflare beacon is a separate, intentional analytics path"),
  "analytics privacy note records that the beacon is intentionally retained");
assert(boundaryCopy.includes("no file, usage, or billing content is uploaded to the application server or included in analytics") &&
       boundaryCopy.includes("anonymous pageview/allowlisted interaction events may reach cloudflare"),
  "GBC boundary note includes the same Cloudflare exception");
assert(pageCopyText.includes("importing a file makes no application-server data request") &&
       pageCopyText.includes("anonymous pageview and bare allowlisted interaction events may reach cloudflare"),
  "page privacy copy states both sides of the boundary");
const privacySurfaces = [readme, analyticsDoc, boundaryDoc, pageCopy].map(compact);
assert(!privacySurfaces.some((copy) => copy.includes("usage data is never uploaded or sent anywhere") ||
                                    copy.includes("nothing derived from your usage or billing data is ever transmitted anywhere")),
  "privacy surfaces do not make the stale no-network promise while the beacon is enabled");
console.log("");

console.log("Analytics privacy contract tests:");
console.log(`  Passed: ${testsPassed}`);
console.log(`  Failed: ${testsFailed}`);
console.log(`  Total:  ${testsPassed + testsFailed}`);
console.log("");

if (testsFailed > 0) {
  process.exit(1);
} else {
  console.log("All tests passed! ✓");
  process.exit(0);
}
