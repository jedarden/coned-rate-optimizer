# Green Button Connect — data-handling boundary

Bead `conedrat-1d3bea35` · 2026-09-27

The site's privacy promise has always been **"100% client-side: your data never
leaves your device."** Green Button Connect / Share My Data (GBC) introduces
authorization, a server touchpoint, and a utility API — which sounds like it
breaks that promise. This document is the resolution, stated precisely:
**all computation stays in the browser, and nothing derived from your usage
data is ever stored or logged anywhere.** One byte-transit step (the OAuth
token exchange) runs server-side because it must; it is the narrowest possible
hole, and this page documents exactly what passes through it.

## The flow in one paragraph

You click **Connect with ConEd** → the page redirects you to Con Edison's
authorization screen (you sign in *there*, with *them* — this tool never sees
your password) → you approve sharing your electric usage → ConEd redirects
back to this site with a one-time authorization `code` in the URL → the page
swaps that code for a bearer **access token** via our `/api/gbc/token`
endpoint (the one server step, because the app's client secret cannot live in
a browser) → the browser then calls ConEd's ESPI REST endpoints **directly**
with that token, pulls your interval (and billing) Atom feeds into the page,
and `calc.js`'s `parseESPI()` + `analyze()` price them — the *same functions,
in the same browser process*, that price an uploaded file. Nothing about the
analysis path differs from the file-upload path.

## What each component sees, processes, and retains

| Component | Sees | Processes | Retains | Logs |
|---|---|---|---|---|
| **Your browser** | Everything: the ConEd login page, the access token, your interval + billing feeds | 100% of the analysis (parsing, pricing, eligibility, bill-replay verification of the billing summaries) — in-tab, in-memory | The access token in `sessionStorage` (`gbc-connection`), which **dies with the tab**. The CSRF `state` value likewise. Nothing else, anywhere. | nothing |
| **`/api/gbc/token` Pages Function** (`functions/api/gbc/token.js`) | Your one-time `code` + `redirect_uri` from the request body; the client secret from its env binding | One outbound OAuth token exchange to ConEd; returns the token response to your tab verbatim | **Nothing.** The function has no storage binding (no KV, no D1, no R2), keeps no in-memory session state across requests, and writes nothing anywhere | **Nothing application-side** — no `console.log`, no analytics, no error reporting in this function. (Platform note: like any Cloudflare worker, standard request *metadata* — path, status, timing, IP-class — exists in Cloudflare's edge records; request/response **bodies do not**.) |
| **Con Edison** (authorization server + Data Custodian) | Your ConEd login (directly from you), the app's identity, the scopes you approved, and bearer requests for your feeds, which come **from your browser** | Issues the authorization and serves the ESPI feeds | Whatever ConEd's own third-party agreement and retention policy say — visible to you in your ConEd account's Share My Data settings | Per ConEd's policy; you can see and revoke the app's access there at any time |
| **This site's operators** | The Cloudflare dashboard's standard request metadata only | — | **No tokens, no usage data, no codes.** The access token exists only in your tab; the client secret exists only in the Pages env binding (provisioned out-of-band from OpenBao, never in the repo) | — |

### Why the token exchange is server-side (and why that's not a loophole)

OAuth confidential clients must authenticate with a **client secret**, and a
secret shipped to a browser is public. So the browser hands its one-time,
minutes-lived authorization `code` to `/api/gbc/token`, which adds the secret
and performs the exchange. The function is hard-scoped: same-origin requests
only (cross-origin → `403`), it speaks only to ConEd's token endpoint, it
retains nothing, and it returns the token **to the same tab that started the
authorization**. No usage data ever touches it — ConEd's feeds flow from ConEd
straight to your browser. A passive observer of this endpoint learns, at most,
"someone connected" — never any usage data, and never a reusable credential
(codes are single-use; the token goes only to your own tab over TLS).

This is asserted, not just stated: the sandbox harness (`test/gbc-sandbox.js`,
section 9) records **every request** its stand-in server receives across the
whole run and fails if any POST goes anywhere but the exchange and its upstream
call, if an exchange body is anything but `{code, redirectUri}`, if the access
token appears in any request body, or if any interval/billing payload bytes
(`IntervalReading`, `IntervalBlock`, `UsageSummary`, `powerOfTenMultiplier`)
ever arrive inside one. Feed payloads exist only in the responses the Data
Custodian sends, never in anything received — and every Data Custodian request
must be a direct GET, i.e. browser-to-ConEd with no application-server relay.
The exchange endpoint's full request/response/error contract — including these
no-logging and no-retention rules, each with its own named sandbox assertion
(section 8) — is specified in [`gbc-token-api.md`](gbc-token-api.md).

### One deployment dependency the E2E caught: Data Custodian CORS

Because the browser pulls the ESPI feeds **directly from ConEd** (no relay),
ConEd's Data Custodian must send CORS headers (`Access-Control-Allow-Origin`
plus `Authorization` in `Access-Control-Allow-Headers`) for this site's
origin — the `Authorization: Bearer` header makes every feed GET preflighted.
This is part of serving browser-based third-party clients (the sandbox
simulates it; `tools/verify-gbc-browser.js` failed exactly there until the
mock sent the headers). If ConEd's production Data Custodian turns out not to
support browser CORS, the fallback would be a same-origin ESPI relay — a
boundary change to be documented here before any such code exists, not after.

