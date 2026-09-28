/* ConEd Rate Optimizer — persistent monthly monitoring (no DOM).
   Browser (window.ConedMonitor) + Node (module.exports).
   The store behind docs/product-strategy.md's "Month-over-month experience":
   every import merges into one retained series (newest data wins, revisions
   counted, older months kept), the newest RETENTION_MONTHS monthly buckets are
   the window, and the whole thing lives in this browser's local storage and
   goes nowhere. Retention keeps monthly buckets and bill summaries only — raw
   hourly data, account identifiers, and credentials are never retained, which
   is why a demand-plan counterfactual over past months is reported unpriced
   rather than approximated. Pricing itself stays in calc.js. A derived recheck
   baseline detects decision-changing rates or imports without retaining raw data. */
(function (root) {
  "use strict";

  // calc.js in the browser (loaded before this file); its module in Node.
  var _calc = null;
  function calc() {
    if (_calc) return _calc;
    _calc = root.ConedCalc || (typeof require === "function" ? require("./calc.js") : null);
    if (!_calc) throw new Error("monitor needs calc.js (window.ConedCalc) loaded first");
    return _calc;
  }

  var KEY = "coned-monitor-series-v1";
  var SCHEMA = 1;
  var RETENTION_MONTHS = 36;   // the retention window (docs: "data retention and deletion behavior")
  var PROFILE_KEYS = ["territory", "currentPlan", "meter", "solar", "esco", "heatPump"];
  var PROFILE_ENUMS = {
    territory: ["nyc", "westchester", "outside"],
    currentPlan: ["standard", "tou", "steady", "smart"],
    meter: ["smart", "legacy"]
  };
  var PLANS = ["standard", "tou", "steady", "smart"];
  var SOURCES = ["file", "gbc"];

  function oneOf(value, values) { return values.indexOf(value) >= 0 ? value : null; }

  // The profile is eligibility input, not an arbitrary object supplied by a
  // connector. Keep only the six declared facts and only the values the page
  // can produce. This makes the storage boundary hold even if a future caller
  // accidentally passes the OAuth connection or a provider response through.
  function safeProfile(profile) {
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) return null;
    var out = {};
    PROFILE_KEYS.forEach(function (key) {
      if (key === "solar" || key === "esco" || key === "heatPump") {
        if (typeof profile[key] === "boolean") out[key] = profile[key];
      } else {
        var value = oneOf(profile[key], PROFILE_ENUMS[key]);
        if (value) out[key] = value;
      }
    });
    return Object.keys(out).length ? out : null;
  }

  function safePlan(value) { return oneOf(value, PLANS); }
  function safeSource(value) { return oneOf(value, SOURCES); }
  function safeImportedAt(value, fallback) {
    if (typeof value === "number" && isFinite(value)) return value;
    return typeof fallback === "number" && isFinite(fallback) ? fallback : null;
  }
  function validYm(value) { return typeof value === "string" && /^(\d{4})-(0[1-9]|1[0-2])$/.test(value); }

  // "YYYY-MM" from a month label, a numeric ymd (20250731), or an ISO date string.
  function ymOf(v) {
    if (v === undefined || v === null) return null;
    if (typeof v === "number") {
      var y = Math.floor(v / 10000), mo = Math.floor(v / 100) % 100;
      return y + "-" + (mo < 10 ? "0" + mo : mo);
    }
    var m = /^(\d{4})-(\d{1,2})/.exec(String(v));
    return m ? m[1] + "-" + (m[2].length < 2 ? "0" + m[2] : m[2]) : null;
  }
  function isSummerMo(mo) { return mo === 6 || mo === 7 || mo === 8 || mo === 9; }
  function monthMo(m) {
    if (m.month !== undefined && m.month !== null) return +m.month;
    var p = ymOf(m.ym);
    return p ? +p.slice(5, 7) : 1;
  }

  function defaultStore() {
    try { return typeof localStorage !== "undefined" ? localStorage : null; }
    catch (e) { return null; }   // some privacy modes throw on mere access
  }

  function blank() {
    return { schema: SCHEMA, months: [], bills: [], imports: 0, lastImportedAt: null,
             timeline: [], trimmed: 0, profile: null, recheck: null };
  }

  // Recheck state deliberately contains only derived recommendation metadata and
  // fingerprints. It never stores interval readings, identifiers, or credentials.
  // Keeping this state beside the retained series lets a later visit distinguish a
  // new tariff from a new usage import without any server-side account.
  function stable(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
    return "{" + Object.keys(value).sort().map(function (key) {
      return JSON.stringify(key) + ":" + stable(value[key]);
    }).join(",") + "}";
  }

  function rateFingerprint(rates) {
    var C = calc();
    return stable(rates || C.RATES);
  }

  function usageFingerprint(series) {
    var months = ((series && series.months) || []).map(function (m) {
      return { ym: m.ym, total: m.total, peak: m.peak, off: m.off,
        summer: m.summer, ndays: m.ndays };
    });
    return stable(months);
  }

  function profileFingerprint(profile) {
    return stable(profile || null);
  }

  function currentPlanKey(analysis) {
    if (analysis && analysis.profile && analysis.profile.currentPlan) return analysis.profile.currentPlan;
    var current = (analysis && analysis.plans || []).filter(function (p) { return p.current; })[0];
    return current ? current.key : "standard";
  }

  function planName(analysis, key) {
    if (!key) return null;
    var p = (analysis && analysis.plans || []).filter(function (item) { return item.key === key; })[0];
    return p ? (p.short || p.name) : key;
  }

  function recommendationSnapshot(analysis) {
    analysis = analysis || {};
    var blockers = analysis.eligibility && analysis.eligibility.blockers || [];
    var currentKey = currentPlanKey(analysis);
    var current = (analysis.plans || []).filter(function (p) { return p.key === currentKey; })[0];
    var target = analysis.switchTarget || null;
    var saves = !!target && current && target.cost < current.cost - 0.005;
    var outcome = blockers.length ? "blocked" : saves ? "switch" : target ? "stay" : "no-alternative";
    var targetKey = outcome === "switch" ? target.key : null;
    return {
      outcome: outcome,
      decision: outcome + ":" + (targetKey || currentKey),
      currentPlan: currentKey,
      currentPlanName: planName(analysis, currentKey),
      targetPlan: targetKey,
      targetPlanName: planName(analysis, targetKey),
      annualSavings: outcome === "switch" && isFinite(analysis.savingsIfSwitch)
        ? Math.max(0, analysis.savingsIfSwitch * (analysis.annualFactor || 1)) : 0,
      recommendation: analysis.recommendation || "No recommendation available.",
      blockers: blockers.slice()
    };
  }

  function money(value) {
    return "$" + Math.round(Math.abs(value || 0)).toLocaleString("en-US") + "/year";
  }

  function decisionExplanation(previous, current) {
    if (current.outcome === "switch") {
      if (previous.outcome === "switch" && previous.targetPlan !== current.targetPlan)
        return "The best eligible switch is now " + current.targetPlanName + " instead of " + previous.targetPlanName + ".";
      return current.targetPlanName + " now beats your current " + current.currentPlanName + " plan by about " + money(current.annualSavings) + ".";
    }
    if (previous.outcome === "switch")
      return "No eligible alternative now lowers your bill, so staying on " + current.currentPlanName + " is the better recommendation.";
    if (previous.outcome === "blocked" && current.outcome !== "blocked")
      return "Your account is now eligible for a normal plan comparison.";
    if (current.outcome === "blocked")
      return "The account details now block an actionable recommendation; the comparison is reference-only.";
    if (previous.outcome === "no-alternative" || current.outcome === "no-alternative")
      return "There is no eligible alternative plan to compare with your current plan.";
    return "The recommendation remains a stay decision, but its inputs were rechecked.";
  }

  // Compare a newly analyzed result with the last locally recorded result. The
  // returned state is immutable; callers save it only after the calculation and
  // may display alert when changed is true. A changed recommendation is the only
  // condition that produces an alert — ordinary tariff revisions or imports that
  // leave the decision intact stay quiet.
  function recheck(series, analysis, options) {
    options = options || {};
    var C = calc();
    var previousState = series && series.recheck;
    var previous = previousState && previousState.recommendation;
    var current = recommendationSnapshot(analysis);
    var rates = C.RATES || {};
    var state = {
      version: 1,
      recommendation: current,
      usageFingerprint: usageFingerprint(series),
      profileFingerprint: profileFingerprint(analysis && analysis.profile),
      rateFingerprint: rateFingerprint(rates),
      rateVersion: rates.meta && rates.meta.version || null,
      ratesAsOf: rates.meta && rates.meta.asOf || null,
      checkedAt: options.now || Date.now(),
      trigger: options.trigger || "recheck"
    };
    if (!previous) {
      return { changed: false, initialized: true, alert: null, previous: null,
        current: current, state: state, rateChanged: false, usageChanged: false, profileChanged: false };
    }

    var rateChanged = previousState.rateFingerprint !== state.rateFingerprint;
    var usageChanged = previousState.usageFingerprint !== state.usageFingerprint;
    var profileChanged = previousState.profileFingerprint !== state.profileFingerprint;
    var recommendationChanged = previous.decision !== current.decision;
    var reasons = [];
    if (rateChanged) {
      var oldVersion = previousState.rateVersion || "the previous version";
      var newVersion = state.rateVersion || "the current version";
      reasons.push({ code: "rates", text: "Published rate data changed (" + oldVersion + " → " + newVersion + ")." });
    }
    if (usageChanged) reasons.push({ code: "usage", text: "New or revised usage data changed the load profile." });
    if (profileChanged) reasons.push({ code: "profile", text: "Your declared account or eligibility details changed." });
    if (recommendationChanged && !reasons.length) {
      reasons.push({ code: "inputs", text: "The inputs used for the recommendation changed." });
    }
    var changed = recommendationChanged;
    var alert = null;
    if (changed) {
      alert = {
        title: "Your rate recommendation changed",
        message: "It changed from “" + previous.recommendation + "” to “" + current.recommendation + "”. " +
          decisionExplanation(previous, current),
        reasons: reasons.map(function (r) { return r.text; }),
        reasonCodes: reasons.map(function (r) { return r.code; })
      };
    }
    return { changed: changed, initialized: false, alert: alert, previous: previous,
      current: current, state: state, reasons: reasons, rateChanged: rateChanged,
      usageChanged: usageChanged, profileChanged: profileChanged };
  }

  // One import (a file the user dropped or a Share My Data pull) merged into the
  // series. Overlapping months/bills take the NEWEST data and count a revision
  // (strategy: "preserve revisions"); months the import doesn't cover stand as
  // measured, so importing an older export extends the window backward instead
  // of erasing it. The declared plan (rec.plan) records a dated switch in the
  // timeline when it differs from the plan in effect. Returns the new series.
  function ingest(series, rec) {
    rec = rec || {};
    var base = series && series.schema === SCHEMA ? series : blank();
    var s = {
      schema: SCHEMA,
      months: (base.months || []).slice(),
      bills: (base.bills || []).slice(),
      imports: (base.imports || 0) + 1,
      lastImportedAt: safeImportedAt(rec.importedAt, base.lastImportedAt),
      timeline: (base.timeline || []).slice(),
      trimmed: base.trimmed || 0,
      profile: safeProfile(rec.profile) || safeProfile(base.profile),
      recheck: base.recheck || null
    };

    // Months: newest-wins merge on the "YYYY-MM" bucket, revisions counted.
    var byYm = {};
    s.months.forEach(function (m) { byYm[m.ym] = m; });
    (rec.months || []).forEach(function (m) {
      if (!m || !validYm(m.ym) || typeof m.total !== "number") return;
      var fresh = { ym: m.ym, month: monthMo(m), total: m.total, peak: m.peak || 0, off: m.off || 0,
                    summer: m.summer !== undefined && m.summer !== null ? !!m.summer : isSummerMo(monthMo(m)),
                    ndays: m.ndays };
      if (byYm[m.ym]) {
        fresh.revisions = (byYm[m.ym].revisions || 0) + 1;
        s.months[s.months.indexOf(byYm[m.ym])] = fresh;   // replace in place, order unchanged
      } else {
        s.months.push(fresh);
      }
      byYm[m.ym] = fresh;
    });
    s.months.sort(function (a, b) { return a.ym < b.ym ? -1 : a.ym > b.ym ? 1 : 0; });

    // Bill summaries: keyed by their period label, a revised bill replaces its
    // earlier self; summaries are the accuracy gate's evidence, so they persist
    // with their period, not with the import that carried them.
    var billKey = function (b) { return b.label || (b.ymdStart + ".." + b.ymdEnd); };
    var byLabel = {};
    s.bills.forEach(function (b) { byLabel[billKey(b)] = b; });
    (rec.bills || []).forEach(function (b) {
      if (!b) return;
      var fresh = { start: b.start, end: b.end, days: b.days, ymdStart: b.ymdStart, ymdEnd: b.ymdEnd,
                    cost: b.cost, currency: b.currency || "USD", label: b.label || "" };
      var k = billKey(fresh);
      if (byLabel[k]) {
        fresh.revisions = (byLabel[k].revisions || 0) + 1;
        s.bills[s.bills.indexOf(byLabel[k])] = fresh;
      } else {
        s.bills.push(fresh);
      }
      byLabel[k] = fresh;
    });

    // The plan timeline: a declaration is dated to the earliest month the
    // declaring import covered (a pull that carries no usage runs from the
    // import month), and a declaration matching the plan already in effect
    // records nothing.
    var declaredPlan = safePlan(rec.plan);
    if (declaredPlan) {
      var from = (rec.months || []).reduce(function (min, m) {
        return m && validYm(m.ym) && (!min || m.ym < min) ? m.ym : min;
      }, null) || ymOf(rec.importedAt);
      if (validYm(from) && planFor(s, from) !== declaredPlan)
        s.timeline.push({ from: from, plan: declaredPlan, source: safeSource(rec.source), at: safeImportedAt(rec.importedAt, null) });
      s.timeline.sort(function (a, b) { return a.from < b.from ? -1 : a.from > b.from ? 1 : 0; });
    }

    // Retention: the newest RETENTION_MONTHS buckets are the window; older ones
    // age out (counted, reported) and bills that end before the window go with
    // them — their periods are no longer part of the monitored history.
    if (s.months.length > RETENTION_MONTHS) {
      s.trimmed += s.months.length - RETENTION_MONTHS;
      s.months = s.months.slice(s.months.length - RETENTION_MONTHS);
    }
    var oldest = s.months.length ? s.months[0].ym : null;
    if (oldest) s.bills = s.bills.filter(function (b) {
      var end = ymOf(b.ymdEnd);
      return end === null || end >= oldest;
    });

    return s;
  }

  // The plan in effect for a month: the latest timeline entry dated at or
  // before it, or Standard — the baseline every series starts on.
  function planFor(series, ym) {
    var plan = null, t = (series && series.timeline) || [];
    for (var i = 0; i < t.length; i++) if (t[i].from <= ym) plan = t[i].plan;
    return plan || "standard";
  }

  // Contiguous same-plan runs over the retained months — the periods each plan
  // was actually in effect, which the stitched dashboard prices separately.
  function segments(series) {
    var out = [];
    ((series && series.months) || []).forEach(function (m) {
      var p = planFor(series, m.ym);
      var last = out[out.length - 1];
      if (last && last.plan === p) last.yms.push(m.ym);
      else out.push({ plan: p, yms: [m.ym] });
    });
    return out;
  }

  // The stored series as analyze() input: monthly buckets only (retention keeps
  // no interval data), ndays summed from the buckets' observed days, and the
  // retained bill evidence attached so the accuracy gate keeps checking its own
  // periods on a later visit.
  function restoreParsed(series) {
    var months = ((series && series.months) || []).map(function (m) {
      var mo = monthMo(m);
      return { ym: m.ym, month: mo, total: m.total, peak: m.peak, off: m.off,
               summer: m.summer !== undefined && m.summer !== null ? !!m.summer : isSummerMo(mo),
               ndays: m.ndays };
    });
    return {
      months: months, hours: [],
      ndays: months.reduce(function (a, m) { return a + (m.ndays || 0); }, 0),
      bills: ((series && series.bills) || []).slice()
    };
  }

  // The month's actual charge on a given plan. Standard reconstructs from the
  // published bill history (periodDashboard's basis for Standard actuals); the
  // other plans price on the plan's own model. Demand plans return null without
  // that month's hours — unpriced, never approximated from the monthly bucket.
  function priceActual(p, plan, options) {
    var C = calc();
    var ym = /^(\d{4})-/.exec(String(p.ym));
    if (plan === "standard" && ym) {
      try {
        var rec = C.reconstructBill({ kwh: p.kwh, year: +ym[1] });
        return { plan: "standard", total: rec.total, fixed: rec.components.customerCharge,
                 variable: rec.total - rec.components.customerCharge, reconstructed: rec };
      } catch (e) { /* fall through to the model */ }
    }
    return C.pricePeriod(p, plan, options);
  }

  // The persistent dashboard. One plan throughout → the analysis's own
  // dashboard, untouched. A recorded switch → every segment's actual is priced
  // on the plan that was in effect that month and stitched into one table, so
  // the cumulative actual-vs-best answer covers the real history rather than
  // pretending the current plan billed all of it. Best stays the per-period
  // cheapest eligible plan at current published rates either way.
  function stitch(series, analysis, options) {
    var segs = segments(series);
    if (!analysis || !analysis.dashboard || segs.length <= 1)
      return { dashboard: analysis ? analysis.dashboard : null, switched: false, segments: segs };
    var C = calc();
    options = options || {};
    var periods = C.periodsFrom({ months: series.months, hours: [] });
    var aRows = analysis.dashboard.rows || [];
    var rows = [], actualTotal = 0, bestTotal = 0;
    periods.forEach(function (p, i) {
      var plan = planFor(series, p.ym);
      var prev = rows.length ? rows[rows.length - 1] : null;
      var aRow = aRows[i] || null;
      var actual = priceActual(p, plan, options);
      var mom = prev && prev.actual && actual ? C.decomposeChange(
        { kwh: prev.kwh, days: prev.days, total: prev.actual.total, fixed: prev.actual.fixed },
        { kwh: p.kwh, days: p.days, total: actual.total, fixed: actual.fixed }) : null;
      var calendarDays = C.daysInMonth(p.ym);
      var row = {
        ym: p.ym, days: p.days, observedDays: p.observedDays, calendarDays: calendarDays,
        kwh: p.kwh || 0, peakPct: p.kwh ? p.peakKwh / p.kwh * 100 : 0,
        partial: !!(p.observedDays && p.observedDays < 0.8 * calendarDays),
        actual: actual, best: aRow ? aRow.best : null, bestKey: aRow ? aRow.bestKey : null,
        difference: actual && aRow && aRow.best ? actual.total - aRow.best.total : null,
        mom: mom, rateDriver: null,
        projected: aRow ? !!aRow.projected : false,
        prevDays: prev ? prev.days : null, prevPeakPct: prev ? prev.peakPct : null
      };
      if (prev && plan !== planFor(series, prev.ym)) row.planSwitch = plan;
      rows.push(row);
      if (actual) actualTotal += actual.total;
      if (row.best) bestTotal += row.best.total;
    });
    return {
      dashboard: {
        currentPlan: analysis.dashboard.currentPlan, rows: rows,
        actualTotal: actualTotal, bestTotal: bestTotal, difference: actualTotal - bestTotal,
        partialCount: rows.filter(function (r) { return r.partial; }).length,
        esco: analysis.dashboard.esco
      },
      switched: true, segments: segs
    };
  }

  // "How much has the switch actually saved?" — the counterfactual you didn't
  // live: the prior plan's price of every post-switch month minus what those
  // months actually cost. Null savings with the unpriced months named when
  // either side can't be priced from retained data (a demand-plan counterfactual
  // needs hourly data retention doesn't keep) — never an approximation.
  function realized(series, st, analysis, options) {
    if (!st || !st.switched || !st.dashboard || !st.dashboard.rows) return null;
    var t = (series && series.timeline) || [];
    if (!t.length) return null;
    var sw = t[t.length - 1];
    var C = calc();
    options = options || {};
    var priorPlan = "standard";
    for (var i = 0; i < t.length - 1; i++) if (t[i].from < sw.from) priorPlan = t[i].plan;
    var monthsByYm = {};
    ((series && series.months) || []).forEach(function (m) { monthsByYm[m.ym] = m; });
    var post = st.dashboard.rows.filter(function (r) { return sw.from <= r.ym; });
    if (!post.length) return null;
    var counterfactual = 0, actualTotal = 0, unpriced = [];
    post.forEach(function (r) {
      var m = monthsByYm[r.ym];
      var prior = m ? C.pricePeriod(C.periodsFrom({ months: [m], hours: [] })[0], priorPlan, options) : null;
      if (!prior || !r.actual) { unpriced.push(r.ym); return; }
      counterfactual += prior.total;
      actualTotal += r.actual.total;
    });
    var out = { plan: sw.plan, priorPlan: priorPlan, from: sw.from, months: post.length,
                savings: unpriced.length ? null : counterfactual - actualTotal };
    if (unpriced.length) out.unpriced = unpriced;
    return out;
  }

  // ---- the storage contract ------------------------------------------------
  // save() persists the series to local storage and THROWS when no storage is
  // available — the caller must be able to say so rather than lose an import
  // silently. load() reads it back: no stored series reads as null (nothing to
  // restore), and anything unreadable — corrupt JSON, another schema version, a
  // malformed month list — starts fresh rather than crashing the page. clear()
  // removes the whole series: permanent, immediate, one key.
  function save(series, store) {
    var st = store === undefined ? defaultStore() : store;
    if (!st) throw new Error("no local storage available");
    st.setItem(KEY, JSON.stringify(series));
  }
  function freshSeries() { return blank(); }
  function load(store) {
    var st = store === undefined ? defaultStore() : store;
    if (!st) return null;
    var raw = null;
    try { raw = st.getItem(KEY); } catch (e) { return null; }
    if (raw === null || raw === undefined) return null;
    var s = freshSeries();
    try {
      var obj = JSON.parse(raw);
      if (!obj || obj.schema !== SCHEMA || !Array.isArray(obj.months)) return s;
      s.months = obj.months.filter(function (m) {
        return m && validYm(m.ym) && typeof m.total === "number";
      });
      if (Array.isArray(obj.bills)) s.bills = obj.bills.filter(function (b) { return !!b; });
      if (typeof obj.imports === "number") s.imports = obj.imports;
      s.lastImportedAt = safeImportedAt(obj.lastImportedAt, null);
      if (Array.isArray(obj.timeline)) s.timeline = obj.timeline.filter(function (e) {
        return e && validYm(e.from) && !!safePlan(e.plan);
      });
      if (typeof obj.trimmed === "number") s.trimmed = obj.trimmed;
      if (obj.profile && typeof obj.profile === "object") s.profile = safeProfile(obj.profile);
      if (obj.recheck && typeof obj.recheck === "object" && obj.recheck.recommendation) s.recheck = obj.recheck;
      return s;
    } catch (e) {
      return s;   // corrupt stored JSON starts fresh
    }
  }
  function clear(store) {
    var st = store === undefined ? defaultStore() : store;
    if (st) { try { st.removeItem(KEY); } catch (e) { /* nothing to remove worth crashing over */ } }
  }

  var api = { KEY: KEY, SCHEMA: SCHEMA, RETENTION_MONTHS: RETENTION_MONTHS,
              blank: blank, ingest: ingest, planFor: planFor, segments: segments,
              restoreParsed: restoreParsed, stitch: stitch, realized: realized,
              rateFingerprint: rateFingerprint, recommendationSnapshot: recommendationSnapshot,
              recheck: recheck,
              save: save, load: load, clear: clear };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ConedMonitor = api;
})(typeof window !== "undefined" ? window : globalThis);
