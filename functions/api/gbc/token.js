// Cloudflare Pages Function — POST /api/gbc/token
//
// The one server touchpoint in the Green Button Connect flow: the OAuth
// authorization code → access token exchange happens here because the client
// secret cannot live in the browser. It retains nothing (no KV/D1/R2, no
// storage binding) and logs nothing. The access token is returned verbatim to
// the same browser tab that started the authorization and never leaves it.
// Full boundary: docs/notes/gbc-data-boundary.md.
//
// Env bindings (set out-of-band, never in the repo):
//   GBC_CLIENT_ID      — the registered third-party client id
//   GBC_CLIENT_SECRET  — the registered client secret
//   GBC_TOKEN_URL      — ConEd's OAuth token endpoint (from onboarding)
//   GBC_TOKEN_AUTH     — optional: "basic" (default) or "body" auth style

const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" };

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

export async function onRequestPost({ request, env }) {
  // Same-origin only: a foreign site must not make a visitor's browser relay
  // a token exchange through this endpoint.
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return json(403, { error: "origin_not_allowed" });
  }

  const clientId = env && env.GBC_CLIENT_ID;
  const clientSecret = env && env.GBC_CLIENT_SECRET;
  const tokenUrl = env && env.GBC_TOKEN_URL;
  if (!clientId || !clientSecret || !tokenUrl) {
    return json(503, {
      error: "gbc_not_configured",
      error_description: "Green Button Connect is not configured for this deployment."
    });
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json(400, { error: "invalid_request", error_description: "body must be JSON" });
  }
  const code = body && typeof body.code === "string" ? body.code : "";
  const redirectUri = body && typeof body.redirectUri === "string" ? body.redirectUri : "";
  if (!code || !redirectUri) {
    return json(400, { error: "invalid_request", error_description: "code and redirectUri are required" });
  }

  const form = new URLSearchParams();
  form.set("grant_type", "authorization_code");
  form.set("code", code);
  form.set("redirect_uri", redirectUri);
  const headers = {
    "content-type": "application/x-www-form-urlencoded",
    "accept": "application/json"
  };
  if ((env.GBC_TOKEN_AUTH || "basic") === "body") {
    form.set("client_id", clientId);
    form.set("client_secret", clientSecret);
  } else {
    headers["authorization"] = "Basic " + btoa(clientId + ":" + clientSecret);
  }

  // One outbound call. Upstream OAuth error bodies never contain the secret,
  // so the response is passed through verbatim (status included) — after a
  // sanity check that a success body really carries an access_token.
  let upstream;
  try {
    upstream = await fetch(tokenUrl, { method: "POST", headers, body: form.toString() });
  } catch (e) {
    return json(502, {
      error: "upstream_unreachable",
      error_description: "could not reach the ConEd token endpoint."
    });
  }
  const text = await upstream.text();
  if (upstream.ok) {
    try {
      const parsed = JSON.parse(text);
      if (!parsed || !parsed.access_token) {
        return json(502, { error: "upstream_malformed", error_description: "token response had no access_token" });
      }
    } catch (e) {
      return json(502, { error: "upstream_malformed", error_description: "token response was not JSON" });
    }
  }
  return new Response(text, { status: upstream.status, headers: JSON_HEADERS });
}