### What we deliberately did NOT build

- **No storage of usage data** — not in a database, not in a cache, not in
  logs. Refreshing the page re-pulls the feeds from ConEd with your still-live
  token; closing the tab drops the token entirely.
- **No account, no monitoring** — product-strategy's Phase 2 "persistent
  month-over-month monitoring" requires server-side token retention and stored
  usage history. That is a *different product with a different consent
  surface*, and it is explicitly out of scope here. This implementation is
  pull-on-demand, per-tab, ephemeral.
- **No password handling** — the ConEd login happens on ConEd's page. This
  tool never collects, proxies, or sees your utility password, satisfying the
  product-strategy constraint ("Never collect or proxy the customer's Con
  Edison password").
- **No refresh-token flow** — only the short-lived access token is kept, in
  `sessionStorage`. When it expires the page asks you to reconnect; it never
  silently re-authorizes in the background.

## Scopes requested

Config-driven (`public/gbc-config.json` → `scopes`), because ConEd publishes
its exact scope strings to registered third parties at onboarding. The intent
is the minimum read set: **interval usage + billing summaries for the
authorized account, read-only.** No customer-identifying scopes beyond what
ESPI requires, nothing write-shaped. Review this list against the actual
onboarding grant before enabling — the config file is where that review lands.

## Status: shipped, gated on onboarding

Everything client-side and worker-side is implemented and verified against a
local sandbox Third-Party App (see below). What is **not** possible from here
is the ConEd side: their [Third-Party App
registration](https://www.coned.com/en/accounts-billing/share-energy-usage-data/become-a-third-party)
(an application, a data security agreement, and their issuance of a client
id/secret and real endpoint URLs) is an offline business process. Until it
completes, the site ships `public/gbc-config.json` with `configured: false`
and the connect panel never renders — the page behaves exactly as before.

### Enabling (once onboarding completes)

1. Fill `public/gbc-config.json`: `configured: true`, `clientId`,
   `authorizeUrl` (ConEd's authorization endpoint), `apiBase` (their Data
   Custodian REST base), `scopes` (the granted scope strings). If their REST
   paths deviate from the ESPI 1.1 defaults in `public/gbc.js`
   (`DEFAULT_PATHS`), override the path templates here too.
2. Set the Pages Function env bindings `GBC_CLIENT_ID`, `GBC_CLIENT_SECRET`,
   `GBC_TOKEN_URL` (optionally `GBC_TOKEN_AUTH=basic|body`) out-of-band —
   never in this repo. Register the redirect URI **`<site origin>/`** with
   ConEd.
3. Re-run the sandbox harness (`node test/gbc-sandbox.js`) against a config
   copied from the real endpoints, then the browser E2E
   (`tools/verify-gbc-browser.js`).

## Verification against a sandbox Third-Party App

ConEd's real sandbox is registration-gated, so the verification stands up the
**standard GBCMD shapes locally** and drives the *real* code through them:

- `test/gbc-sandbox.js` — a local OAuth 2.0 authorization server (authorize +
  token endpoints, single-use codes, HTTP Basic client auth, state
  round-trip, redirect_uri binding, code-reuse rejection) and an ESPI Data
  Custodian (Subscription → UsagePoint → interval Batch feed + billing
  UsageSummary feed, bearer-gated). The interval feed serves the same
  `test/fixtures/sample-greenbutton.xml` the file-upload tests use, and the
  harness asserts the connected path's analysis is **byte-identical** to
  parsing that file directly. The `/api/gbc/token` route delegates to the
  actual Pages Function module, so the worker's guard rails (missing env →
  503, bad body → 400, cross-origin → 403, upstream error passthrough) are
  exercised as shipped.
- `tools/verify-gbc-browser.js` — the same sandbox plus a static server, then
  a real Chromium run: click Connect → authorize on the mock → redirect back →
  feeds pulled → verdict rendered → token present in `sessionStorage` →
  Disconnect clears it.
- `test/test.js` Test 17 — the pure core's unit behavior (config degrade,
  authorize-URL shape, CSRF/state validation, connection store, feed-walk
  helpers).

Honest limits: these prove the flow against the standard's shapes, not against
ConEd's production endpoints — the endpoint URLs and scope strings in the
sandbox are placeholders by necessity. The config-driven design means pointing
the whole stack at the real sandbox after onboarding is a `gbc-config.json` +
env-binding change, no code change.
