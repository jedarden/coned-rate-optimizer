/* ConEd Rate Optimizer — DOM glue. Uses window.ConedCalc (calc.js); persistent
   monitoring (window.ConedMonitor, monitor.js) when it's available. */
(function () {
  "use strict";
  var C = window.ConedCalc, R = C.RATES;
  // The analytics choke point (analytics.js) — inert stub if it failed to load.
  var A = window.ConedAnalytics || { track: function () {} };
  var M = window.ConedMonitor || null;   // monitoring degrades to today's behavior if monitor.js didn't load
  var $ = function (id) { return document.getElementById(id); };
  var drop = $("drop"), file = $("file"), err = $("error"), results = $("results");
  var evToggle = $("ev-toggle"), lastParsed = null, lastLabel = "", lastBills = [], lastBillingNote = null;
  var series = null, monitorNote = null; // the retained monitoring series; save failures surface once, where the numbers are
  var paymentFlow = C.newPaymentFlow(), paymentFingerprint = null;

  var usd = function (n) { return (n < 0 ? "−" : "") + "$" + Math.abs(Math.round(n)).toLocaleString("en-US"); };
  var usd2 = function (n) { return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  var signed = function (n) {
    var r = Math.round(n);
    return (r === 0 ? "" : n >= 0 ? "+" : "−") + "$" + Math.abs(r).toLocaleString("en-US");
  };
  var money = function (n) {
    return (n < 0 ? "−$" : "$") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  var html = function (s) { return String(s == null ? "" : s).replace(/[&<>\"']/g, function (c) {
    return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
  }); };

  function resetPaymentFlow() {
    paymentFlow = C.newPaymentFlow();
    paymentFingerprint = null;
  }

  function syncPaymentFlow(paid) {
    var offer = paid && paid.offer;
    var fingerprint = JSON.stringify({
      target: offer && offer.targetPlan ? offer.targetPlan.key : null,
      estimate: paid && paid.savings ? paid.savings.estimate : null,
      threshold: paid && paid.threshold ? paid.threshold.value : null,
      policy: offer ? offer.policyVersion : null
    });
    if (paymentFingerprint === fingerprint && paymentFlow.state !== "start") return;
    paymentFingerprint = fingerprint;
    paymentFlow = C.paymentTransition(C.newPaymentFlow(), "verdict", { paid: paid });
    // The pure eligibility gate treats any non-null provider configuration as
    // wired. The browser additionally requires the adapter's charge method so
    // a malformed deployment cannot expose a pay button that cannot complete.
    if (paymentFlow.state === "offered" && !checkoutProvider()) {
      paymentFlow.state = "unavailable";
      paymentFlow.reason = "no browser checkout adapter is wired into this deployment.";
    }
  }

  function showError(msg) {
    err.textContent = "Couldn't read that file: " + msg;
    err.hidden = false;
    results.hidden = true;
    // Track parse error for analytics funnel — bare name only, never the message
    A.track('parse_error');
  }

  // The declared facts the eligibility engine gates on (all optional; calc.js defaults apply
  // to anything unset). Everything stays on-device like the rest of the analysis.
  function profileOptions() {
    return {
      territory: $("pf-territory") ? $("pf-territory").value : undefined,
      currentPlan: $("pf-plan") ? $("pf-plan").value : undefined,
      meter: $("pf-meter") ? $("pf-meter").value : undefined,
      solar: !!( $("pf-solar") && $("pf-solar").checked ),
      esco: !!( $("pf-esco") && $("pf-esco").checked ),
      heatPump: !!( $("pf-heatpump") && $("pf-heatpump").checked )
    };
  }

  function calcOptions() { return { smartChargeNY: !!(evToggle && evToggle.checked), profile: profileOptions(), bills: lastBills }; }

  function monthCost(m, smartCharge) {
    var std = m.total * R.standard.allIn + R.standard.customer;
    var pr = m.summer ? R.tou.peakSummer : R.tou.peakWinter;
    var credit = smartCharge ? m.off * R.smartChargeNY.offPeakCredit : 0;
    var tou = m.total * R.tou.nonCommodity + (m.peak * pr + m.off * R.tou.offPeak) * R.tou.gross + R.tou.customer - credit;
    return { std: std, tou: tou };
  }

  function monthlyChart(months, smartCharge) {
    var W = 760, H = 200, padB = 26, padL = 4, n = months.length;
    var per = W / n, bw = Math.min(14, per / 3);
    var costs = months.map(function (m) { return monthCost(m, smartCharge); });
    var max = Math.max.apply(null, costs.map(function (c) { return Math.max(c.std, c.tou); })) || 1;
    var svg = ['<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Monthly cost: Standard vs Time-of-Use">'];
    var base = H - padB;
    months.forEach(function (m, i) {
      var cx = i * per + per / 2, c = costs[i];
      var hs = (c.std / max) * (base - 8), ht = (c.tou / max) * (base - 8);
      svg.push('<rect class="bs" x="' + (cx - bw - 1) + '" y="' + (base - hs) + '" width="' + bw + '" height="' + hs + '" rx="2"/>');
      svg.push('<rect class="bt" x="' + (cx + 1) + '" y="' + (base - ht) + '" width="' + bw + '" height="' + ht + '" rx="2"/>');
      svg.push('<text x="' + cx + '" y="' + (H - 8) + '" text-anchor="middle">' + m.ym.slice(2) + '</text>');
    });
    svg.push('</svg>');
    return svg.join("") +
      '<div class="chart-legend"><span><span class="sw" style="background:var(--accent)"></span>Standard</span>' +
      '<span><span class="sw" style="background:var(--warn)"></span>Time-of-Use</span></div>';
  }

  // "Show the math" — per-plan line items on the user's own numbers
  function planMath(p, factor) {
    var lines = p.breakdown.map(function (l) {
      return '<tr><td>' + l.label + '</td><td class="det">' + l.detail + '</td><td class="num">' + usd(l.amount * factor) + '/yr</td></tr>';
    }).join("");
    return '<div class="mplan"><div class="mh">' + p.name + ' · <strong>' + usd(p.cost * factor) + '/yr</strong>' +
      (p.current ? ' <span class="pill">current</span>' : '') +
      (p.avail === false ? ' <span class="tag warn">not eligible: ' + p.excludedReason + '</span>' : '') +
      (p.formerly ? ' <span class="tag">formerly ' + p.formerly + '</span>' : '') +
      (p.demand ? ' <span class="tag">demand estimate</span>' : '') +
      (p.ratesAsOf ? ' <span class="tag">' + p.ratesAsOf + '</span>' : '') +
      (p.eligibilityNotes && p.eligibilityNotes.length ? '<ul class="pnotes">' +
        p.eligibilityNotes.map(function (n) { return '<li>' + n + '</li>'; }).join("") + '</ul>' : '') +
      '</div>' +
      '<table class="mtab"><tbody>' + lines + '</tbody></table></div>';
  }

  // ---- period dashboard (docs/product-strategy.md, "Month-over-month experience") ----
  // The four questions — what did I pay, why did it change, am I still on the best
  // eligible rate, what would the switch have saved — over the measured window. The
  // decomposition math is calc.js's; this is the copy and the table.
  var COMPONENT_LABELS = { delivery: "delivery", commodity: "supply", mac: "MAC", rdm: "RDM", surcharges: "surcharge" };
  function planShort(key) {
    var r = C.planRates(key);
    return key === "standard" ? "Standard" : (r.short || r.name || key);
  }
  function cents(n) { return (n >= 0 ? "+" : "−") + Math.abs(n * 100).toFixed(2) + "¢/kWh"; }

  function momText(r) {
    var m = r.mom; if (!m) return "";
    var bits = [];
    if (r.planSwitch) bits.push("you switched to " + planShort(r.planSwitch) + " — not a like-for-like month");
    if (r.partial) bits.push("partial period — " + r.observedDays + " of " + r.calendarDays + " days");
    var rateBit = r.rateDriver
      ? (COMPONENT_LABELS[r.rateDriver.component] || r.rateDriver.component) + " rate " + cents(r.rateDriver.delta)
      : null;
    var dDays = r.days - (r.prevDays === null ? r.days : r.prevDays);
    [{ v: m.usage, t: "usage " + signed(m.usage) },
     { v: m.calendar, t: Math.abs(dDays) + (Math.abs(dDays) === 1 ? " day" : " days") + " " + signed(m.calendar) },
     { v: m.rate, t: rateBit || "rate " + signed(m.rate) }
    ].sort(function (x, y) { return Math.abs(y.v) - Math.abs(x.v); })
     .forEach(function (c) { if (Math.round(Math.abs(c.v)) >= 1) bits.push(c.t); });
    if (r.prevPeakPct !== null && Math.abs(r.peakPct - r.prevPeakPct) >= 5)
      bits.push("load shifted " + Math.abs(r.peakPct - r.prevPeakPct).toFixed(0) + " pts " +
        (r.peakPct > r.prevPeakPct ? "toward peak" : "off-peak"));
    return bits.join(" · ");
  }

  function periodSection(d) {
    if (!d || !d.rows || !d.rows.length) return "";
    var cur = planShort(d.currentPlan);
    var body = d.rows.map(function (r) {
      var tags = "";
      if (r.partial) tags += ' <span class="tag warn">partial · ' + r.observedDays + "/" + r.calendarDays + "d</span>";
      if (r.projected) tags += ' <span class="tag">projected rates</span>';
      if (r.planSwitch) tags += ' <span class="tag">plan switch</span>';
      var cls = function (n) { return n > 0.005 ? "delta-up" : n < -0.005 ? "delta-down" : ""; };
      var diff = r.difference === null ? "" : '<span class="' + cls(r.difference) + '">' + signed(r.difference) + "</span>";
      var change = r.mom
        ? '<span class="' + cls(r.mom.total) + '">' + signed(r.mom.total) + "</span>"
        : '<span class="tag">first period</span>';
      var best = r.best ? usd2(r.best.total) + ' <span class="tag">' + planShort(r.bestKey) + "</span>" : "—";
      return "<tr><td>" + r.ym + tags + "</td>" +
        '<td class="num">' + Math.round(r.days) + "</td>" +
        '<td class="num">' + Math.round(r.kwh).toLocaleString("en-US") + "</td>" +
        '<td class="num">' + (r.actual ? usd2(r.actual.total) : "—") + "</td>" +
        '<td class="num">' + best + "</td>" +
        '<td class="num">' + diff + "</td>" +
        '<td class="num">' + change + "</td>" +
        "<td>" + momText(r) + "</td></tr>";
    }).join("");
    var summary;
    if (d.difference > 0.5)
      summary = "Staying on " + cur + " cost <strong>" + usd(d.difference) + " more</strong> than the best eligible plan would have, over these " + d.rows.length + " periods.";
    else if (d.difference < -0.5)
      summary = "Your " + cur + " bills came in <strong>" + usd(-d.difference) + " below</strong> the current-rate best-plan pricing — earlier rate schedules were cheaper; the comparison prices alternatives at today's rates.";
    else
      summary = "Your current plan (" + cur + ") matched or beat every eligible alternative across these " + d.rows.length + " periods.";
    return '<h3 class="sec">Period by period — paid vs best eligible plan</h3>' +
      '<div style="overflow-x:auto"><table id="period-table"><thead><tr><th>Period</th><th class="num">Days</th><th class="num">kWh</th>' +
      '<th class="num">Actual charge</th><th class="num">Best-plan charge</th><th class="num">Difference</th>' +
      '<th class="num">Change</th><th>What changed</th></tr></thead><tbody>' + body + "</tbody></table></div>" +
      '<p class="legend" id="period-summary"><strong>' + summary + "</strong></p>" +
      '<p class="legend">Actual = what your current plan charged, reconstructed component-by-component from ConEd\'s published bill history when you\'re on Standard, modeled on the plan\'s own rates otherwise. Best plan = the cheapest plan you\'re eligible for that period, at current published rates. These are calendar-month buckets of your interval data — ConEd\'s own billing periods are a different unit, and once a billing history imports they\'re reconciled in their own table below rather than folded in here.</p>' +
      (d.partialCount ? '<p class="legend">Partial months (a truncated export window) are tagged: the charge is what it was, but most of their month-over-month change is just missing days, and the table says so.</p>' : "") +
      (d.esco ? '<p class="legend">You buy supply from an ESCO: the supply side of both columns is estimated at ConEd published rates — your ESCO\'s contract price replaces it on the real bill. The delivery-side comparison stands.</p>' : "");
  }

  // Confidence, stated BEFORE the verdict (docs/product-strategy.md: the free
  // result carries "calculation confidence and missing-data warnings"). High
  // confidence with reconciled bills is stated too — the verification is the
  // trust signal, not just the warning.
  function confidenceBlock(a) {
    var c = a.confidence;
    if (!c) return "";
    if (c.level === "high") {
      var n = a.reconciliation && a.reconciliation.rows ? a.reconciliation.rows.length : 0;
      return n ? '<p class="legend conf-line">✓ <strong>Verified:</strong> ' + n + " actual bill" + (n === 1 ? "" : "s") +
        ' reconstructed within the 2% accuracy gate — the numbers below are checked against your real bills.</p>' : "";
    }
    return '<p class="opp">⚠ <strong>Confidence: ' + c.level + '.</strong> ' + c.reasons.join(" ") + "</p>";
  }

  // Your actual bills vs the model — the reconciliation behind the confidence
  // call. Bill periods stay bill periods: their own table, never silently
  // mapped onto the calendar-month buckets above.
  function billsSection(a) {
    var r = a.reconciliation, dq = a.dataQuality || {};
    if (!r || (!r.rows.length && !r.unsupported.length && !r.incomplete.length && !(dq.billGaps || []).length && !(dq.missingMonths || []).length)) return "";
    var body = r.rows.map(function (row) {
      var cls = row.band === "pass" ? "delta-down" : row.band === "fail" ? "delta-up" : "";
      return "<tr><td>" + row.label + "</td>" +
        '<td class="num">' + row.billDays + "</td>" +
        '<td class="num">' + Math.round(row.kwh).toLocaleString("en-US") + "</td>" +
        '<td class="num">' + usd2(row.actualTotal) + "</td>" +
        '<td class="num">' + usd2(row.modeledTotal) + "</td>" +
        '<td class="num ' + cls + '">' + signed(row.delta) + " (" + (isFinite(row.pctError) ? row.pctError.toFixed(1) : "∞") + "%)</td>" +
        '<td><span class="tag' + (row.band === "pass" ? "" : " warn") + '">' + row.band + "</span></td></tr>";
    }).join("");
    var notes = [];
    (r.unsupported || []).forEach(function (u) { notes.push("<li><strong>" + u.label + "</strong> — not checked: " + u.reason + ".</li>"); });
    (r.incomplete || []).forEach(function (u) { notes.push("<li><strong>" + u.label + "</strong> — unusable: " + u.reason + ".</li>"); });
    (dq.billGaps || []).forEach(function (g) {
      notes.push("<li>No bill between <strong>" + g.after + "</strong> and <strong>" + g.before + "</strong> (" + g.days + " days) — a bill is missing from the history.</li>");
    });
    (dq.missingMonths || []).forEach(function (ym) {
      notes.push("<li>No usage data for <strong>" + ym + "</strong> — that month is missing from the export.</li>");
    });
    return '<h3 class="sec">Your actual bills vs the model</h3>' +
      (r.rows.length ? '<div style="overflow-x:auto"><table id="bill-table"><thead><tr><th>Bill period</th><th class="num">Days</th><th class="num">kWh</th>' +
        '<th class="num">Actual</th><th class="num">Modeled</th><th class="num">Δ</th><th>Check</th></tr></thead><tbody>' + body + "</tbody></table></div>" +
        '<p class="legend">Modeled = the bill\'s own kWh priced component-by-component at ConEd\'s published rates for the bill\'s year — the reconstruction the confidence call is based on. The customer charge is prorated over the bill\'s days.</p>' : "") +
      (notes.length ? '<ul class="pnotes">' + notes.join("") + "</ul>" : "");
  }

  // ---- persistent monitoring (docs/product-strategy.md, "Month-over-month
  // experience") ---- The stored series, not just this import's window: the
  // period table above already renders every retained month. This section
  // answers the remaining questions over that whole history — the cumulative
  // actual-vs-best totals with their verification status, what a plan switch
  // has actually saved since it happened, the current recommendation, and the
  // retention/deletion contract the store runs by.
  function monitorSection(a, st, recheck) {
    if (!M || !series || !series.months.length) return "";
    var d = st.dashboard;
    if (!d || !d.rows || !d.rows.length) return "";
    var from = series.months[0].ym, to = series.months[series.months.length - 1].ym;
    var revised = series.months.filter(function (m) { return m.revisions; }).length +
                  series.bills.filter(function (b) { return b.revisions; }).length;
    var parts = [];
    parts.push('<h3 class="sec">Monitoring — your history, kept in this browser</h3>');
    parts.push('<p class="legend" id="monitor-status">' + series.months.length + " months retained (" + from + " through " + to + ") · " +
      series.imports + " import" + (series.imports === 1 ? "" : "s") +
      (revised ? " · " + revised + " period" + (revised === 1 ? "" : "s") + " revised by a later import" : "") +
      (series.trimmed ? " · " + series.trimmed + " older months aged out of the " + M.RETENTION_MONTHS + "-month window" : "") + ".</p>");

    if (recheck && recheck.changed && recheck.alert) {
      parts.push('<aside class="recheck-alert" id="monitor-recheck-alert" role="status" aria-live="polite">' +
        '<strong>' + html(recheck.alert.title) + '</strong>' +
        '<p>' + html(recheck.alert.message) + '</p>' +
        '<ul>' + recheck.alert.reasons.map(function (reason) { return '<li>' + html(reason) + '</li>'; }).join("") + '</ul>' +
        '</aside>');
    } else if (recheck && recheck.notice) {
      // A tariff refresh can change displayed costs without changing the
      // switch/stay decision. Keep that provenance visible so a user cannot
      // mistake a freshly recomputed result for the old result.
      parts.push('<aside class="recheck-status" id="monitor-recheck-status" role="status" aria-live="polite">' +
        '<strong>' + html(recheck.notice.title) + '</strong>' +
        '<p>' + html(recheck.notice.message) + '</p>' +
        '</aside>');
    }

    // The cumulative answer, with its evidence class stated — "verified" is a
    // gate result (accuracy gate), never a decoration.
    var verified = a.confidence && a.confidence.level === "high" &&
      a.reconciliation && a.reconciliation.rows && a.reconciliation.rows.length;
    var diffCell = '<span class="' + (d.difference > 0.005 ? "delta-up" : d.difference < -0.005 ? "delta-down" : "") + '">' + usd2(d.difference) + "</span>";
    parts.push('<div class="stats">' +
      '<div class="stat"><div class="k">Actually paid · ' + d.rows.length + ' periods</div><div class="v">' + usd2(d.actualTotal) + "</div></div>" +
      '<div class="stat"><div class="k">Best eligible plan, same periods</div><div class="v">' + usd2(d.bestTotal) + "</div></div>" +
      '<div class="stat"><div class="k">Cumulative difference</div><div class="v">' + diffCell + "</div></div></div>");
    parts.push(verified
      ? '<p class="legend">✓ <strong>Verified:</strong> this cumulative figure rests on ' + a.reconciliation.rows.length + " actual bill" +
        (a.reconciliation.rows.length === 1 ? "" : "s") + " reconstructed within the 2% accuracy gate — " + a.confidence.reasons.join(" ") + "</p>"
      : '<p class="legend">⚠ <strong>Estimate, not verified:</strong> no billing history has been reconciled against these periods. Import your billing history (or connect Share My Data) and the same table returns with an accuracy-gate verdict.</p>');

    // Q4 across a real switch: what changing plans has actually saved so far.
    if (st.switched) {
      var rz = M.realized(series, st, a, calcOptions());
      if (rz && rz.savings !== null && rz.savings !== undefined)
        parts.push('<p class="legend" id="monitor-realized">Since switching to ' + planShort(rz.plan) + " in " + rz.from + ": <strong>" +
          (rz.savings >= 0 ? "saved " + usd2(rz.savings) : "cost " + usd2(-rz.savings) + " more than") + "</strong> " +
          "vs staying on " + planShort(rz.priorPlan) + " — over " + rz.months + " month" + (rz.months === 1 ? "" : "s") + " of real bills, not projections.</p>");
      else if (rz && rz.unpriced && rz.unpriced.length)
        parts.push('<p class="legend">Your switch to ' + planShort(rz.plan) + " in " + rz.from + " can\'t be priced yet: the counterfactual (" +
          planShort(rz.priorPlan) + ') needs hourly data for those months, and only monthly buckets are retained. Re-import the hourly export and it\'s computed.</p>');
    }

    parts.push('<p class="legend" id="monitor-recommendation"><strong>Current recommendation:</strong> ' + a.recommendation + "</p>");
    parts.push('<div class="actions"><button id="monitor-delete" class="btn-share" type="button">Delete stored data</button></div>');

    // The retention/deletion contract, stated where the data lives.
    var boundary = 'Monitoring keeps ' + "monthly usage buckets, the bill summaries you've imported, and the eligibility facts you declared — in this browser's local storage, on this device, sent nowhere. Raw hourly data, account identifiers, and credentials are not retained; the connect token never outlives its tab. The most recent " + M.RETENTION_MONTHS + " months are kept; nothing expires on its own. Deleting removes all of it, permanently and immediately.";
    parts.push('<p class="legend">' + boundary + "</p>");
    if (monitorNote) parts.push('<p class="legend">⚠ ' + monitorNote + "</p>");
    return parts.join("");
  }

  // Privacy-safe share card: rendered in-browser, shared/downloaded by the user. Nothing uploaded.
  function shareCard(a) {
    var W = 1200, H = 630, c = document.createElement("canvas"); c.width = W; c.height = H;
    var g = c.getContext("2d"), F = "-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif";
    g.fillStyle = "#0e1116"; g.fillRect(0, 0, W, H);
    g.fillStyle = "#5ea0f0"; g.fillRect(0, 0, W, 12);
    g.fillStyle = "#9aa4b2"; g.font = "600 34px " + F; g.fillText("ConEd Rate Optimizer", 70, 112);
    var save = a.savingsIfSwitch > 1;
    g.fillStyle = save ? "#4ad08a" : "#e0a05a"; g.font = "800 92px " + F;
    g.fillText(save ? "Save " + usd(a.savingsIfSwitch * a.annualFactor) + "/yr" : "Stay on Standard", 70, 240);
    g.fillStyle = "#e8eaed"; g.font = "400 32px " + F;
    g.fillText(save ? "by switching to " + (a.switchTarget ? a.switchTarget.name : a.cheapest.name) : "no ConEd plan switch lowers this bill", 70, 300);
    g.font = "400 30px " + F; var y = 392;
    a.plans.forEach(function (p) {
      g.fillStyle = "#9aa4b2"; g.textAlign = "left"; g.fillText(p.name + (p.demand ? " (est.)" : ""), 70, y);
      g.fillStyle = "#e8eaed"; g.textAlign = "right"; g.fillText(usd(p.cost * a.annualFactor) + "/yr", 1130, y);
      y += 48;
    });
    g.textAlign = "left"; g.fillStyle = "#5ea0f0"; g.font = "600 30px " + F; g.fillText("coned.jedarden.com", 70, 592);
    g.textAlign = "right"; g.fillStyle = "#5b6472"; g.font = "400 24px " + F; g.fillText("computed in your browser · v" + R.meta.version, 1130, 592);
    g.textAlign = "left";
    c.toBlob(function (blob) {
      if (!blob) return;
      var file = new File([blob], "coned-rate-result.png", { type: "image/png" });
      if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
        navigator.share({ files: [file], title: "ConEd Rate Optimizer", text: "I checked whether switching ConEd rate plans saves money — coned.jedarden.com" }).catch(function () {});
      } else {
        var url = URL.createObjectURL(blob), el = document.createElement("a"); el.href = url; el.download = "coned-rate-result.png"; el.click();
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      }
    }, "image/png");
  }

  // The first result is deliberately useful without a purchase. It shows the
  // conservative opportunity range and the reason the report is, or is not,
  // available; the detailed report is rendered only after a completed payment.
  function freePreview(a, paid, curEntry, period) {
    var s = paid && paid.savings ? paid.savings : { estimate: 0, low: 0, high: 0 };
    var target = a.switchTarget;
    var title, copy, opportunity;
    if (paid && paid.noSavings) {
      title = "Your free result is complete";
      opportunity = "No meaningful savings found";
      copy = paid.noSavings.message;
    } else if (target && s.estimate > 0) {
      title = "Free savings preview";
      opportunity = money(s.low) + "–" + money(s.high) + "/yr";
      copy = "The comparison estimates that switching from " + curEntry.name + " to " + target.name +
        " could save " + money(s.estimate) + "/yr " + period + ".";
    } else {
      title = "Free savings preview";
      opportunity = "No meaningful savings found";
      copy = "The free comparison found no eligible switch that lowers this bill.";
    }
    var qualification = paid && paid.offer
      ? (paid.collectible
        ? "Your result clears the $" + paid.threshold.value + "/yr meaningful-savings bar."
        : "Your result clears the $" + paid.threshold.value + "/yr meaningful-savings bar, but checkout is not live in this deployment yet.")
      : (paid && paid.reasons && paid.reasons.length && !paid.noSavings ? paid.reasons[0] : "");
    return '<section id="free-preview" class="preview-card" aria-labelledby="free-preview-title">' +
      '<div class="eyebrow">Free result</div><h2 id="free-preview-title">' + title + '</h2>' +
      '<div class="preview-opportunity">' + opportunity + '</div>' +
      '<p>' + copy + '</p>' +
      (qualification ? '<p class="legend preview-reason">' + qualification + '</p>' : '') +
      (paid && paid.noSavings ? '<p class="legend"><strong>No charge.</strong> ' + paid.noSavings.annualRecheck + '</p>' : '') +
      '</section>';
  }

  function checkoutProvider() {
    var configured = C.RATES.pricing && C.RATES.pricing.provider;
    if (configured && typeof configured.charge === "function") return configured;
    if (window.ConedCheckout && typeof window.ConedCheckout.charge === "function") return window.ConedCheckout;
    return null;
  }

  function checkoutSection(paid, flow) {
    if (!paid || !paid.offer) {
      var noCharge = paid && paid.noSavings
        ? "No report is offered because this is the no-savings result — it stays free."
        : "No charge is due: the report is offered only after the conservative savings threshold and confidence checks pass.";
      return '<section id="report-checkout" class="checkout-card checkout-muted" aria-labelledby="checkout-title">' +
        '<h2 id="checkout-title">Paid report</h2><p>' + noCharge + '</p></section>';
    }
    var offer = paid.offer, price = money(offer.price || 0), state = flow && flow.state;
    var content = '<ul class="checkout-includes">' + offer.includes.map(function (item) { return '<li>' + item + '</li>'; }).join("") + '</ul>';
    if (state === "paid" || state === "refunded") {
      return '<section id="report-checkout" class="checkout-card checkout-complete" aria-labelledby="checkout-title">' +
        '<h2 id="checkout-title">Report unlocked</h2><p>Your ' + offer.name + ' is ready below.</p></section>';
    }
    if (state === "unavailable") {
      return '<section id="report-checkout" class="checkout-card" aria-labelledby="checkout-title">' +
        '<div class="eyebrow">Checkout</div><h2 id="checkout-title">' + offer.name + ' · ' + price + '</h2>' +
        '<p>' + (paid.reasons[paid.reasons.length - 1] || "Checkout is not available yet.") + '</p>' + content +
        '<p class="legend">You will not be charged while the accuracy gate and payment provider are not both active. The free result above remains yours.</p></section>';
    }
    if (state === "abandoned") {
      return '<section id="report-checkout" class="checkout-card checkout-muted" aria-labelledby="checkout-title">' +
        '<h2 id="checkout-title">Checkout closed for this result</h2><p>' + (flow.reason || "Payment attempts were exhausted.") + '</p></section>';
    }
    var busy = state === "charging";
    var failed = state === "failed";
    return '<section id="report-checkout" class="checkout-card" aria-labelledby="checkout-title">' +
      '<div class="eyebrow">Checkout</div><h2 id="checkout-title">' + offer.name + ' · ' + price + '</h2>' +
      '<p>Pay once for the full analysis. This is an independent service, not Con Edison. The savings are a projection, not a guarantee.</p>' +
      content +
      '<div class="consent-list">' +
        '<label><input type="checkbox" id="consent-price" /> I saw the ' + price + ' price.</label>' +
        '<label><input type="checkbox" id="consent-contents" /> I saw what the report contains.</label>' +
        '<label><input type="checkbox" id="consent-affiliation" /> I understand this service is independent, not Con Edison.</label>' +
        '<label><input type="checkbox" id="consent-estimate" /> I understand savings are projected, not guaranteed.</label>' +
        '<label><input type="checkbox" id="consent-charge" /> I authorize the ' + price + ' charge.</label>' +
      '</div>' +
      (failed ? '<p class="checkout-error" role="alert">' + (flow.reason || "Payment failed.") + '</p>' : '') +
      '<button id="report-pay" class="btn" type="button"' + (busy ? ' disabled' : '') + '>' +
        (busy ? 'Processing payment…' : failed ? 'Retry payment' : 'Pay ' + price + ' and unlock report') + '</button>' +
      '<p id="checkout-status" class="legend" role="status"></p></section>';
  }

  function paidReportSection(a, st) {
    if (paymentFlow.state !== "paid" && paymentFlow.state !== "refunded") return "";
    var target = a.switchTarget;
    var rows = a.comparison.map(function (p) {
      var state = p.current ? "current plan" : p.avail ? "eligible alternative" : "not eligible";
      var notes = p.eligibilityNotes && p.eligibilityNotes.length
        ? '<ul class="pnotes">' + p.eligibilityNotes.map(function (n) { return '<li>' + n + '</li>'; }).join("") + '</ul>' : '';
      return '<tr><td><strong>' + p.name + '</strong><br><span class="tag">' + state + '</span></td>' +
        '<td class="num">' + usd(p.annualCost) + '/yr</td><td>' + (p.eligibility || "") + notes + '</td></tr>';
    }).join("");
    var targetNotes = target && target.eligibilityNotes && target.eligibilityNotes.length
      ? target.eligibilityNotes.map(function (n) { return '<li>' + n + '</li>'; }).join("") : '';
    var targetName = target ? target.name : "the recommended plan";
    var monthRows = st && st.dashboard && st.dashboard.rows ? st.dashboard.rows.map(function (r) {
      return '<tr><td>' + r.ym + '</td><td class="num">' + (r.actual ? usd2(r.actual.total) : '—') + '</td>' +
        '<td class="num">' + (r.best ? usd2(r.best.total) : '—') + '</td><td class="num">' +
        (r.difference === null ? '—' : signed(r.difference)) + '</td></tr>';
    }).join("") : '';
    return '<section id="paid-report" class="paid-report" aria-labelledby="paid-report-title">' +
      '<div class="eyebrow">Paid analysis</div><h2 id="paid-report-title">Your complete rate-switch report</h2>' +
      '<p>Prepared for your declared situation. The recommendation is independent of Con Edison and uses the rate data shown below.</p>' +
      '<h3 class="sec">Complete plan comparison</h3>' +
      '<div style="overflow-x:auto"><table id="report-plan-comparison"><thead><tr><th>Rate plan</th><th class="num">Annual cost</th><th>Eligibility and terms</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<h3 class="sec">Switching guidance</h3>' +
      '<ol class="switch-steps"><li>Request <strong>' + targetName + '</strong> through Con Edison, using that exact plan name.</li>' +
      '<li>Allow the switch to take effect with a future meter read — typically the next bill or the one after (1–2 billing cycles).</li>' +
      (targetNotes ? '<li>Before enrolling, review the target plan terms:<ul class="pnotes">' + targetNotes + '</ul></li>' : '') +
      '<li>Keep the first new bill and re-run this analysis after the switch so the projected comparison can be checked against what you actually paid.</li></ol>' +
      '<p class="legend">Optional concierge switching and first-year verification are separate services. The report price does not promise enrollment or guaranteed future savings.</p>' +
      '<h3 class="sec">Month-by-month counterfactual charges</h3>' +
      '<div style="overflow-x:auto"><table id="report-monthly-comparison"><thead><tr><th>Period</th><th class="num">Actual/current plan</th><th class="num">Best eligible plan</th><th class="num">Difference</th></tr></thead><tbody>' + monthRows + '</tbody></table></div>' +
      '</section>';
  }

  function bindCheckout(a) {
    var pay = $("report-pay");
    if (!pay) return;
    pay.addEventListener("click", function () {
      var consent = {
        version: a.paid.offer.policyVersion,
        sawPrice: !!$("consent-price").checked,
        sawContents: !!$("consent-contents").checked,
        sawNoAffiliation: !!$("consent-affiliation").checked,
        sawEstimateCaveat: !!$("consent-estimate").checked,
        authorizesCharge: !!$("consent-charge").checked,
        grantedAt: Date.now()
      };
      var authorized = C.paymentTransition(paymentFlow, "consent", { consent: consent });
      paymentFlow = authorized;
      if (authorized.state !== "consented") {
        var bad = $("checkout-status");
        if (bad) bad.textContent = authorized.reason || "Please review every acknowledgment before paying.";
        return;
      }
      var provider = checkoutProvider();
      if (!provider) {
        paymentFlow.state = "unavailable";
        paymentFlow.reason = "no browser checkout adapter is wired into this deployment.";
        render(a, lastLabel, { noScroll: true });
        return;
      }
      paymentFlow = C.paymentTransition(paymentFlow, "charge");
      render(a, lastLabel, { noScroll: true });
      var request = { product: a.paid.offer.product, amount: a.paid.offer.price, currency: a.paid.offer.currency };
      var result;
      try { result = provider.charge(request); } catch (e) { result = Promise.reject(e); }
      Promise.resolve(result).then(function () {
        paymentFlow = C.paymentTransition(paymentFlow, "charge_succeeded", {}, { now: Date.now() });
        render(a, lastLabel, { noScroll: true });
      }).catch(function () {
        paymentFlow = C.paymentTransition(paymentFlow, "charge_failed");
        render(a, lastLabel, { noScroll: true });
      });
    });
  }

  function render(a, label, opts) {
    opts = opts || {};
    err.hidden = true;
    // Track successful parse for analytics funnel — bare name only
    A.track('parse_success');
    var paid = a.paid || C.paidConversion(a);
    syncPaymentFlow(paid);
    var saves = a.savingsIfSwitch > 1;                 // >$1 to avoid rounding noise
    var vClass = saves ? "good" : "warn";
    var period = (a.ndays >= 350 && a.ndays <= 385) ? "over the past year" : "over " + a.ndays + " days (annualized)";
    var curEntry = a.plans.filter(function (p) { return p.current; })[0] || a.plans[0];
    var curName = curEntry.short || curEntry.name;

    // eligibility blockers (wrong territory / account class) — the numbers stay on screen
    // but are flagged as not actionable
    var blockerNote = a.eligibility.blockers.length
      ? '<p class="opp">' + a.eligibility.blockers.map(function (b) { return '⚠ ' + b; }).join('<br>') + '</p>' : '';

    // verdict
    var vHtml;
    if (saves) {
      vHtml = '<h2>You could lower your bill 🎉</h2>' +
        '<div class="big">Save ' + usd(a.savingsIfSwitch * a.annualFactor) + '/yr</div>' +
        '<p>Switching to <strong>' + a.switchTarget.name + '</strong> would cost less than your current ' + curEntry.name + ' plan, based on your actual usage ' + period + '.</p>';
    } else if (curEntry.key === "standard") {
      vHtml = '<h2>Stay on Standard</h2>' +
        '<div class="big">' + signed(a.touDeltaAnnual) + '/yr on TOU</div>' +
        '<p>No plan switch lowers your bill. Time-of-Use would actually cost you <strong>' + signed(a.touDeltaAnnual) + '/year more</strong>, because ' +
        a.peakPct.toFixed(0) + '% of your usage falls in peak hours (8am–midnight). Rate-switching only helps off-peak-heavy homes.</p>';
    } else {
      vHtml = '<h2>Stay on ' + curName + '</h2>' +
        '<div class="big">no eligible switch saves</div>' +
        '<p>Based on your actual usage ' + period + ', none of the plans you\'re eligible to switch to would lower your bill.</p>';
    }

    // plan table — Standard + TOU are precise; demand plans are flagged estimates;
    // ineligible plans stay visible but are marked and excluded from the verdict
    var rows = a.plans.map(function (p) {
      var d = p.cost - a.standardCost;
      var deltaCell = p.current ? '<span class="pill">current</span>'
        : (p.avail === false ? '<span class="pill na">not eligible</span>'
        : '<span class="' + (d > 0 ? "delta-up" : "delta-down") + '">' + signed(d * a.annualFactor) + '/yr</span>');
      var tag = p.demand ? ' <span class="tag">demand-based est. · ' + p.eligibility + '</span>'
        : (p.smartChargeNY && p.smartChargeNY.enabled ? ' <span class="tag">includes SmartCharge NY what-if</span>' : '');
      if (p.avail === false) tag += ' <span class="tag warn">' + p.excludedReason + '</span>';
      if (p.formerly) tag += ' <span class="tag">formerly ' + p.formerly + '</span>';
      var rowClass = p.current ? "current" : (p.avail === false ? "na" : (p.demand ? "est" : ""));
      return '<tr' + (rowClass ? ' class="' + rowClass + '"' : '') + '><td>' + p.name + tag + '</td>' +
        '<td class="num">' + usd(p.cost * a.annualFactor) + '/yr</td><td class="num">' + deltaCell + '</td></tr>';
    }).join("");
    var evTableLine = a.smartChargeNY.enabled
      ? '<tr class="credit"><td>SmartCharge NY off-peak credit <span class="tag">TOU add-on</span></td>' +
        '<td class="num">' + usd(-a.smartChargeNY.credit * a.annualFactor) + '/yr</td>' +
        '<td class="num"><span class="tag">included in TOU</span></td></tr>' : '';
    var demandNote = a.demandOpportunity
      ? '<p class="opp">⚠ Your load looks flat enough that demand-based plans (Steady Use / Smart Energy) come out cheaper in this estimate. But that estimate holds supply flat — ConEd applies time-of-use supply on those plans, which isn\'t published exactly — so treat it as a ballpark worth confirming with ConEd, not a guarantee.</p>'
      : (a.hasDemand ? '<p class="legend">Demand-based plans bill on your peak kW (not total kWh) — ballpark estimates (supply held flat), best for heat-pump / flat-demand homes.</p>'
      : '<p class="legend">Steady Use & Smart Energy aren\'t priced: they bill on peak kW, which only a smart meter\'s hourly interval data can show — and your file has none. ' + (a.profile.meter === "legacy" ? "A traditional meter can't bill on demand at all." : "Export the hourly Green Button data to see them.") + '</p>');
    var evNote = a.smartChargeNY.enabled
      ? '<p class="legend">SmartCharge NY what-if: ' + (R.smartChargeNY.offPeakCredit * 100).toFixed(0) + '¢/kWh for midnight–8am charging is applied to all measured off-peak kWh. Con Edison currently says Residential Time-of-Use customers are not eligible, so verify eligibility before relying on this combined estimate.</p>'
      : '<p class="legend">No separate residential EV rate — residential EVs are priced on the regular plans. Turn on the EV option above to see the SmartCharge NY off-peak incentive scenario.</p>';

    // per-plan eligibility, timing & lock-in notes from the rules engine
    var noteEntries = a.comparison.filter(function (e) { return e.eligibilityNotes && e.eligibilityNotes.length; });
    var notesHtml = noteEntries.length
      ? '<h3 class="sec">Eligibility notes &amp; switching terms</h3><ul class="pnotes">' +
        noteEntries.map(function (e) {
          return '<li><strong>' + e.name + '</strong> — <ul>' +
            e.eligibilityNotes.map(function (n) { return '<li>' + n + '</li>'; }).join("") + '</ul></li>';
        }).join("") + '</ul>'
      : "";

    // load shape
    var pk = a.peakPct, of = 100 - pk;
    var shape = '<div class="shape"><span class="peak" style="width:' + pk + '%">' + pk.toFixed(0) + '% peak</span>' +
      '<span class="off" style="width:' + of + '%">' + of.toFixed(0) + '% off</span></div>' +
      '<p class="legend">Peak = 8am–midnight · Off-peak = midnight–8am. TOU rewards off-peak-heavy usage; it penalizes peak-heavy usage.</p>';

    // The per-period table renders the retained series (one plan throughout →
    // the analysis's own dashboard, unchanged; a recorded plan change → actual
    // priced per segment on the plan that was in effect).
    var st = (M && series) ? M.stitch(series, a, calcOptions())
                           : { dashboard: a.dashboard, switched: false, segments: [] };

    results.innerHTML =
      confidenceBlock(a) +
      (lastBillingNote ? '<p class="legend">' + lastBillingNote + "</p>" : "") +
      '<div class="verdict ' + vClass + '">' + vHtml + '</div>' +
      freePreview(a, paid, curEntry, period) +
      checkoutSection(paid, paymentFlow) +
      '<div class="actions"><button id="share-btn" class="btn-share" type="button">↗ Share this result</button></div>' +
      (stalenessWarning || '') + blockerNote +
      '<div class="stats">' +
        '<div class="stat"><div class="k">Your usage</div><div class="v">' + Math.round(a.totalKwh * a.annualFactor).toLocaleString() + ' kWh/yr</div></div>' +
        '<div class="stat"><div class="k">Current plan (' + curName + ')</div><div class="v">' + usd(curEntry.cost * a.annualFactor) + '/yr</div></div>' +
        '<div class="stat"><div class="k">Best plan</div><div class="v">' + (a.cheapest.short || a.cheapest.name) + '</div></div>' +
      '</div>' +
      (a.eligibility.notes.length ? '<p class="legend">' + a.eligibility.notes.join(' ') + '</p>' : '') +
      (label ? '<p class="legend">Showing: ' + label + '</p>' : '') +
      '<h3 class="sec">Every plan, priced on your usage</h3>' +
      '<table><thead><tr><th>Rate plan</th><th class="num">Annual cost</th><th class="num">vs. Standard</th></tr></thead>' +
      '<tbody>' + rows + evTableLine + '</tbody></table>' + demandNote + evNote + notesHtml +
      '<details class="math"><summary>Show the math — line items on your numbers</summary>' +
        a.plans.map(function (p) { return planMath(p, a.annualFactor); }).join("") +
        '<p class="legend">Rate basis: ' + R.meta.asOf + '</p></details>' +
      '<h3 class="sec">Your load shape (why)</h3>' + shape +
      '<h3 class="sec">Month by month</h3>' + monthlyChart(a.months, a.smartChargeNY.enabled) +
      periodSection(st.dashboard) + billsSection(a) + monitorSection(a, st, opts.recheck) + paidReportSection(a, st);

    // footer assumptions/sources
    $("assumptions").innerHTML = '<strong>Assumptions:</strong> ' + R.meta.basis + ' ' + R.meta.peakWindow + ' ' + R.meta.caveats.join(" ");
    $("sources").innerHTML = '<strong>Sources:</strong> ' + R.meta.sources.map(function (s) { return '<a href="' + s + '" target="_blank" rel="noopener">' + s.replace(/^https?:\/\//, "").split("/")[0] + "</a>"; }).join(" · ");
    var sb = $("share-btn"); if (sb) sb.addEventListener("click", function () { shareCard(a); });
    bindCheckout(a);
    var del = $("monitor-delete");
    if (del) del.addEventListener("click", function () {
      if (!confirm("Delete your stored monitoring history? This removes every retained month and bill summary from this browser, permanently.")) return;
      if (M) M.clear();
      series = null; lastParsed = null; lastBills = []; lastLabel = ""; lastBillingNote = null; monitorNote = null;
      results.hidden = true; results.innerHTML = "";
    });
    results.hidden = false;
    if (!opts.noScroll) results.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // Recheck state is derived after each real calculation and persisted with the
  // local series. The calculation remains useful if storage is unavailable; the
  // warning only says that this result cannot become the next visit's baseline.
  function recordRecheck(a, trigger) {
    if (!M || !series) return null;
    var result = M.recheck(series, a, { trigger: trigger });
    series.recheck = result.state;
    try { M.save(series); }
    catch (e) { monitorNote = "couldn't save the recommendation recheck locally (" + e.message + ") — this alert covers this session only."; }
    return result;
  }

  // Every real import (file or Share My Data) merges into the retained series
  // and the analysis re-runs over the WHOLE history — importing an older export
  // after a newer one extends the window backward instead of replacing it.
  // Hourly detail comes from THIS import only (retention keeps no interval
  // data), so demand-plan pricing covers the freshly imported window and says
  // so everywhere demand plans appear. The sample is demo data: analyzed, never
  // retained.
  function ingestAndRender(parsed, label, source, bills, billingNote) {
    resetPaymentFlow();
    if (M) {
      try {
        series = M.ingest(series || M.blank(), {
          source: source, label: label,
          plan: profileOptions().currentPlan || undefined,
          months: parsed.months || [], bills: bills || [],
          importedAt: Date.now(), profile: profileOptions()
        });
        M.save(series);
        monitorNote = null;
      } catch (e) {
        monitorNote = "couldn't save this import to local storage (" + e.message + ") — the analysis above covers this session only.";
      }
      if (series && series.months.length && series.imports) {
        var rp = M.restoreParsed(series);
        lastParsed = { months: rp.months, hours: parsed.hours || [], ndays: rp.ndays };
        lastBills = rp.bills;                    // retained bill evidence stays live for its own periods
        lastBillingNote = billingNote || null;
      } else {
        lastParsed = parsed; lastBills = bills || []; lastBillingNote = billingNote || null;
      }
    } else {
      lastParsed = parsed; lastBills = bills || []; lastBillingNote = billingNote || null;
    }
    lastLabel = label;
    var analysis = C.analyze(lastParsed, calcOptions());
    var recheck = recordRecheck(analysis, "usage");
    render(analysis, label, { recheck: recheck });
  }

  function handleText(text, label) {
    try { ingestAndRender(C.parse(text), label, "file", [], null); }   // parse() auto-detects CSV vs XML/ESPI
    catch (e) { showError(e.message); }
  }
  function handleFile(f) {
    if (!f) return;
    var rd = new FileReader();
    rd.onerror = function () { showError("could not read the file."); };
    rd.onload = function () {
      var buf = rd.result, u8 = new Uint8Array(buf);
      var isZip = u8[0] === 0x50 && u8[1] === 0x4B && u8[2] === 0x03 && u8[3] === 0x04; // "PK\x03\x04"
      if (isZip) {
        C.unzipCsv(buf).then(function (t) { handleText(t, f.name); }).catch(function (e) { showError(e.message); });
      } else {
        handleText(new TextDecoder().decode(u8), f.name);
      }
    };
    rd.readAsArrayBuffer(f);
  }

  // events
  drop.addEventListener("click", function () { file.click(); });
  drop.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); file.click(); } });
  file.addEventListener("change", function () { handleFile(file.files[0]); });
  ["dragenter", "dragover"].forEach(function (ev) {
    drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add("over"); });
  });
  ["dragleave", "drop"].forEach(function (ev) {
    drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove("over"); });
  });
  drop.addEventListener("drop", function (e) { if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });
  $("sample-btn").addEventListener("click", function () {
    // Track sample button click for analytics funnel — bare name only
    A.track('sample_click');
    var s = window.CONED_SAMPLE;
    resetPaymentFlow();
    lastParsed = { months: s.months, ndays: s.ndays };
    lastBills = []; lastBillingNote = null;    // the sample ships without billing summaries
    lastLabel = s.label;
    render(C.analyze(lastParsed, calcOptions()), s.label);
  });
  if (evToggle) evToggle.addEventListener("change", function () {
    resetPaymentFlow();
    if (lastParsed) {
      var analysis = C.analyze(lastParsed, calcOptions());
      render(analysis, lastLabel, { recheck: recordRecheck(analysis, "settings") });
    }
  });
  // Declared eligibility facts (territory, current plan, meter, solar, ESCO, heat pump) —
  // any change re-runs the rules engine, re-renders, and updates the retained series'
  // stored profile (what monitoring re-declares on a later visit).
  function persistProfile() {
    if (!M || !series) return;
    try { series.profile = profileOptions(); M.save(series); } catch (e) { /* a failed profile write keeps the last saved state */ }
  }
  ["pf-territory", "pf-plan", "pf-meter"].forEach(function (id) {
    var el = $(id); if (el) el.addEventListener("change", function () {
      resetPaymentFlow();
      persistProfile();
      if (lastParsed) {
        var analysis = C.analyze(lastParsed, calcOptions());
        render(analysis, lastLabel, { recheck: recordRecheck(analysis, "profile") });
      }
    });
  });
  ["pf-solar", "pf-esco", "pf-heatpump"].forEach(function (id) {
    var el = $(id); if (el) el.addEventListener("change", function () {
      resetPaymentFlow();
      persistProfile();
      if (lastParsed) {
        var analysis = C.analyze(lastParsed, calcOptions());
        render(analysis, lastLabel, { recheck: recordRecheck(analysis, "profile") });
      }
    });
  });

  // Show version on load (for bug reports)
  var vEl = document.getElementById("version");
  var stalenessWarning = null; // Cache staleness check result
  function showVer() { if (vEl && C.RATES.meta.version) vEl.textContent = "v" + C.RATES.meta.version; }

  // Check if rates are stale (at or beyond 6 months since reviewedThrough)
  function checkStaleness() {
    if (!C.RATES.meta.reviewedThrough || !/^\d{4}-\d{2}-\d{2}$/.test(C.RATES.meta.reviewedThrough)) {
      return '<p class="legend staleness">⚠️ Rate freshness could not be verified — treat this result as directional.</p>';
    }
    var reviewed = new Date(C.RATES.meta.reviewedThrough);
    var now = new Date();
    if (isNaN(reviewed.getTime())) {
      return '<p class="legend staleness">⚠️ Rate freshness could not be verified — treat this result as directional.</p>';
    }
    // Ignore time component; compare dates only
    reviewed.setHours(0, 0, 0, 0);
    now.setHours(0, 0, 0, 0);
    // Calculate month difference
    var months = (now.getFullYear() - reviewed.getFullYear()) * 12 + (now.getMonth() - reviewed.getMonth());
    if (months >= 6) {
      var reviewedStr = C.RATES.meta.reviewedThrough.substring(0, 7); // YYYY-MM format
      return '<p class="legend staleness">⚠️ Rates last verified ' + reviewedStr + ' — may be out of date; treat as directional.</p>';
    }
    return null;
  }

  showVer();
  // Check the baked-in fallback before restoring monitoring history. If the
  // no-store rates.json fetch fails, stale data must still be identified.
  stalenessWarning = checkStaleness();

  // Restore the retained series on load — monitoring is the page's memory. A
  // revisit re-prices every retained month at the current published rates
  // (strategy "Monitoring": rerun the recommendation after rate or load
  // changes) and re-checks the retained bill evidence. No scroll: this is the
  // landing view, not a response to an action.
  if (M) {
    var storedSeries = M.load();
    if (storedSeries && storedSeries.months.length) {
      series = storedSeries;
      var p = storedSeries.profile || {};
      var setSel = function (id, v) { var el = $(id); if (el && v !== undefined && v !== null) el.value = v; };
      setSel("pf-territory", p.territory); setSel("pf-plan", p.currentPlan); setSel("pf-meter", p.meter);
      ["solar", "esco", "heatpump"].forEach(function (k) {
        var el = $("pf-" + k); if (el && p[k] !== undefined && p[k] !== null) el.checked = !!p[k];
      });
      var rp = M.restoreParsed(storedSeries);
      lastParsed = rp;
      lastBills = rp.bills;
      lastBillingNote = null;
      lastLabel = "your retained monitoring history — " + storedSeries.months.length + " months, " +
        (storedSeries.lastImportedAt ? "last updated " + new Date(storedSeries.lastImportedAt).toLocaleDateString() : "imports merged locally");
      var restoredAnalysis = C.analyze(lastParsed, calcOptions());
      render(restoredAnalysis, lastLabel, { noScroll: true,
        recheck: recordRecheck(restoredAnalysis, "revisit") });
    }
  }

  // Optional runtime rate override — editing rates.json updates rates with no code change.
  if (typeof fetch === "function") {
    fetch("rates.json", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j) {
        C.applyRates(j); showVer(); stalenessWarning = checkStaleness();
        if (lastParsed) {
          resetPaymentFlow();
          var analysis = C.analyze(lastParsed, calcOptions());
          render(analysis, lastLabel, { noScroll: true, recheck: recordRecheck(analysis, "rates") });
        }
      } })
      .catch(function () {});
  }

  // ---- Green Button Connect (Share My Data) -------------------------------
  // Link-out authorization, callback handling, and feed retrieval. Pure logic
  // lives in gbc.js (window.ConedGbc); analysis stays in calc.js. The token
  // lives in this tab's sessionStorage only — boundary documented in
  // docs/notes/gbc-data-boundary.md.
  var G = window.ConedGbc;
  var gbcCfg = null, gbcConn = null;

  function gbcStatus(msg, cls) {
    var el = $("gbc-status"); if (!el) return;
    el.textContent = msg || "";
    el.hidden = !msg;
    el.className = "legend gbc-status" + (cls ? " " + cls : "");
  }
  function gbcBusy(b) {
    ["gbc-connect", "gbc-refresh", "gbc-disconnect"].forEach(function (id) {
      var el = $(id); if (el) el.disabled = b;
    });
  }
  function gbcShowConnected(conn) {
    var mins = Math.max(1, Math.round((conn.expiresAt - Date.now()) / 60000));
    gbcStatus("Connected" + (conn.subscriptionId ? " · subscription " + conn.subscriptionId : "") +
      " · authorization expires in ~" + mins + " min · it lives only in this tab.");
    $("gbc-connect").hidden = true;
    $("gbc-refresh").hidden = false;
    $("gbc-disconnect").hidden = false;
  }
  function gbcReset() {
    $("gbc-connect").hidden = false;
    $("gbc-refresh").hidden = true;
    $("gbc-disconnect").hidden = true;
    gbcStatus("");
  }
  function gbcPull(conn) {
    gbcConn = conn;
    gbcBusy(true);
    gbcStatus("Pulling your ConEd interval and billing feeds…", "busy");
    G.refreshFeeds(gbcCfg, conn).then(function (res) {
      gbcBusy(false);
      gbcShowConnected(conn);
      var label = "ConEd account · usage point " + res.usagePointId +
        (res.billingEntries ? " · " + res.billingEntries + " billing summar" + (res.billingEntries === 1 ? "y" : "ies") + " retrieved" : "");
      // A billing feed that wouldn't parse (or summaries with no total) degrades to
      // unverified — say so where the confidence call is shown, never silently.
      // Bills retained from earlier pulls still verify their own periods, so a
      // failed feed this time only means "no new evidence", not "unverified".
      var nbills = (res.bills || []).length + (series && series.bills ? series.bills.length : 0);
      var note = res.billingError
        ? "Your billing history couldn't be read (" + res.billingError + ") — " +
          (nbills ? "the accuracy gate runs on the " + nbills + " already-retained bill summar" + (nbills === 1 ? "y" : "ies") + "."
                  : "this analysis runs without actual-bill verification.")
        : (res.billingIncomplete
          ? res.billingIncomplete + " billing summar" + (res.billingIncomplete === 1 ? "y" : "ies") + " had no usable total and won't be checked."
          : null);
      ingestAndRender(res.parsed, label, "gbc", res.bills || [], note);
    }).catch(function (e) {
      gbcBusy(false);
      gbcStatus(e.message, "bad");
    });
  }
  function gbcStart() {
    if (!gbcCfg) return;
    try {
      var state = G.randomState();
      G.saveState(state);
      location.href = G.authorizeUrl(gbcCfg, state, G.buildRedirectUri(location));
    } catch (e) { gbcStatus(e.message, "bad"); }
  }
  function gbcDisconnect() {
    G.clearConnection();
    gbcConn = null;
    gbcReset();
    gbcStatus("Disconnected — the authorization token was removed from this tab. You can also revoke this app's access any time from your ConEd account's Share My Data settings.", "busy");
  }
  // Returns true if the URL carried an OAuth callback (consumed either way).
  function gbcHandleCallback() {
    var qs = new URLSearchParams(location.search);
    if (!qs.has("code") && !qs.has("error")) return false;
    var expected = G.loadState();
    var cb = G.parseCallback(qs, expected);
    try { history.replaceState(null, "", location.pathname); } catch (e) { /* keep the query */ }
    if (!cb.ok) { gbcStatus(G.friendlyError(cb), "bad"); return true; }
    gbcBusy(true);
    gbcStatus("Exchanging your ConEd authorization for an access token…", "busy");
    G.connect(gbcCfg, cb.code, G.buildRedirectUri(location)).then(function (conn) {
      gbcPull(conn);
    }).catch(function (e) {
      gbcBusy(false);
      gbcStatus(e.message, "bad");
    });
    return true;
  }
  if (G) {
    G.loadConfig().then(function (cfg) {
      gbcCfg = cfg;
      if (!G.isConfigured(cfg)) return;          // feature off — panel stays hidden
      var panel = $("gbc-panel");
      if (!panel) return;
      panel.hidden = false;
      if ($("gbc-provider")) $("gbc-provider").textContent = cfg.providerName;
      $("gbc-connect").addEventListener("click", gbcStart);
      $("gbc-refresh").addEventListener("click", function () { if (gbcConn) gbcPull(gbcConn); });
      $("gbc-disconnect").addEventListener("click", gbcDisconnect);
      if (gbcHandleCallback()) return;
      var saved = G.loadConnection();
      if (saved && G.connectionIsFresh(saved)) {
        gbcConn = saved;
        gbcShowConnected(saved);
      } else if (saved) {
        G.clearConnection();                     // stale token — drop it
        gbcReset();
      }
    }).catch(function () { /* GBC unavailable — file import still works */ });
  }
})();
