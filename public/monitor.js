/* ConEd Rate Optimizer — persistent monthly monitoring (no DOM).
   Browser (window.ConedMonitor) + Node (module.exports).
   The store behind docs/product-strategy.md's "Month-over-month experience":
   every import merges into one retained series (newest data wins, revisions
   counted, older months kept), the newest RETENTION_MONTHS monthly buckets are
   the window, and the whole thing lives in this browser's local storage and
   goes nowhere. Retention keeps monthly buckets and bill summaries only — raw
   hourly data, account identifiers, and credentials are never retained, which
   is why a demand-plan counterfactual over past months is reported unpriced
   rather than approximated. Pricing itself stays in calc.js. */
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
             timeline: [], trimmed: 0, profile: null };
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
      lastImportedAt: rec.importedAt || base.lastImportedAt || null,
      timeline: (base.timeline || []).slice(),
      trimmed: base.trimmed || 0,
      profile: rec.profile || base.profile || null
    };

    // Months: newest-wins merge on the "YYYY-MM" bucket, revisions counted.
    var byYm = {};
    s.months.forEach(function (m) { byYm[m.ym] = m; });
    (rec.months || []).forEach(function (m) {
      if (!m || !m.ym || typeof m.total !== "number") return;
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
    if (rec.plan) {
      var from = (rec.months || []).reduce(function (min, m) {
        return m && m.ym && (!min || m.ym < min) ? m.ym : min;
      }, null) || ymOf(rec.importedAt);
      if (from && planFor(s, from) !== rec.plan)
        s.timeline.push({ from: from, plan: rec.plan, source: rec.source || null, at: rec.importedAt || null });
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
        return m && typeof m.ym === "string" && typeof m.total === "number";
      });
      if (Array.isArray(obj.bills)) s.bills = obj.bills.filter(function (b) { return !!b; });
      if (typeof obj.imports === "number") s.imports = obj.imports;
      if (obj.lastImportedAt) s.lastImportedAt = obj.lastImportedAt;
      if (Array.isArray(obj.timeline)) s.timeline = obj.timeline.filter(function (e) {
        return e && typeof e.from === "string" && typeof e.plan === "string";
      });
      if (typeof obj.trimmed === "number") s.trimmed = obj.trimmed;
      if (obj.profile && typeof obj.profile === "object") s.profile = obj.profile;
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
              save: save, load: load, clear: clear };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ConedMonitor = api;
})(typeof window !== "undefined" ? window : globalThis);
