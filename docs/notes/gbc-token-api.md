# Green Button Connect client + `/api/gbc/token` contract

Bead `conedrat-f869d41f` · client-contract extension `conedrat-c6392ee6` · 2026-09-28

This is the complete browser-facing contract for Green Button Connect (Share My
Data), including the one server touchpoint: the OAuth authorization-code →
access-token exchange ([`functions/api/gbc/token.js`](../../functions/api/gbc/token.js)).
The *why* (the client secret cannot live in a browser) and the data-handling
boundary are in [`gbc-data-boundary.md`](gbc-data-boundary.md); this page is the
*what*, stated tightly enough that another client could be written against it.
Each behavior below has a named `GBC-AC-*` acceptance assertion in
`test/gbc-sandbox.js`.

## Endpoint

`POST /api/gbc/token` — a Cloudflare Pages Function. Only POST is handled
(`onRequestPost`); any other method never reaches the function and gets the
platform's stock response. The path is fixed; the client finds it through
`public/gbc-config.json`'s `tokenExchangePath` so a deployment could move it
without touching `gbc.js`.

## Request

Headers:

| Header | Rule |
|---|---|
| `content-type` | `application/json` — the body is read with `request.json()`. A body that isn't parseable JSON is a `400` (below). |
| `origin` | **Same-origin rule.** If present and different from the request URL's origin (scheme + host + port) → `403 origin_not_allowed`, decided *before* the body is read and before any outbound call. If absent, the request proceeds. Browsers attach `Origin` to every cross-origin request and to same-origin POSTs, so the enforcement case is exactly "another site made this visitor's browser relay an exchange here". An absent header (curl, server-to-server) is not authenticated access — the only thing it can carry is an authorization code, which is single-use and bound to its `redirect_uri` by the authorization server, so the header is relay-hardening, not the security boundary. |

Body — JSON with exactly two fields, both required non-empty strings:

```json
{ "code": "…one-time authorization code from the ConEd redirect…",
  "redirectUri": "…the redirect_uri the authorization request used…" }
```

**`code`** — the one-time authorization code ConEd appended to the redirect.
Lives minutes at most and is burned by its first exchange.

