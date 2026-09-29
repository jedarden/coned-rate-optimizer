/* Green Button Connect (Share My Data) client core — authorization link-out,
   callback validation, token exchange, and ESPI feed retrieval.
   Pure logic, no DOM: runs in the browser (window.ConedGbc) and under Node
   (module.exports) for the automated tests and the sandbox Third-Party App
   authorization harness (test/gbc-sandbox.js). All *analysis* stays in
   calc.js, in the browser — this module only moves bytes.
   Data-handling boundary: docs/notes/gbc-data-boundary.md. */
(function () {
  "use strict";

  var Calc = typeof window !== "undefined" && window.ConedCalc
    ? window.ConedCalc
    : (typeof require === "function" ? require("./calc.js") : null);

  var TOKEN_KEY = "gbc-connection";
  var STATE_KEY = "gbc-state";

  // ESPI 1.1 standard resource shapes. ConEd's Data Custodian may deviate —
  // its exact REST paths are published to registered third parties at
  // onboarding — so every path is overridable from public/gbc-config.json.
  var DEFAULT_PATHS = {
    tokenExchangePath: "/api/gbc/token",
    subscriptionListPath: "/espi/1_1/resource/Subscription",
    usagePointsPath: "/espi/1_1/resource/Subscription/{subscription}/UsagePoint",
    intervalFeedPath: "/espi/1_1/resource/Batch/UsagePoint/{usagePoint}",
    billingFeedPath: "/espi/1_1/resource/UsagePoint/{usagePoint}/UsageSummary"
  };

  function validateConfig(obj) {
    if (!obj || typeof obj !== "object") throw new Error("gbc-config.json is missing or is not an object");
    var cfg = {};
    for (var k in DEFAULT_PATHS) cfg[k] = obj[k] || DEFAULT_PATHS[k];
    cfg.providerName = obj.providerName || "Con Edison";
    cfg.clientId = obj.clientId || "";
    cfg.authorizeUrl = obj.authorizeUrl || "";
    cfg.apiBase = obj.apiBase || "";
    cfg.redirectUri = obj.redirectUri || "";
    cfg.scopes = Array.isArray(obj.scopes) ? obj.scopes.slice() : [];
    cfg.configured = obj.configured === true && !!cfg.clientId && !!cfg.authorizeUrl && !!cfg.apiBase &&
      !!cfg.redirectUri && cfg.scopes.length > 0;
    if (obj.configured === true && !cfg.configured) {
      throw new Error("gbc-config.json says configured:true but is missing clientId, authorizeUrl, apiBase, redirectUri, or scopes");
    }
    return cfg;
  }

  // Loads the deployment's public config. Missing/404/unparseable degrades to
  // the unconfigured default — the panel simply never appears.
  function loadConfig(fetchImpl) {
    var f = fetchImpl || (typeof fetch === "function" ? fetch : null);
    if (!f) return Promise.resolve(validateConfig({}));
    return f("gbc-config.json", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : {}; })
      .catch(function () { return {}; })
      .then(validateConfig);
  }

  function isConfigured(cfg) { return !!(cfg && cfg.configured); }

  function randomState() {
    var bytes = new Uint8Array(16);
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
      crypto.getRandomValues(bytes);
    } else {
      for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    var hex = "";
    for (var j = 0; j < bytes.length; j++) hex += (bytes[j] < 16 ? "0" : "") + bytes[j].toString(16);
    return hex;
  }

  // ConEd third-party apps register one exact redirect URI at onboarding;
  // this tool registers the site root.
  function buildRedirectUri(locationLike, registeredUri) {
    var origin = locationLike && locationLike.origin ? locationLike.origin : "";
    var derived = origin + "/";
    if (!registeredUri) return derived;
    var configured;
    try { configured = new URL(registeredUri); }
    catch (e) { throw new Error("the registered GBC redirect URI is invalid"); }
    if (configured.origin !== origin || configured.pathname !== "/" || configured.search || configured.hash) {
      throw new Error("the registered GBC redirect URI does not match this site root");
    }
    return configured.toString();
  }

  function authorizeUrl(cfg, state, redirectUri) {
    if (!isConfigured(cfg)) throw new Error("Green Button Connect isn't configured for this deployment yet.");
    if (!state) throw new Error("a CSRF state token is required");
    if (!redirectUri) throw new Error("a redirect URI is required");
    var p = new URLSearchParams();
    p.set("response_type", "code");
    p.set("client_id", cfg.clientId);
    p.set("redirect_uri", redirectUri);
    p.set("scope", cfg.scopes.join(" "));
    p.set("state", state);
    return cfg.authorizeUrl + (cfg.authorizeUrl.indexOf("?") >= 0 ? "&" : "?") + p.toString();
  }

  // Validates the ?code=&state= (or ?error=) callback against the state we
  // stored before the link-out (CSRF guard). Returns {ok:true, code} or
  // {ok:false, error, errorDescription}.
  function parseCallback(query, expectedState) {
    var params = query;
    if (typeof query === "string") params = new URLSearchParams(query.replace(/^\?/, ""));
    else if (query && typeof query.get !== "function") {
      params = new URLSearchParams();
      Object.keys(query).forEach(function (k) { if (query[k] != null) params.set(k, String(query[k])); });
    }
    var err = params.get("error");
    if (err) return { ok: false, error: err, errorDescription: params.get("error_description") || "" };
    var code = params.get("code"), state = params.get("state");
    if (!code) return { ok: false, error: "missing_code", errorDescription: "no authorization code in the callback" };
    if (!expectedState || state !== expectedState) {
      return { ok: false, error: "state_mismatch", errorDescription: "the state returned by ConEd doesn't match the one this page sent — refusing to connect." };
    }
    return { ok: true, code: code, state: state };
  }

  var OAUTH_ERRORS = {
    access_denied: "You declined the ConEd authorization — nothing was connected.",
    invalid_client: "ConEd rejected this application's credentials.",
    invalid_scope: "ConEd rejected the requested data scopes.",
    unsupported_response_type: "ConEd rejected this application's authorization request shape.",
    invalid_request: "ConEd called the authorization request malformed.",
    server_error: "ConEd's authorization service reported an error — try again later.",
    temporarily_unavailable: "ConEd's authorization service is temporarily unavailable — try again later."
  };
  function friendlyError(cb) {
    if (!cb) return "ConEd authorization failed.";
    if (cb.error === "state_mismatch") return "That authorization reply wasn't requested by this page (state mismatch) — nothing was connected. Please start again.";
    return OAUTH_ERRORS[cb.error] || "ConEd authorization failed (" + cb.error + ").";
  }

  // ---- token exchange (through the same-origin Pages Function) -------------

  function exchangeToken(exchangeUrl, code, redirectUri, fetchImpl) {
    var f = fetchImpl || (typeof fetch === "function" ? fetch : null);
    if (!f) return Promise.reject(new Error("fetch is not available"));
    return f(exchangeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ code: code, redirectUri: redirectUri })
    }).then(function (r) {
      return r.text().then(function (t) {
        var j = null;
        try { j = t ? JSON.parse(t) : null; } catch (e) { /* non-JSON body */ }
        if (!r.ok || !j || !j.access_token) {
          var detail = j && (j.error_description || j.error);
          throw new Error(detail || "the ConEd token exchange failed (HTTP " + r.status + ")");
        }
        return {
          accessToken: j.access_token,
          tokenType: j.token_type || "Bearer",
          scope: j.scope || "",
          expiresIn: j.expires_in || 3600,
          obtainedAt: Date.now(),
          expiresAt: Date.now() + (j.expires_in || 3600) * 1000
        };
      });
    });
  }

  // ---- connection store: sessionStorage only, dies with the tab ------------

  function _storage() {
    try { if (typeof sessionStorage !== "undefined" && sessionStorage) return sessionStorage; } catch (e) { /* storage blocked */ }
    return null;
  }
  function saveConnection(conn, storage) {
    var s = storage || _storage();
    if (!s) throw new Error("session storage is unavailable");
    s.setItem(TOKEN_KEY, JSON.stringify(conn));
  }
  function loadConnection(storage) {
    var s = storage || _storage();
    if (!s) return null;
    try { var raw = s.getItem(TOKEN_KEY); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
  }
  function clearConnection(storage) {
    var s = storage || _storage();
    if (!s) return;
    try { s.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ }
    try { s.removeItem(STATE_KEY); } catch (e) { /* ignore */ }
  }
  function saveState(state, storage) {
    var s = storage || _storage();
    if (!s) throw new Error("session storage is unavailable");
    s.setItem(STATE_KEY, state);
  }
  function loadState(storage) {
    var s = storage || _storage();
    return s ? s.getItem(STATE_KEY) : null;
  }

  function connectionIsFresh(conn, nowMs) {
    if (!conn || !conn.accessToken) return false;
    var now = typeof nowMs === "number" ? nowMs : Date.now();
    return typeof conn.expiresAt === "number" && conn.expiresAt > now + 30000;
  }

  // ---- ESPI REST retrieval (browser → ConEd, bearer token, no middleman) ---

  function apiGet(token, url, fetchImpl) {
    var f = fetchImpl || (typeof fetch === "function" ? fetch : null);
    if (!f) return Promise.reject(new Error("fetch is not available"));
    return f(url, {
      headers: { "Authorization": "Bearer " + token, "Accept": "application/atom+xml, application/xml, text/xml, */*" }
    }).then(function (r) {
      if (r.status === 401) throw new Error("your ConEd authorization has expired — reconnect your account.");
      if (!r.ok) throw new Error("the ConEd data request failed (HTTP " + r.status + ")");
      return r.text();
    });
  }

  // Atom pagination is a feed concern, not an application-server concern.
  // Data Custodians may return a relative or absolute rel="next" link; keep
  // following it in the browser and present the parser one logical feed.
  function attributeValue(tag, name) {
    var re = new RegExp("\\b" + name + "\\s*=\\s*([\\\"'])([\\s\\S]*?)\\1", "i");
    var m = re.exec(tag);
    return m ? m[2] : "";
  }

  function decodeXmlEntities(value) {
    return String(value).replace(/&(?:amp|#38);/g, "&")
      .replace(/&(?:quot|#34);/g, '\"')
      .replace(/&(?:apos|#39);/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");
  }

  function extractNextLink(atomXml) {
    var tags = String(atomXml).match(/<(?:[A-Za-z_][\w.-]*:)?link\b[^>]*>/gi) || [];
    for (var i = 0; i < tags.length; i++) {
      var rel = attributeValue(tags[i], "rel").toLowerCase().split(/\s+/);
      if (rel.indexOf("next") >= 0) {
        var href = attributeValue(tags[i], "href");
        return href ? decodeXmlEntities(href) : "";
      }
    }
    return null;
  }

  function atomBody(atomXml) {
    var xml = String(atomXml);
    var open = /<(?:[A-Za-z_][\w.-]*:)?feed\b[^>]*>/i.exec(xml);
    var close = /<\/(?:[A-Za-z_][\w.-]*:)?feed\s*>\s*$/i.exec(xml);
    if (!open || !close || close.index <= open.index + open[0].length) return xml;
    return xml.slice(open.index + open[0].length, close.index);
  }

  function mergeAtomPages(pages) {
    if (pages.length < 2) return pages[0];
    var first = String(pages[0]);
    var open = /<(?:[A-Za-z_][\w.-]*:)?feed\b[^>]*>/i.exec(first);
    if (!open) return pages.join("\n");
    var prefix = first.slice(0, open.index + open[0].length);
    var close = /<\/(?:[A-Za-z_][\w.-]*:)?feed\s*>/i.exec(first);
    return prefix + pages.map(atomBody).join("\n") + (close ? close[0] : "</feed>");
  }

  function apiGetPages(token, url, fetchImpl) {
    var pages = [], seen = {}, nextUrl = String(url), pageCount = 0;
    function readPage() {
      if (seen[nextUrl]) throw new Error("ConEd feed pagination loop detected");
      if (pageCount >= 100) throw new Error("ConEd feed pagination exceeded 100 pages");
      seen[nextUrl] = true;
      pageCount++;
      var pageUrl = nextUrl;
      return apiGet(token, pageUrl, fetchImpl).then(function (xml) {
        pages.push(xml);
        var link = extractNextLink(xml);
        if (!link) return mergeAtomPages(pages);
        try { nextUrl = new URL(link, pageUrl).toString(); }
        catch (e) { throw new Error("ConEd returned an invalid feed pagination link"); }
        return readPage();
      });
    }
    return readPage();
  }

  // Entry-level <id> elements only (the feed's own <id> is outside <entry>).
  function extractEntryIds(atomXml) {
    var out = [];
    var entries = String(atomXml).match(/<(?:[A-Za-z_][\w.-]*:)?entry>[\s\S]*?<\/(?:[A-Za-z_][\w.-]*:)?entry>/g) || [];
    entries.forEach(function (e) {
      var m = /<(?:[A-Za-z_][\w.-]*:)?id>\s*([^<]+?)\s*<\//.exec(e);
      if (m) out.push(m[1]);
    });
    return out;
  }

  function resourceIdOf(uri) {
    var parts = String(uri).split("/").filter(function (p) { return p.length; });
    return parts.length ? decodeURIComponent(parts[parts.length - 1]) : "";
  }

  function expandPath(tpl, vars) {
    return tpl.replace(/\{(\w+)\}/g, function (_, k) {
      if (!(k in vars) || !vars[k]) throw new Error("ConEd feed path needs a " + k + " id, but none was discovered");
      return encodeURIComponent(vars[k]);
    });
  }

  function fetchSubscriptionId(cfg, conn, fetchImpl) {
    if (conn.subscriptionId) return Promise.resolve(conn.subscriptionId);
    var url = cfg.apiBase.replace(/\/$/, "") + cfg.subscriptionListPath;
    return apiGetPages(conn.accessToken, url, fetchImpl).then(function (xml) {
      var ids = extractEntryIds(xml);
      if (!ids.length) throw new Error("ConEd returned no usage subscription — make sure interval data is being shared for this account.");
      return resourceIdOf(ids[0]);
    });
  }
  function fetchUsagePointId(cfg, conn, subscriptionId, fetchImpl) {
    if (conn.usagePointId) return Promise.resolve(conn.usagePointId);
    var url = cfg.apiBase.replace(/\/$/, "") + expandPath(cfg.usagePointsPath, { subscription: subscriptionId });
    return apiGetPages(conn.accessToken, url, fetchImpl).then(function (xml) {
      var ids = extractEntryIds(xml);
      if (!ids.length) throw new Error("ConEd returned no usage point for this subscription.");
      return resourceIdOf(ids[0]);
    });
  }
  function fetchIntervalFeed(cfg, conn, usagePointId, fetchImpl) {
    var url = cfg.apiBase.replace(/\/$/, "") + expandPath(cfg.intervalFeedPath, { usagePoint: usagePointId });
    return apiGetPages(conn.accessToken, url, fetchImpl);
  }
  function fetchBillingFeed(cfg, conn, usagePointId, fetchImpl) {
    var url = cfg.apiBase.replace(/\/$/, "") + expandPath(cfg.billingFeedPath, { usagePoint: usagePointId });
    return apiGetPages(conn.accessToken, url, fetchImpl).then(function (xml) {
      return { xml: xml, entries: extractEntryIds(xml).length };
    });
  }

  // High-level: authorization code → connection. The sessionStorage save is
  // best-effort: with storage blocked the connection still lives in the
  // caller's variable for this session, and nothing else depends on it.
  function connect(cfg, code, redirectUri, fetchImpl) {
    if (!isConfigured(cfg)) return Promise.reject(new Error("Green Button Connect isn't configured for this deployment yet."));
    return exchangeToken(cfg.tokenExchangePath, code, redirectUri, fetchImpl).then(function (conn) {
      try { saveConnection(conn); } catch (e) { /* storage unavailable */ }
      return conn;
    });
  }

  // High-level: connection → interval + billing feeds → parsed usage.
  // The interval feed is parsed by calc.js's ESPI parser — the exact code the
  // file-upload path uses, so both paths price identical bytes identically.
  function refreshFeeds(cfg, conn, fetchImpl) {
    if (!connectionIsFresh(conn)) {
      return Promise.reject(new Error("no fresh ConEd authorization — reconnect your account."));
    }
    var live = conn;
    return fetchSubscriptionId(cfg, live, fetchImpl).then(function (subId) {
      live.subscriptionId = subId;
      return fetchUsagePointId(cfg, live, subId, fetchImpl);
    }).then(function (upId) {
      live.usagePointId = upId;
      try { saveConnection(live); } catch (e) { /* storage unavailable */ }
      return Promise.all([
        fetchIntervalFeed(cfg, live, upId, fetchImpl),
        fetchBillingFeed(cfg, live, upId, fetchImpl)
      ]);
    }).then(function (res) {
      var parsed;
      try {
        parsed = Calc.parseESPI(res[0]);
      } catch (e) {
        throw new Error("ConEd returned a feed this tool couldn't read as interval data: " + e.message);
      }
      // The billing (UsageSummary) feed becomes the actual bill records the
      // analysis reconciles against (calc.js confidence gating). A billing feed
      // that won't parse must not sink the interval analysis — it degrades to
      // no bills, and the failure is surfaced rather than swallowed.
      var bills = [], billingIncomplete = 0, billingError = null;
      try {
        var bp = Calc.parseBillingESPI(res[1].xml);
        bills = bp.bills;
        billingIncomplete = bp.incomplete.length;
      } catch (e) {
        // Name what came back when the feed has entries but none of them priced —
        // "empty account" and "unusable feed" need different words from the app.
        billingError = res[1].entries
          ? e.message + " (" + res[1].entries + " billing entries came back, none with a usable total)"
          : e.message;
      }
      return {
        parsed: parsed,
        intervalXml: res[0],
        billingXml: res[1].xml,
        billingEntries: res[1].entries,
        bills: bills,
        billingIncomplete: billingIncomplete,
        billingError: billingError,
        subscriptionId: live.subscriptionId,
        usagePointId: live.usagePointId
      };
    });
  }

  var api = {
    TOKEN_KEY: TOKEN_KEY,
    STATE_KEY: STATE_KEY,
    DEFAULT_PATHS: DEFAULT_PATHS,
    validateConfig: validateConfig,
    loadConfig: loadConfig,
    isConfigured: isConfigured,
    randomState: randomState,
    buildRedirectUri: buildRedirectUri,
    authorizeUrl: authorizeUrl,
    parseCallback: parseCallback,
    friendlyError: friendlyError,
    exchangeToken: exchangeToken,
    saveConnection: saveConnection,
    loadConnection: loadConnection,
    clearConnection: clearConnection,
    saveState: saveState,
    loadState: loadState,
    connectionIsFresh: connectionIsFresh,
    apiGet: apiGet,
    apiGetPages: apiGetPages,
    extractEntryIds: extractEntryIds,
    extractNextLink: extractNextLink,
    mergeAtomPages: mergeAtomPages,
    resourceIdOf: resourceIdOf,
    expandPath: expandPath,
    connect: connect,
    refreshFeeds: refreshFeeds
  };

  if (typeof window !== "undefined" && window) window.ConedGbc = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
