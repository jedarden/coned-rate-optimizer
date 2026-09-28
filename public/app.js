/* ConEd Rate Optimizer — DOM glue. Uses window.ConedCalc (calc.js). */
(function () {
  "use strict";
  var C = window.ConedCalc, R = C.RATES;
  // The analytics choke point (analytics.js) — inert stub if it failed to load.
  var A = window.ConedAnalytics || { track: function () {} };
  var $ = function (id) { return document.getElementById(id); };
  var drop = $("drop"), file = $("file"), err = $("error"), results = $("results");
  var evToggle = $("ev-toggle"), lastParsed = null, lastLabel = "", lastBills = [], lastBillingNote = null;

  var usd = function (n) { return (n < 0 ? "−" : "") + "$" + Math.abs(Math.round(n)).toLocaleString("en-US"); };
  var usd2 = function (n) { return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  var signed = function (n) {
    var r = Math.round(n);
    return (r === 0 ? "" : n >= 0 ? "+" : "−") + "$" + Math.abs(r).toLocaleString("en-US");
  };

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

  function render(a, label) {
    err.hidden = true;
    // Track successful parse for analytics funnel — bare name only
    A.track('parse_success');
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

    results.innerHTML =
      confidenceBlock(a) +
      (lastBillingNote ? '<p class="legend">' + lastBillingNote + "</p>" : "") +
      '<div class="verdict ' + vClass + '">' + vHtml + '</div>' +
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
      periodSection(a.dashboard) + billsSection(a);

    // footer assumptions/sources
    $("assumptions").innerHTML = '<strong>Assumptions:</strong> ' + R.meta.basis + ' ' + R.meta.peakWindow + ' ' + R.meta.caveats.join(" ");
    $("sources").innerHTML = '<strong>Sources:</strong> ' + R.meta.sources.map(function (s) { return '<a href="' + s + '" target="_blank" rel="noopener">' + s.replace(/^https?:\/\//, "").split("/")[0] + "</a>"; }).join(" · ");
    var sb = $("share-btn"); if (sb) sb.addEventListener("click", function () { shareCard(a); });
    results.hidden = false;
    results.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function handleText(text, label) {
    try {
      lastParsed = C.parse(text);
      lastBills = []; lastBillingNote = null;   // a file import carries no billing feed — drop any connected-account bills
      lastLabel = label;
      render(C.analyze(lastParsed, calcOptions()), label);
    }   // parse() auto-detects CSV vs XML/ESPI
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
    lastParsed = { months: s.months, ndays: s.ndays };
    lastBills = []; lastBillingNote = null;    // the sample ships without billing summaries
    lastLabel = s.label;
    render(C.analyze(lastParsed, calcOptions()), s.label);
  });
  if (evToggle) evToggle.addEventListener("change", function () {
    if (lastParsed) render(C.analyze(lastParsed, calcOptions()), lastLabel);
  });
  // Declared eligibility facts (territory, current plan, meter, solar, ESCO, heat pump) —
  // any change re-runs the rules engine and re-renders.
  ["pf-territory", "pf-plan", "pf-meter"].forEach(function (id) {
    var el = $(id); if (el) el.addEventListener("change", function () {
      if (lastParsed) render(C.analyze(lastParsed, calcOptions()), lastLabel);
    });
  });
  ["pf-solar", "pf-esco", "pf-heatpump"].forEach(function (id) {
    var el = $(id); if (el) el.addEventListener("change", function () {
      if (lastParsed) render(C.analyze(lastParsed, calcOptions()), lastLabel);
    });
  });

  // Show version on load (for bug reports)
  var vEl = document.getElementById("version");
  var stalenessWarning = null; // Cache staleness check result
  function showVer() { if (vEl && C.RATES.meta.version) vEl.textContent = "v" + C.RATES.meta.version; }

  // Check if rates are stale (>6 months since reviewedThrough date)
  function checkStaleness() {
    if (!C.RATES.meta.reviewedThrough) return null;
    var reviewed = new Date(C.RATES.meta.reviewedThrough);
    var now = new Date();
    // Ignore time component; compare dates only
    reviewed.setHours(0, 0, 0, 0);
    now.setHours(0, 0, 0, 0);
    // Calculate month difference
    var months = (now.getFullYear() - reviewed.getFullYear()) * 12 + (now.getMonth() - reviewed.getMonth());
    if (months > 6) {
      var reviewedStr = C.RATES.meta.reviewedThrough.substring(0, 7); // YYYY-MM format
      return '<p class="legend staleness">⚠️ Rates last verified ' + reviewedStr + ' — may be out of date; treat as directional.</p>';
    }
    return null;
  }

  showVer();

  // Optional runtime rate override — editing rates.json updates rates with no code change.
  if (typeof fetch === "function") {
    fetch("rates.json", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j) { C.applyRates(j); showVer(); stalenessWarning = checkStaleness(); } })
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
      lastParsed = res.parsed;
      lastBills = res.bills || [];
      // A billing feed that wouldn't parse (or summaries with no total) degrades to
      // unverified — say so where the confidence call is shown, never silently.
      lastBillingNote = res.billingError
        ? "Your billing history couldn't be read (" + res.billingError + ") — this analysis runs without actual-bill verification."
        : (res.billingIncomplete
          ? res.billingIncomplete + " billing summar" + (res.billingIncomplete === 1 ? "y" : "ies") + " had no usable total and won't be checked."
          : null);
      lastLabel = label;
      render(C.analyze(lastParsed, calcOptions()), label);
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
