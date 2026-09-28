# `/api/gbc/token` — API contract

Bead `conedrat-f869d41f` · 2026-09-28

This is the request/response specification for the one server touchpoint in the
Green Button Connect flow: the OAuth authorization-code → access-token exchange
([`functions/api/gbc/token.js`](../../functions/api/gbc/token.js)). The *why*
(client secret can't live in a browser) and the data-handling boundary are in
[`gbc-data-boundary.md`](gbc-data-boundary.md); this page is the *what* — the
exact contract, stated tightly enough that a client could be written against it
— and every rule here has a named assertion in `test/gbc-sandbox.js` (matrix at
the end).

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

`exchangeToken()` POSTs `{code, redirectUri}` with `Accept: application/json`,
then treats **any** of these as failure: non-2xx status, unparseable body, or a
parsed body without `access_token` — in every case surfacing the body's
`error_description` / `error` when present, else a generic "HTTP <status>"
message. On success it builds the in-tab connection
`{accessToken, tokenType, scope, expiresIn, obtainedAt, expiresAt}` (defaults:
`Bearer`, 3600 s) and best-effort-saves it to `sessionStorage` under
`gbc-connection` — the only place the access token ever exists.

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

| Contract rule | Sandbox assertion (section 8) |
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
