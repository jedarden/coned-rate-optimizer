/* ConEd Rate Optimizer — pure calculation core (no DOM).
   Works in the browser (window.ConedCalc) and Node (module.exports) for testing.

   Rate model: Con Edison SC1 (Rate I) — NYC Residential.
   All ¢/kWh are expressed as $/kWh. Standard components are ConEd's published
   2025 average, grossed up for GRT + sales tax, EXCLUDING the fixed customer charge.
   TOU supply rates are ConEd's current published Residential Time-of-Use supply,
   grossed to be comparable with the tax-grossed standard commodity.
   Sources + caveats in RATES.meta. */
(function (root) {
  "use strict";

  var RATES = {
    meta: {
      utility: "Con Edison",
      serviceClass: "SC1 (Rate I) — NYC Residential",
      basis: "Standard = ConEd 2025 published SC1 NYC average (grossed up for GRT + sales tax, excl. customer charge). TOU supply = ConEd current published residential TOU supply.",
      updated: "2026-07",
      peakWindow: "Peak 8:00am–midnight; Off-peak midnight–8:00am (super-peak summer weekdays 2–6pm folded into peak).",
      caveats: [
        "Absolute totals ±~5% (monthly Market Supply Charge varies; 2026 months priced at 2025 rates).",
        "Assumes delivery + MAC + RDM + surcharges are identical under Standard and TOU (only supply is time-differentiated).",
        "Super-peak folded into peak (makes TOU look slightly BETTER than reality).",
        "Estimate only — not affiliated with Con Edison. Verify against your actual bill."
      ],
      sources: [
        "https://www.coned.com/en/accounts-billing/your-bill/time-of-use",
        "https://www.coned.com/-/media/files/coned/documents/save-energy-money/using-private-generation/historical-average-full-service-electric-rates.pdf",
        "https://www.coned.com/en/accounts-billing/your-bill/your-guide-to-rates"
      ]
    },
    peakStartHour: 8,          // peak = [8, 24); off-peak = [0, 8)
    summerMonths: [6, 7, 8, 9],
    standard: {
      name: "Standard Residential",
      allIn: 0.338267,         // delivery 0.183233 + commodity 0.137533 + MAC 0.008133 + RDM 0.002867 + surch 0.0065
      commodity: 0.137533,
      customer: 16.33
    },
    tou: {
      name: "Residential Time-of-Use",
      nonCommodity: 0.338267 - 0.137533,   // = 0.200734 (delivery+MAC+RDM+surch, tax-grossed)
      offPeak: 0.0522,
      peakSummer: 0.2786,
      peakWinter: 0.1711,
      gross: 1.10,             // gross TOU supply to match tax-grossed standard commodity
      customer: 21.00
    },
    // Variants exist but need eligibility / are TOU-mechanically equivalent; listed, not independently priced.
    variants: [
      { name: "EV Time-of-Use", note: "Same TOU mechanics + 1-yr price-match guarantee; for EV owners." },
      { name: "Steady Use Rate", note: "For heat-pump homes held at steady temperature; requires eligibility." },
      { name: "Smart Energy Billing", note: "Demand-response rewards for shifting off-peak; requires enrollment." }
    ]
  };

  function isSummer(month) { return RATES.summerMonths.indexOf(month) !== -1; }

  // Quote-aware field splitter (handles "quoted, fields" and "" escapes).
  function splitRow(line, delim) {
    var out = [], cur = "", q = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (q) {
        if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += ch;
      } else if (ch === '"') { q = true; }
      else if (ch === delim) { out.push(cur); cur = ""; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  }

  function detectDelim(line) {
    var best = ",", bestN = 0;
    ["\t", ",", ";"].forEach(function (d) {
      var n = line.split(d).length - 1;
      if (n > bestN) { bestN = n; best = d; }
    });
    return best;
  }

  // Hour-of-day from "0:00", "13:45", "1:00 AM", "01:00:00 PM".
  function toHour(s) {
    s = String(s).replace(/"/g, "").trim();
    if (!s) return null;
    var ampm = /(am|pm)\.?$/i.exec(s);
    var h = parseInt(s.split(":")[0], 10);
    if (isNaN(h)) return null;
    if (ampm) {
      var pm = /pm/i.test(ampm[1]);
      if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12;
    }
    return (h >= 0 && h <= 23) ? h : null;
  }

  // Date from ISO (2025-06-10), US slash (6/10/2025), or M-D-Y. Drops any time part.
  function parseDate(s) {
    s = String(s).replace(/"/g, "").trim().split(/[ T]/)[0];
    var m;
    if ((m = /^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/.exec(s))) return { y: +m[1], mo: +m[2], d: +m[3] };
    if ((m = /^(\d{1,2})[-\/](\d{1,2})[-\/](\d{2,4})$/.exec(s))) {
      var y = +m[3]; if (y < 100) y += 2000; return { y: y, mo: +m[1], d: +m[2] };
    }
    return null;
  }

  // Parse a ConEd Green Button "Download my data" CSV/TSV into monthly buckets.
  function parseGreenButton(text) {
    text = String(text).replace(/^﻿/, "").replace(/\r/g, "");
    var lines = text.split("\n");
    var hi = -1;
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i].toLowerCase();
      if ((l.indexOf("usage") !== -1 || l.indexOf("kwh") !== -1) &&
          (l.indexOf("date") !== -1 || l.indexOf("start") !== -1 || l.indexOf("time") !== -1)) { hi = i; break; }
    }
    if (hi === -1)
      throw new Error("couldn't find the data header — make sure this is the ConEd electric “Download my data” CSV (with DATE, START TIME, and USAGE columns).");

    var delim = detectDelim(lines[hi]);
    var header = splitRow(lines[hi], delim).map(function (c) { return c.replace(/"/g, "").trim().toLowerCase(); });
    function findCol(pred) { for (var j = 0; j < header.length; j++) if (pred(header[j])) return j; return -1; }
    var cDate = findCol(function (c) { return c === "date" || (c.indexOf("date") !== -1 && c.indexOf("end") === -1); });
    var cStart = findCol(function (c) { return c.indexOf("start") !== -1; });
    if (cStart === -1) cStart = findCol(function (c) { return c.indexOf("time") !== -1 && c.indexOf("end") === -1; });
    var cUse = findCol(function (c) { return (c.indexOf("usage") !== -1 || c.indexOf("kwh") !== -1) && c.indexOf("cost") === -1 && c.indexOf("$") === -1; });
    if (cDate === -1 || cStart === -1 || cUse === -1)
      throw new Error("this file is missing a DATE, START TIME, or USAGE (kWh) column — it may be a gas or billing export rather than the electric interval data.");

    var months = {}, days = {}, minD = null, maxD = null, rowN = 0, seenRows = 0, maxCol = Math.max(cDate, cStart, cUse);
    for (var r = hi + 1; r < lines.length; r++) {
      if (!lines[r].trim()) continue;
      var cells = splitRow(lines[r], delim);
      if (cells.length <= maxCol) continue;
      seenRows++;
      var d = parseDate(cells[cDate]);
      var kwh = parseFloat(String(cells[cUse]).replace(/[^0-9.\-]/g, ""));
      var hr = toHour(cells[cStart]);
      if (!d || isNaN(kwh) || hr === null) continue;
      var key = d.y + "-" + (d.mo < 10 ? "0" + d.mo : d.mo);
      if (!months[key]) months[key] = { ym: key, month: d.mo, total: 0, peak: 0, off: 0, summer: isSummer(d.mo) };
      var b = months[key];
      b.total += kwh;
      if (hr < RATES.peakStartHour) b.off += kwh; else b.peak += kwh;
      days[d.y + "-" + d.mo + "-" + d.d] = 1;
      var t = d.y * 10000 + d.mo * 100 + d.d;
      if (minD === null || t < minD) minD = t;
      if (maxD === null || t > maxD) maxD = t;
      rowN++;
    }
    if (rowN === 0) {
      if (seenRows > 0)
        throw new Error("found the table but couldn't read the date/time/kWh values — the format looks unexpected. Send me the first few lines and I'll add support.");
      throw new Error("no data rows found under the header — is this the interval export (15-min or hourly), not a daily/monthly summary?");
    }
    var arr = Object.keys(months).sort().map(function (k) { return months[k]; });
    return { months: arr, ndays: Object.keys(days).length, intervals: rowN, minDate: minD, maxDate: maxD };
  }

  function costStandard(months) {
    var v = 0, cust = 0;
    months.forEach(function (m) { v += m.total * RATES.standard.allIn; cust += RATES.standard.customer; });
    return v + cust;
  }
  function costTOU(months) {
    var noncomm = 0, supply = 0, cust = 0;
    months.forEach(function (m) {
      noncomm += m.total * RATES.tou.nonCommodity;
      var pr = m.summer ? RATES.tou.peakSummer : RATES.tou.peakWinter;
      supply += m.peak * pr + m.off * RATES.tou.offPeak;
      cust += RATES.tou.customer;
    });
    return noncomm + supply * RATES.tou.gross + cust;
  }

  // Analyze a parsed dataset (or a bare months array). Returns plan costs + verdict.
  function analyze(parsed) {
    var months = parsed.months ? parsed.months : parsed;
    var ndays = parsed.ndays || 365;
    var totals = months.reduce(function (a, m) {
      a.total += m.total; a.peak += m.peak; a.off += m.off; return a;
    }, { total: 0, peak: 0, off: 0 });
    var factor = (ndays >= 350 && ndays <= 385) ? 1 : (ndays > 0 ? 365 / ndays : 1);
    var std = costStandard(months), tou = costTOU(months);
    var plans = [
      { key: "standard", name: RATES.standard.name, cost: std, current: true },
      { key: "tou", name: RATES.tou.name, cost: tou }
    ];
    var cheapest = plans.reduce(function (a, b) { return b.cost < a.cost ? b : a; });
    return {
      ndays: ndays, annualFactor: factor,
      totalKwh: totals.total, peakKwh: totals.peak, offKwh: totals.off,
      peakPct: totals.total ? totals.peak / totals.total * 100 : 0,
      months: months, plans: plans, cheapest: cheapest,
      standardCost: std, touCost: tou,
      standardAnnual: std * factor, touAnnual: tou * factor,
      touDelta: tou - std, touDeltaAnnual: (tou - std) * factor,
      savingsIfSwitch: std - cheapest.cost,   // positive = switching saves
      recommendation: cheapest.key === "standard"
        ? "Stay on Standard — no plan switch lowers your bill."
        : "Switch to " + cheapest.name + " to save."
    };
  }

  var api = { RATES: RATES, parseGreenButton: parseGreenButton, costStandard: costStandard, costTOU: costTOU, analyze: analyze };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ConedCalc = api;
})(typeof window !== "undefined" ? window : globalThis);
