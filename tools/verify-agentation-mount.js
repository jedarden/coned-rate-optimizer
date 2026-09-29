/* Agentation mount verification (conedrat-341ced52).
   Workspace rules require every HTML entry point to be verified by the
   #agentation-root mount after load — never by grepping for the script tag
   (a module whose imports fail to resolve leaves the page rendering
   perfectly with no toolbar, so the tag alone proves nothing).

   Usage:
     node tools/verify-agentation-mount.js [base-url]
     node tools/verify-agentation-mount.js --local
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
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const useLocalServer = process.argv[2] === "--local";
let base = useLocalServer ? null : (process.argv[2] || "http://localhost:8137").replace(/\/+$/, "");

function isExecutable(candidate) {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findChromium() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;

  for (const command of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]) {
    try {
      const candidate = execFileSync("which", [command], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (candidate && isExecutable(candidate)) return candidate;
    } catch {
      // Try the next conventional browser location.
    }
  }

  // NixOS keeps the system Chromium binary in an immutable store path whose
  // hash changes. Find the current unwrapped package without pinning a hash.
  try {
    const candidates = fs.readdirSync("/nix/store")
      .filter((entry) => entry.includes("chromium-unwrapped-"))
      .sort()
      .reverse();
    for (const entry of candidates) {
      const candidate = path.join("/nix/store", entry, "libexec", "chromium", "chromium");
      if (isExecutable(candidate)) return candidate;
    }
  } catch {
    // This is not a NixOS host.
  }

  // Playwright's downloaded browsers do not always include the headless-shell
  // binary expected by its launcher. A full Chromium in the cache is enough.
  for (const cacheRoot of [path.join(os.homedir(), ".cache", "ms-playwright")]) {
    try {
      const versions = fs.readdirSync(cacheRoot)
        .filter((entry) => entry.startsWith("chromium-"))
        .sort()
        .reverse();
      for (const version of versions) {
        const versionRoot = path.join(cacheRoot, version);
        for (const platform of fs.readdirSync(versionRoot).filter((entry) => entry.startsWith("chrome-linux"))) {
          const candidate = path.join(versionRoot, platform, "chrome");
          if (isExecutable(candidate)) return candidate;
        }
      }
    } catch {
      // The cache is optional.
    }
  }

  return null;
}

function loadPlaywright() {
  const candidates = [
    "playwright",
    process.env.PLAYWRIGHT_MODULE,
    "/home/coding/spaxel/dashboard/node_modules/playwright",
  ].filter(Boolean);
  let lastError;
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function startLocalServer() {
  const publicRoot = path.resolve(__dirname, "../public");
  const contentTypes = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
  };
  const server = http.createServer((request, response) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url || "/", "http://localhost").pathname);
    } catch {
      response.writeHead(400);
      response.end("bad request");
      return;
    }
    if (pathname === "/") pathname = "/index.html";
    const file = path.resolve(publicRoot, `.${pathname}`);
    if (file !== publicRoot && !file.startsWith(`${publicRoot}${path.sep}`)) {
      response.writeHead(403);
      response.end("forbidden");
      return;
    }
    fs.stat(file, (statError, stat) => {
      if (statError || !stat.isFile()) {
        response.writeHead(404);
        response.end("not found");
        return;
      }
      response.writeHead(200, { "content-type": contentTypes[path.extname(file)] || "application/octet-stream" });
      fs.createReadStream(file).pipe(response);
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

let chromium;
try {
  ({ chromium } = loadPlaywright());
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
  let server;
  let browser;
  if (useLocalServer) {
    server = await startLocalServer();
    const address = server.address();
    base = `http://127.0.0.1:${address.port}`;
  }

  try {
    const executablePath = findChromium();
    browser = await chromium.launch(executablePath ? { executablePath } : {});

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

    if (failures) {
      console.error(`\nFAIL: ${failures} check(s) failed`);
      process.exitCode = 1;
    } else {
      console.log("\nOK: toolbar mounts in feedback mode; normal visitors fetch nothing extra");
    }
  } finally {
    if (browser) await browser.close();
    if (server) await closeServer(server);
  }
})().catch((e) => {
  console.error("verification run failed:", e);
  process.exit(2);
});
