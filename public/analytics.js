/* ConEd Rate Optimizer — the analytics privacy choke point.
   The ONLY code in this site allowed to touch the Cloudflare Web Analytics
   sender (window._cf) lives here. The allowlist below IS the contract: events
   go out as a bare, static name — never a field, dimension or payload of any
   kind. Written contract: docs/notes/analytics-privacy.md. Regression checks:
   test/analytics-privacy.js. Browser (window.ConedAnalytics) + Node
   (module.exports), like calc.js. */
(function (root) {
  "use strict";

  // The complete set of analytics events this site may send: name → when it
  // fires. Adding an entry means updating docs/notes/analytics-privacy.md and
  // the allowlist assertion in test/analytics-privacy.js in the same change.
  var ALLOWED_EVENTS = {
    sample_click: "the visitor pressed “Try the sample data”",
    parse_success: "a usage file (or the connected feed) parsed and rendered",
    parse_error: "a usage file failed to parse — the on-screen message is the only copy; the event carries none of it"
  };

  // Forward the bare event name to the Cloudflare beacon — or nothing.
  //
  // The privacy contract, mechanically:
  //  - `name` must be a key of ALLOWED_EVENTS. Anything else is dropped, so a
  //    dynamically composed name (a filename, token, account id, error
  //    message…) fails closed instead of shipping.
  //  - every argument after `name` is deliberately discarded, and the beacon
  //    is invoked with exactly one argument — no field of any kind can ride
  //    along, whatever a future beacon API might accept.
  //  - with the beacon absent (blocked by the visitor, or the feature-detect
  //    fails) this is a silent no-op — analytics can never error the page.
  function track(name) {
    if (!name || !Object.prototype.hasOwnProperty.call(ALLOWED_EVENTS, name)) return;
    var cf = root._cf;
    if (cf && typeof cf.event === "function") cf.event(name);
  }

  var api = { ALLOWED_EVENTS: ALLOWED_EVENTS, track: track };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ConedAnalytics = api;
})(typeof window !== "undefined" ? window : globalThis);
