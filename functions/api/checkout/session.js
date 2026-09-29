// Verify the return from hosted checkout without trusting a browser URL flag.
// Only the fixed report's paid/unpaid state is returned; Stripe's customer and
// payment details never enter the page or logs.

const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" };
const REPORT_CENTS = 2900;
const REPORT_POLICY_VERSION = 1;

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function sameOrigin(request) {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}

function enabled(env) {
  return env && env.REPORT_CHARGING_CERTIFIED === "true" &&
    env.PAYMENT_PROVIDER_CERTIFIED === "true" && env.STRIPE_SECRET_KEY;
}

export async function onRequestGet({ request, env }) {
  if (!sameOrigin(request)) return json(403, { code: "origin_not_allowed", message: "checkout origin is not allowed" });
  if (!enabled(env)) {
    return json(503, { code: "provider_unavailable", message: "checkout is not certified for this deployment" });
  }
  const params = new URL(request.url).searchParams;
  const queryKeys = Array.from(params.keys());
  const id = params.get("session_id") || "";
  if (queryKeys.length !== 1 || queryKeys[0] !== "session_id") {
    return json(400, { code: "invalid_request", message: "only a checkout session id is accepted" });
  }
  if (!/^cs_[A-Za-z0-9_]+$/.test(id)) {
    return json(400, { code: "invalid_request", message: "a valid checkout session id is required" });
  }

  let upstream;
  try {
    upstream = await fetch("https://api.stripe.com/v1/checkout/sessions/" + encodeURIComponent(id), {
      headers: { authorization: "Bearer " + env.STRIPE_SECRET_KEY, accept: "application/json" }
    });
  } catch (e) {
    return json(502, { code: "provider_unreachable", message: "the payment provider could not be reached" });
  }
  let session;
  try { session = await upstream.json(); }
  catch (e) { return json(502, { code: "provider_malformed", message: "the payment provider returned an invalid response" }); }
  if (!upstream.ok || !session || session.id !== id || session.mode !== "payment" || !session.metadata ||
      session.metadata.product !== "report" || session.metadata.amount_cents !== String(REPORT_CENTS) ||
      session.metadata.policy_version !== String(REPORT_POLICY_VERSION) ||
      session.amount_total !== REPORT_CENTS || session.currency !== "usd") {
    return json(502, { code: "provider_error", message: "the checkout session did not match the certified report" });
  }
  if (session.payment_status === "paid" && session.status === "complete") {
    return json(200, { status: "succeeded", sessionId: id });
  }
  if (session.status === "expired") return json(200, { status: "cancelled", sessionId: id });
  return json(200, { status: "pending", sessionId: id });
}
