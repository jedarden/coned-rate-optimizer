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

  function toHour(s) {
    s = String(s).trim();
    var ampm = /(am|pm)$/i.exec(s);
    var h = parseInt(s.split(":")[0], 10);
    if (isNaN(h)) return null;
    if (ampm) {
      var pm = /pm/i.test(ampm[1]);
      if (h === 12) h = pm ? 12 : 0;
      else if (pm) h += 12;
    }
    return h;
  }

  // Parse a ConEd Green Button "Download my data" CSV/TSV into monthly buckets.
  function parseGreenButton(text) {
    var lines = String(text).replace(/\r/g, "").split("\n");
    var hi = -1, delim = ",";
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i].toLowerCase();
      if (l.indexOf("usage") !== -1 && (l.indexOf("date") !== -1 || l.indexOf("start") !== -1)) { hi = i; break; }
    }
    if (hi === -1) throw new Error("Could not find a Green Button header row (needs a USAGE column).");
    delim = lines[hi].indexOf("\t") !== -1 ? "\t" : ",";
    var header = lines[hi].split(delim).map(function (c) { return c.trim().toLowerCase(); });
    function findCol(pred) { for (var j = 0; j < header.length; j++) if (pred(header[j])) return j; return -1; }
    var cDate = findCol(function (c) { return c === "date" || (c.indexOf("date") !== -1 && c.indexOf("end") === -1); });
    var cStart = findCol(function (c) { return c.indexOf("start") !== -1; });
    var cUse = findCol(function (c) { return c.indexOf("usage") !== -1; });
    if (cDate === -1 || cStart === -1 || cUse === -1)
      throw new Error("Missing DATE / START TIME / USAGE columns.");

    var months = {}, days = {}, minD = null, maxD = null, rowN = 0;
    for (var r = hi + 1; r < lines.length; r++) {
      if (!lines[r].trim()) continue;
      var cells = lines[r].split(delim);
      if (cells.length <= cUse) continue;
      var ds = (cells[cDate] || "").trim();
      var kwh = parseFloat((cells[cUse] || "").replace(/[^0-9.\-]/g, ""));
      var hr = toHour(cells[cStart]);
      var dm = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(ds);
      if (!dm || isNaN(kwh) || hr === null) continue;
      var mo = parseInt(dm[1], 10), dy = parseInt(dm[2], 10), yr = parseInt(dm[3], 10);
      if (yr < 100) yr += 2000;
      var key = yr + "-" + (mo < 10 ? "0" + mo : mo);
      if (!months[key]) months[key] = { ym: key, month: mo, total: 0, peak: 0, off: 0, summer: isSummer(mo) };
      var b = months[key];
      b.total += kwh;
      if (hr < RATES.peakStartHour) b.off += kwh; else b.peak += kwh;
      days[ds] = 1;
      var t = yr * 10000 + mo * 100 + dy;
      if (minD === null || t < minD) minD = t;
      if (maxD === null || t > maxD) maxD = t;
      rowN++;
    }
    if (rowN === 0) throw new Error("No usable data rows found.");
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