**`redirectUri`** — must be byte-identical to the `redirect_uri` this same code
was issued against (RFC 6749 §4.1.3: the token request repeats it and the
authorization server rejects any difference with `invalid_grant`). The client
(`public/gbc.js` `buildRedirectUri`) always sends the registered site origin —
`<origin>/`, trailing slash included; register exactly that string with ConEd
(see the boundary doc's enabling checklist). **The function deliberately does
not validate `redirectUri` against its own allowlist**: the single source of
truth for registered redirect URIs is ConEd's app registration, and the
authorization server already enforces the code↔redirect_uri binding. Duplicating
the list here could only create drift between two copies that must never
disagree. What the function does with it is echo it, verbatim, into the
upstream token request.

Nothing else in the body is read; extra fields are ignored.

## Environment bindings

Set out-of-band (Pages env, provisioned from OpenBao at deploy) — never in the
repo, never in `wrangler.toml`:

| Binding | Required | Meaning |
|---|---|---|
| `GBC_CLIENT_ID` | yes | The registered third-party client id |
| `GBC_CLIENT_SECRET` | yes | The registered client secret |
| `GBC_TOKEN_URL` | yes | Con Edison's OAuth token endpoint URL, exactly as issued at onboarding. The function makes **no** endpoint-shape assumptions beyond "POST form-encoded, JSON back": no path guessing, no hostname fallback. Whatever URL onboarding issues is the only place it will speak to. |
| `GBC_TOKEN_AUTH` | no | `"basic"` (default) or `"body"` — which RFC 6749 §2.3.1 client-auth style ConEd's server wants. Flip it if onboarding's server rejects Basic. |

Any of the three required bindings missing or empty → `503 gbc_not_configured`
(up-front, before reading the body). That is the deployment's "enabled" switch
failing safe: an unconfigured deployment refuses every exchange rather than
pretending to.

## Upstream request (function → Con Edison)

Exactly **one** outbound HTTP call, to `GBC_TOKEN_URL` and nowhere else:

```
POST {GBC_TOKEN_URL}
content-type: application/x-www-form-urlencoded
accept: application/json
grant_type=authorization_code&code={code}&redirect_uri={redirectUri}
```

plus, per auth style:

- **`basic`** (default) — `authorization: Basic base64(client_id:client_secret)`;
  the form carries no client credentials.
- **`body`** — `client_id` and `client_secret` ride the form; no
  `authorization` header.

No explicit timeout is set; the exchange is bounded by the Workers request
lifetime. If the call throws (DNS, refused, TLS), the function answers
`502 upstream_unreachable` — it does not retry. One code, one attempt: a retry
could re-submit a code that was in fact accepted, and a burned code is
unrecoverable.

## Responses

Every response this function produces — its own errors included — carries
`content-type: application/json` and **`cache-control: no-store`** (RFC 6749
§5.1 requires no-store on token responses; applying it to the errors too costs
nothing and closes the "proxied error body" corner).

**Success** — the upstream body is passed through **verbatim, status included**.
ConEd's success body is the standard OAuth token response:

```json
{ "access_token": "…", "token_type": "Bearer", "expires_in": 3600, "scope": "…" }
```

The function validates a 2xx body only enough to know it succeeded — it must
parse as JSON and contain `access_token` — and otherwise does not interpret it.
Field-agnostic on purpose: if ConEd adds or renames metadata fields, nothing
here breaks. The client-side defaults (`token_type` → `Bearer`,
`expires_in` → 3600) live in `gbc.js`, the single place that knows what the
fields mean.

**Errors** — `{"error": "<code>", "error_description": "<human text>"}`:

| Status | `error` | When | Decided |
|---|---|---|---|
| 403 | `origin_not_allowed` | `Origin` header present and foreign | before body read; no outbound call |
| 503 | `gbc_not_configured` | any required env binding missing/empty | before body read |
| 400 | `invalid_request` ("body must be JSON") | body isn't parseable JSON | — |
| 400 | `invalid_request` ("code and redirectUri are required") | `code` or `redirectUri` missing, empty, or not a string | — |
| 502 | `upstream_unreachable` | the fetch to ConEd threw | no retry |
| 502 | `upstream_malformed` ("token response was not JSON") | 2xx upstream body isn't JSON | — |
| 502 | `upstream_malformed` ("token response had no access_token") | 2xx upstream JSON lacks `access_token` | — |
| *passthrough* | *(upstream's)* | upstream answered 4xx/5xx — e.g. `400 invalid_grant` (unknown/used/expired code or redirect_uri mismatch), `401 invalid_client` | status + body verbatim |

Checks run in source order: origin → configuration → JSON parse → required
fields → upstream. So a foreign origin wins over "not configured", and a bad
body never reaches ConEd.

**Why pass upstream errors through verbatim?** They're shaped for the browser
anyway (the client surfaces `error_description` directly), and the bodies cannot
contain the client secret — the secret travels only in the request's auth
material, which no conformant authorization server echoes back. Rewriting them
would add a translation layer with exactly one behavior change available to it:
losing information.

## Client side (what `public/gbc.js` expects)

The browser owns authorization, token lifetime, feed retrieval, and parsing.
It never knows or sends `GBC_CLIENT_SECRET`.

### Public configuration

`public/gbc-config.json` contains only public deployment values:

| Field | Contract |
|---|---|
| `configured` | `false` hides/disables the connect panel. `true` requires non-empty `clientId`, `authorizeUrl`, `apiBase`, `redirectUri`, and at least one scope. Production `redirectUri` is `"https://coned.jedarden.com/"`; the browser enforces that it remains the exact deployed site root. |
| `clientId` | The ConEd-registered third-party client id. |
| `authorizeUrl` | The OAuth authorization endpoint issued at onboarding. |
| `apiBase` | The Data Custodian API origin/base URL. |
| `scopes` | An ordered array of provider scope strings; sent space-separated. |
| `tokenExchangePath` | Optional; defaults to `/api/gbc/token`. |
| `subscriptionListPath`, `usagePointsPath`, `intervalFeedPath`, `billingFeedPath` | Optional ESPI path templates; defaults are listed below. |

A missing, 404, or invalid public config degrades to `configured:false`. A
config that explicitly says `configured:true` but omits a required public field
is rejected. The client secret and token URL are never public config.

### Authorization URL, scopes, and redirect

The connect button generates `state = randomState()` (128 bits represented as
32 lowercase hexadecimal characters), saves it in `sessionStorage` as
`gbc-state`, and navigates the browser to `authorizeUrl(cfg, state, redirectUri)`.
`buildRedirectUri(location, registeredUri)` returns the configured registered
URI when it matches exactly `location.origin + "/"`; without a configured URI it
derives that same site-root value. A query, hash, alternate path, or different
origin is rejected before authorization. The trailing slash is part of the
registered value and must match ConEd's app registration byte-for-byte.

The authorization URL is a provider URL with these query parameters:

```text
response_type=code
client_id=<cfg.clientId>
redirect_uri=<registered origin + />
scope=<cfg.scopes joined with one ASCII space>
state=<fresh randomState()>
```

The scope array is not inferred, broadened, or silently rewritten. The
authorization page is a browser link-out; the application never collects a
ConEd password.

On return, the page consumes `code`, `state`, or OAuth `error` query values.
`parseCallback()` accepts a code only when the returned state equals the saved
state. A missing code or mismatched state is rejected locally and never reaches
the token endpoint. `error` and `error_description` are surfaced as an OAuth
failure and also never reach the token endpoint. A matching code is one-time
and is exchanged once with the exact same redirect URI.

Acceptance: `GBC-AC-AUTHORIZATION-URL`, `GBC-AC-SCOPES`, and
`GBC-AC-REDIRECT-HANDLING`.


### Token exchange and expiry

`exchangeToken()` sends the exact JSON body `{code, redirectUri}` to
`tokenExchangePath`, with `Content-Type: application/json` and
`Accept: application/json`. It treats a non-2xx response, a non-JSON response,
or a JSON response without `access_token` as a failure; it prefers
`error_description`, then `error`, then a generic HTTP-status message.

For a valid response it normalizes the OAuth fields into the in-tab connection
shape:

```js
{ accessToken, tokenType, scope, expiresIn, obtainedAt, expiresAt }
```

`tokenType` defaults to `Bearer`, `scope` to the empty string, and
`expiresIn` to 3600 seconds when omitted. `expiresAt` is computed from the
exchange time and `expiresIn`; `connectionIsFresh(conn)` requires a token and
requires `expiresAt > now + 30 seconds`. A token at or inside that safety
margin is stale. The connection is best-effort saved only in the current
tab's `sessionStorage` key `gbc-connection`; a stale saved connection is
cleared before any Data Custodian request. There is no refresh-token flow: the
user reconnects when the grant is stale or revoked.

Acceptance: `GBC-AC-TOKEN-EXPIRY`.

### Direct ESPI requests and feed discovery

After exchange, all Data Custodian calls are browser-direct `GET` requests to
`apiBase` with `Authorization: Bearer <accessToken>` and an XML/Atom `Accept`
header. Interval and billing payloads never go through `/api/gbc/token` or any
other application-server endpoint.

The default ESPI 1.1 paths are:

| Request | Default path |
|---|---|
| Subscription discovery | `/espi/1_1/resource/Subscription` |
| Usage-point discovery | `/espi/1_1/resource/Subscription/{subscription}/UsagePoint` |
| Interval feed | `/espi/1_1/resource/Batch/UsagePoint/{usagePoint}` |
| Billing feed | `/espi/1_1/resource/UsagePoint/{usagePoint}/UsageSummary` |

The path templates may be overridden by public config because ConEd publishes
the exact Data Custodian paths at onboarding. The discovery walk is:

1. GET the subscription collection; take the first entry's `<id>` and use its
   final URI segment as `subscriptionId` (the collection's own `<feed><id>`
   is not an entry).
2. GET the usage-point collection for that subscription; take the first
   entry's final URI segment as `usagePointId`.
3. GET the interval and billing endpoints for that usage point in parallel.

An empty subscription or usage-point collection is an actionable client error.
A `401` from any feed becomes "authorization expired — reconnect your account";
other non-2xx feed responses become an HTTP-status data-request error.

Acceptance: `GBC-AC-FEED-DISCOVERY` and `GBC-AC-DIRECT-ESPI`.

### Pagination

Every collection or data feed may be paginated with an Atom `<link
rel="next" href="…">`. `refreshFeeds()` follows `rel="next"` for all four
requests (subscription, usage point, interval, and billing), resolving relative
links against the page that supplied them and accepting absolute links. It
merges the page bodies into one logical Atom feed before entry discovery or
parsing, so an id or interval/bill on a later page is not lost. XML entities in
the `href` are decoded first.

Pagination is browser-direct and carries the same bearer header on every page.
The client rejects a repeated URL as a pagination loop and rejects a walk over
100 pages. A feed without a next link ends the walk. `apiGet()` is the one-page
primitive; `apiGetPages()` is the paginated primitive used by `refreshFeeds()`.

Acceptance: `GBC-AC-PAGINATION` and `GBC-AC-PAGINATION-GUARD`.

### Normalization into the calculation core

The client does not calculate rates or transform usage into a second schema.
After the interval pages are merged, their XML is passed unchanged to
`parseESPI()`, which returns the calculation shape:

```js
{ months, hours, ndays, intervals, minDate, maxDate }
```

`months` contains normalized monthly totals/peak/off-peak buckets and observed
day counts; `hours` contains hourly `kwh` records with local Eastern time
fields. The connected interval result therefore follows the same analysis path
as an uploaded ESPI file.

The merged billing XML is passed unchanged to `parseBillingESPI()`, which
returns `{ bills, incomplete }`. A bill carries normalized start/end epochs,
`ymdStart`, `ymdEnd`, day count, USD `cost` (the ESPI minor-unit `<cost><value>`
divided by 100), currency, and a display label. An entry without a usable
period/total or with a non-USD currency is retained in `incomplete` with a
reason; it is not silently treated as a valid bill.

`refreshFeeds()` returns `{ parsed, intervalXml, billingXml, billingEntries,
bills, billingIncomplete, billingError, subscriptionId, usagePointId }`. A
billing parse failure degrades only the bill evidence (`bills=[]` plus
`billingError`); an interval parse failure rejects the refresh because there is
no usable usage profile.

Acceptance: `GBC-AC-NORMALIZE-INTERVAL` and `GBC-AC-NORMALIZE-BILLING`.

### Upstream errors seen by the browser

The token function's local errors and ConEd's OAuth errors are JSON. The client
surfaces the provider's `error_description`/`error` without attempting a retry.
A refused or malformed upstream response is a failed exchange; a used, expired,
or redirect-mismatched code remains a provider `invalid_grant` and must be
resolved by starting authorization again. Feed `401` and token expiry likewise
require reconnection; there is no client-side token refresh.

Acceptance: `GBC-AC-UPSTREAM-ERRORS`.

## What the endpoint never does

- **No logging** — no `console.*`, no analytics, no error reporting in this
  function. (Platform note, from the boundary doc: Cloudflare's edge records
  request *metadata* — path, status, timing — for any worker; bodies do not
  appear there.)
- **No persistence** — no storage bindings (no KV, no D1, no R2), no module
  state, nothing retained between requests. The function reads only its four
  env bindings, and each request is answered entirely from that request.
- **No scope creep on the outbound side** — one fetch, one URL, form-encoded,
  no retries.

## Verification matrix

Every rule above is asserted in `test/gbc-sandbox.js`, which invokes the real
Pages Function module with real `Request` objects and a recording mock
authorization server:

| Contract behavior | Named acceptance test |
|---|---|
| Browser authorization URL and registered redirect | `GBC-AC-AUTHORIZATION-URL` |
| Space-joined scopes | `GBC-AC-SCOPES` |
| Callback code/state/error handling | `GBC-AC-REDIRECT-HANDLING` |
| OAuth token expiry and 30-second freshness margin | `GBC-AC-TOKEN-EXPIRY` |
| Subscription → UsagePoint discovery | `GBC-AC-FEED-DISCOVERY` |
| Direct interval and billing ESPI GETs | `GBC-AC-DIRECT-ESPI` |
| Relative `rel=next` pagination and merged feeds | `GBC-AC-PAGINATION` |
| Pagination loop guard | `GBC-AC-PAGINATION-GUARD` |
| `parseESPI` interval normalization | `GBC-AC-NORMALIZE-INTERVAL` |
| `parseBillingESPI` bill normalization | `GBC-AC-NORMALIZE-BILLING` |
| Upstream unreachable/malformed/passthrough errors | `GBC-AC-UPSTREAM-ERRORS` |

| Token endpoint behavior | Sandbox assertion |
|---|---|
| Valid exchange end-to-end | fresh single-use code → 200, body carries `access_token`/`token_type`/`expires_in`, `no-store` + JSON headers on the response |
| 400 bad JSON body | non-JSON body → 400 `invalid_request` |
| 400 missing fields | missing `code`; missing `redirectUri` → 400 `invalid_request` |
| 403 same-origin rule | foreign `Origin` → 403 `origin_not_allowed`, and zero upstream calls |
| 503 not configured | empty env → 503 `gbc_not_configured` |
| 502 upstream unreachable | `GBC_TOKEN_URL` on a refused port → 502 `upstream_unreachable` |
| 502 upstream malformed | 2xx non-JSON and 2xx-without-`access_token` upstream bodies → 502 `upstream_malformed` |
| Passthrough | bogus code → upstream's 400 `invalid_grant` body byte-identical, status 400 |
| Upstream shape, basic auth | recorded upstream POST: `grant_type`/`code`/`redirect_uri` form fields, `authorization: Basic …`, no credentials in the form |
| Upstream shape, body auth | `GBC_TOKEN_AUTH=body`: credentials in the form, no `authorization` header |
| One outbound call | upstream POST count unchanged across a refused/malformed exchange |
| No logging | `console.*` silenced around direct invocations — zero calls |
| No persistence | instrumented env: only `GBC_*` keys ever read; decoy KV/D1/R2 bindings never touched; env object never written; module exports nothing but `onRequestPost` |

Cross-cutting boundary enforcement (exchange bodies are exactly
`{code, redirectUri}`, no usage bytes or tokens ever appear in any request
body, Data Custodian traffic is direct browser GETs) is the harness-wide
section 9, documented in the boundary doc.
