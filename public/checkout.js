/* Hosted payment-provider adapter.
 *
 * The browser never handles card data. The Pages Functions create and verify a
 * Stripe Checkout Session; this small adapter only sends the fixed report
 * product and consumes the provider's terminal outcome. It is deliberately
 * injectable so the checkout paths can be tested without Stripe or a card.
 */
(function (root) {
  "use strict";

  function outcomeError(code, message) {
    var e = new Error(message || code);
    e.code = code;
    return e;
  }

  function provider(options) {
    options = options || {};
    var fetcher = options.fetch || root.fetch;
    var location = options.location || root.location;
    var config = options.config || {};
    var createEndpoint = config.createEndpoint || "/api/checkout/create";
    var sessionEndpoint = config.sessionEndpoint || "/api/checkout/session";

    function jsonRequest(url, init) {
      if (typeof fetcher !== "function") return Promise.reject(outcomeError("CHECKOUT_UNAVAILABLE", "checkout is unavailable in this browser"));
      return Promise.resolve(fetcher(url, init)).then(function (response) {
        return Promise.resolve(response.json()).catch(function () { return {}; }).then(function (body) {
          if (!response.ok) {
            var code = body && body.code === "provider_unavailable" ? "CHECKOUT_UNAVAILABLE" : "CHECKOUT_FAILED";
            throw outcomeError(code, (body && body.message) || "the payment provider could not start checkout");
          }
          return body;
        });
      });
    }

    return {
      id: "stripe-checkout",
      charge: function (request) {
        if (!request || request.product !== "report" || request.amount !== 29 || request.currency !== "usd") {
          return Promise.reject(outcomeError("CHECKOUT_INELIGIBLE", "the checkout request is not the certified $29 report"));
        }
        return jsonRequest(createEndpoint, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ product: "report", policyVersion: request.policyVersion })
        }).then(function (body) {
          if (body.status === "succeeded") return body;
          if (body.status === "cancelled") throw outcomeError("CHECKOUT_CANCELLED", "checkout was cancelled");
          if (body.status !== "redirect" || typeof body.url !== "string") {
            throw outcomeError("CHECKOUT_FAILED", "the payment provider returned no checkout session");
          }
          if (location && typeof location.assign === "function") location.assign(body.url);
          return body;
        });
      },
      resume: function () {
        var search = location && location.search ? location.search : "";
        var params = new URLSearchParams(search);
        var status = params.get("checkout");
        if (status === "cancelled") return Promise.resolve({ status: "cancelled" });
        if (status !== "success") return null;
        var sessionId = params.get("session_id");
        if (!sessionId) return Promise.reject(outcomeError("CHECKOUT_FAILED", "the successful checkout has no session id"));
        return jsonRequest(sessionEndpoint + "?session_id=" + encodeURIComponent(sessionId), {
          method: "GET", headers: { accept: "application/json" }
        });
      },
      clearReturn: function () {
        if (!root.history || typeof root.history.replaceState !== "function" || !location) return;
        var clean = location.pathname + location.hash;
        root.history.replaceState({}, "", clean);
      }
    };
  }

  if (typeof module !== "undefined" && module.exports) module.exports = provider;
  else root.ConedCheckout = provider({ config: (root.ConedCalc && root.ConedCalc.RATES.pricing.provider) || {} });
})(typeof window !== "undefined" ? window : globalThis);
