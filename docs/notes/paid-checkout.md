# Paid report checkout

The paid report is a one-time $29 product. The browser calculates the free
result and applies the offer gate; it never uploads interval data, billing
history, or account identifiers to create checkout.

## Two independent gates

`public/calc.js` offers the report only when the low end of the projected
first-year savings range is strictly greater than `$150`, a switch is
actionable, and the confidence gate has not failed. Collection additionally
requires both `pricing.chargingCertified` (the ≥20-account accuracy
certification) and `pricing.providerCertified` (the payment provider's
deployment certification). The shipped values are false, so a qualified
visitor still receives the free result and a clear unavailable-checkout
message.

## Provider handoff

`public/checkout.js` is the browser adapter for Stripe-hosted Checkout. It
sends only `{ product: "report", policyVersion }` to
`/api/checkout/create`; the Pages Function creates a session with a fixed
`2900`-cent USD line item. Card data is handled by Stripe. On return,
`/api/checkout/session` verifies the session server-side, including product,
currency, amount, completion, and payment status, before the browser unlocks
the report. A success query parameter alone never unlocks anything.

The Pages deployment must provide these out-of-band bindings before enabling
collection:

- `STRIPE_SECRET_KEY`
- `REPORT_CHARGING_CERTIFIED=true`
- `PAYMENT_PROVIDER_CERTIFIED=true`

The client-side policy flags and server-side bindings are intentionally both
required. Missing or failed checkout returns to the free result; cancellation
does not count as a failed payment attempt, while provider failures use the
bounded retry state machine in `public/calc.js`.
