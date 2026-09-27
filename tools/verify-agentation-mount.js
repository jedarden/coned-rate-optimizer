/* Agentation mount verification (conedrat-341ced52).
   Workspace rules require every HTML entry point to be verified by the
   #agentation-root mount after load — never by grepping for the script tag
   (a module whose imports fail to resolve leaves the page rendering
   perfectly with no toolbar, so the tag alone proves nothing).

   Usage:
     node tools/verify-agentation-mount.js [base-url]
   base-url defaults to http://localhost:8137 (see "Run locally" in the
   README; 8000 is often taken by another app on this shared box); pass
   https://coned.jedarden.com to check production.

   Feedback mode (?feedback=1) must:
     1. mount: #agentation-root exists in the DOM after load.
   Normal mode (no param) must — the privacy half of the wiring:
     2. not mount: #agentation-root absent,
     3. fetch nothing extra: no request to esm.sh or anything
        agentation-related fires at all.

   Needs playwright (repo itself stays dependency-free); run e.g.:
     NODE_PATH=/home/coding/spaxel/dashboard/node_modules \
       node tools/verify-agentation-mount.js [base-url]
   On NixOS the playwright browsers lack system libraries — point
   CHROME_PATH at a nix-provided chromium instead:
     CHROME_PATH=/nix/store/53p8msmqxpi829zdrw6qkvaamidxy9cj-chromium-151.0.7922.173/bin/chromium
*/
const base = (process.argv[2] || "http://localhost:8137").replace(/\/+$/, "");
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  console.error(
    "playwright not resolvable — run with e.g.\n" +
    "  NODE_PATH=/home/coding/spaxel/dashboard/node_modules node tools/verify-agentation-mount.js"
  );
  process.exit(2);
}

let failures = 0;
function check(ok, label, detail) {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures++;
}

(async () => {
  const browser = await chromium.launch(
    process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}
  );

  // Feedback mode: the toolbar must actually mount — the canonical
  // #agentation-root marker AND the rendered toolbar (v3 portals it to
  // body and renders its UI inside a shadow root, so the light DOM alone
  // proves less than it seems; an empty host div is not a mount).
  console.log(`feedback mode: ${base}/?feedback=1`);
  {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e)));
    await page.goto(`${base}/?feedback=1`, { waitUntil: "load", timeout: 30000 });
    let mounted = true;
    try {
      await page.waitForSelector("#agentation-root", { state: "attached", timeout: 20000 });
    } catch {
      mounted = false;
    }
    check(mounted, "#agentation-root attached after load");
    const rendered = await page
      .waitForSelector("agentation-toolbar", { state: "attached", timeout: 10000 })
      .then((el) => el.evaluate((t) => !!t.shadowRoot && t.shadowRoot.childElementCount > 0))
      .catch(() => false);
    check(rendered, "agentation-toolbar rendered with shadow content");
    check(pageErrors.length === 0, "no page errors", pageErrors.join(" | ").slice(0, 300));
    await page.close();
  }

  // Normal mode: no toolbar, and no feedback payload fetched at all.
  console.log(`normal mode:  ${base}/`);
  {
    const page = await browser.newPage();
    const requested = [];
    page.on("request", (r) => requested.push(r.url()));
    await page.goto(`${base}/`, { waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(2500); // late dynamic imports would still show up
    const mounted = await page.evaluate(() => !!document.getElementById("agentation-root"));
    check(!mounted, "#agentation-root absent without ?feedback=1");
    const stray = requested.filter((u) => /esm\.sh|agentation/i.test(u));
    check(stray.length === 0, "no esm.sh/agentation requests", stray.join(", ").slice(0, 300));
    await page.close();
  }

  await browser.close();
  if (failures) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nOK: toolbar mounts in feedback mode; normal visitors fetch nothing extra");
})().catch((e) => {
  console.error("verification run failed:", e);
  process.exit(2);
});
