// Create the hosted checkout session for the fixed $29 report.
//
// Card data never reaches this application. Stripe owns the hosted checkout
// page; this function only creates a session after both deployment gates have
// been enabled out-of-band. Missing bindings deliberately preserve the free
// result and return a non-chargeable response.

const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" };
const REPORT_CENTS = 2900;

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

export async function onRequestPost({ request, env }) {
  if (!sameOrigin(request)) return json(403, { code: "origin_not_allowed", message: "checkout origin is not allowed" });
  if (!enabled(env)) {
    return json(503, { code: "provider_unavailable", message: "checkout is not certified for this deployment" });
  }

  let body;
  try { body = await request.json(); }
  catch (e) { return json(400, { code: "invalid_request", message: "checkout request must be JSON" }); }
  if (!body || body.product !== "report") {
    return json(400, { code: "ineligible", message: "only the self-service report can be purchased" });
  }

  const origin = new URL(request.url).origin;
  const form = new URLSearchParams();
  form.set("mode", "payment");
  // Use price_data here instead of trusting a mutable dashboard Price ID: the
  // server itself enforces the documented $29 amount on every session.
  form.set("line_items[0][price_data][currency]", "usd");
  form.set("line_items[0][price_data][unit_amount]", String(REPORT_CENTS));
  form.set("line_items[0][price_data][product_data][name]", "ConEd Rate Optimizer self-service report");
  form.set("line_items[0][quantity]", "1");
  form.set("success_url", origin + "/?checkout=success&session_id={CHECKOUT_SESSION_ID}");
  form.set("cancel_url", origin + "/?checkout=cancelled");
  form.set("metadata[product]", "report");
  form.set("metadata[amount_cents]", String(REPORT_CENTS));

  let upstream;
  try {
    upstream = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        authorization: "Bearer " + env.STRIPE_SECRET_KEY,
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json"
      },
      body: form.toString()
    });
  } catch (e) {
    return json(502, { code: "provider_unreachable", message: "the payment provider could not be reached" });
  }

  let session;
  try { session = await upstream.json(); }
  catch (e) { return json(502, { code: "provider_malformed", message: "the payment provider returned an invalid response" }); }
  if (!upstream.ok || !session || typeof session.url !== "string" || typeof session.id !== "string") {
    return json(502, { code: "provider_error", message: "the payment provider could not create checkout" });
  }
  return json(200, { status: "redirect", url: session.url, sessionId: session.id });
}
