/* ConEd Rate Optimizer — pure calculation core (no DOM).
   Browser (window.ConedCalc) + Node (module.exports). Estimate only; not affiliated
   with Con Edison. Rate data is overridable at runtime via applyRates() (see rates.json). */
(function (root) {
  "use strict";

  var RATES = {
    meta: {
      version: "1.10.0",
      asOf: "Standard/TOU: 2025 published SC1 NYC averages. TOU & demand rates: current as of 2026-07.",
      reviewedThrough: "2026-07-01",
      utility: "Con Edison",
      serviceClass: "SC1 (Rate I) — NYC Residential",
      basis: "Standard/TOU = ConEd 2025 published SC1 NYC average (grossed up for GRT + sales tax). Demand plans use ConEd's published $/kW delivery rates. Bill reconstruction itemizes ConEd's 3-year published component history (2023–2025) — see RATES.bill.",
      updated: "2026-09",
      peakWindow: "Energy plans: peak 8am–midnight, off-peak midnight–8am. Demand plans (Steady Use / Smart Energy): peak weekdays noon–8pm.",
      switchTiming: "A rate switch takes effect with a future meter read — typically your next bill or the one after (1–2 billing cycles).",
      caveats: [
        "Absolute totals are ±~5%: the monthly Market Supply Charge varies, and 2026 months are priced at 2025 rates.",
        "Standard & Time-of-Use assume delivery/MAC/RDM/surcharges are identical; only supply is time-differentiated.",
        "Steady Use & Smart Energy are DEMAND-based (billed on your peak kW, not total kWh). Delivery uses ConEd's published $/kW rates applied to the peak demand derived from your interval data (avg of the 3 highest hourly demands per period); supply + other charges are held at the standard flat rate because ConEd doesn't publish the exact time-of-use supply rates for these plans. Estimates, best for heat-pump / flat-demand homes.",
        "SmartCharge NY is an opt-in what-if scenario: it applies the published $0.10/kWh off-peak EV charging incentive to the Time-of-Use estimate. Con Edison currently says Residential Time-of-Use customers are not eligible, so verify program eligibility before relying on the combined estimate.",
        "Estimate only — not affiliated with Con Edison. Verify against your actual bill."
      ],
      sources: [
        "https://www.coned.com/en/accounts-billing/your-bill/time-of-use",
        "https://www.coned.com/en/accounts-billing/steady-use-rate",
        "https://www.coned.com/en/accounts-billing/smart-energy-plan",
        "https://www.coned.com/en/save-money/rebates-incentives-tax-credits/rebates-incentives-tax-credits-for-residential-customers/electric-vehicle-rewards",
        "https://www.coned.com/-/media/files/coned/documents/save-energy-money/using-private-generation/historical-average-full-service-electric-rates.pdf"
      ]
    },
    peakStartHour: 8,
    summerMonths: [6, 7, 8, 9],
    // Every currently-eligible SC1 residential plan, with the metadata the plan-by-plan
    // comparison surfaces: ConEd's exact display name, pricing basis, eligibility, the
    // date the rates were last verified, and the ConEd page they come from.
    standard: {
      name: "Standard Residential", short: "Standard", basis: "energy",
      eligibility: "every SC1 residential customer (the default rate)",
      ratesAsOf: "2025 published SC1 NYC averages (2026 usage priced at 2025 rates); PDF verified 2026-07",
      source: "https://www.coned.com/-/media/files/coned/documents/save-energy-money/using-private-generation/historical-average-full-service-electric-rates.pdf",
      requires: { serviceClass: "SC1" },
      lockIn: null,   // the default rate — no commitment, and every other plan can switch back to it
      allIn: 0.338267, commodity: 0.137533, delivery: 0.183233, customer: 16.33
    },
    tou: {
      name: "Time-of-Use", short: "TOU", basis: "energy",
      eligibility: "SC1 residential customers who opt in",
      ratesAsOf: "residential TOU supply rates current as of 2026-07",
      source: "https://www.coned.com/en/accounts-billing/your-bill/time-of-use",
      requires: { serviceClass: "SC1" },
      // ConEd's published enrollment terms: "After you switch to the Time-of-Use Rate, you must
      // stay enrolled for one year unless you get your energy from an energy service company.
      // If you switch back to the Standard Residential Rate, you cannot rejoin the Time-of-Use
      // Rate for 18 months." (coned.com TOU page, verified 2026-06 archive)
      lockIn: {
        minStayMonths: 12, reenrollBlockMonths: 18, escoExempt: true,
        note: "one-year minimum on TOU (ESCO-supplied homes exempt); leave and you can't rejoin TOU for 18 months"
      },
      nonCommodity: 0.338267 - 0.137533, offPeak: 0.0522, peakSummer: 0.2786, peakWinter: 0.1711, gross: 1.10, customer: 21.00
    },
    smartChargeNY: {
      name: "SmartCharge NY", offPeakCredit: 0.10, offPeakWindow: "midnight–8am",
      eligibility: "what-if only — Con Edison currently says Residential Time-of-Use customers are not eligible",
      ratesAsOf: "incentive as published, verified 2026-07",
      source: "https://www.coned.com/en/save-money/rebates-incentives-tax-credits/rebates-incentives-tax-credits-for-residential-customers/electric-vehicle-rewards"
    },
    steadyUse: {
      name: "Steady Use Rate", short: "Steady Use", formerly: "Select Pricing Plan", basis: "demand",
      eligibility: "designed for steady, heat-pump-style loads",
      ratesAsOf: "delivery $/kW rates current as of 2026-07",
      source: "https://www.coned.com/en/accounts-billing/steady-use-rate",
      // ConEd: "Any Con Edison customer with a smart meter can enroll in the Steady Use Rate."
      requires: { serviceClass: "SC1", meter: "smart" },
      // ConEd: "You can cancel anytime without penalty but won't be able to reenroll for
      // 18 months after opting out." (coned.com Steady Use page, verified 2026-07 archive)
      lockIn: {
        cancelAnytime: true, reenrollBlockMonths: 18,
        note: "cancel anytime without penalty, but you can't re-enroll for 18 months after opting out"
      },
      solar: "ConEd says solar / net-metering homes are likely not a good fit for the Steady Use Rate — Standard or Time-of-Use may suit you better.",
      smartChargeConflict: "Enrolling in Steady Use automatically unenrolls you from SmartCharge NY.",
      peakStart: 12, peakEnd: 20, peakWindow: "weekdays noon–8pm",
      demand: { peakSummer: 27.35, peakWinter: 21.04, off: 7.17 }, customer: 16.33
    },
    smartEnergy: {
      name: "Smart Energy Plan", short: "Smart Energy", basis: "demand",
      eligibility: "any smart-meter home",
      ratesAsOf: "delivery $/kW rates current as of 2026-07",
      source: "https://www.coned.com/en/accounts-billing/smart-energy-plan",
      // ConEd: "Anyone with a smart meter installed in their home can participate in the Smart Energy Plan."
      requires: { serviceClass: "SC1", meter: "smart" },
      // ConEd: "You can cancel anytime without penalty but won't be able to reenroll for
      // 18 months after opting out." (coned.com Smart Energy page, verified 2026-05 archive)
      lockIn: {
        cancelAnytime: true, reenrollBlockMonths: 18,
        note: "cancel anytime without penalty, but you can't re-enroll for 18 months after opting out"
      },
      solar: "ConEd does not recommend the Smart Energy Plan for solar customers (its billing structure works against net metering) and suggests the Net Metering Plan instead.",
      peakStart: 12, peakEnd: 20, peakWindow: "weekdays noon–8pm",
      demand: { peakSummer: 30.68, peakWinter: 23.60, off: 10.06 }, customer: 16.33
    },
    // Component-level bill history — the same ConEd publication the Standard averages above
    // come from ("3-Year Historical Average Full Service Electric Rates"), with each year's
    // components broken out instead of folded into one all-in average. Grossed up for GRT +
    // sales tax; EXCLUDES the customer charge and BPP, exactly as ConEd publishes them (a
    // real bill adds the customer charge on top). RDM can be a credit (2023: −0.6533¢/kWh).
    // A billing year with no period here prices at the latest prior year and reconstructBill
    // flags it `projected` — 2026 usage is priced at 2025 averages (the first meta caveat).
    bill: {
      basis: "ConEd 3-Year Historical Average Full Service Electric Rates — NYC Residential SC 1, grossed up for GRT + sales tax, excluding customer charge & BPP",
      source: "https://www.coned.com/-/media/files/coned/documents/save-energy-money/using-private-generation/historical-average-full-service-electric-rates.pdf",
      periods: [
        { year: 2023, delivery: 0.153267, commodity: 0.132800, mac: 0.009900, rdm: -0.006533, surcharges: 0.005767 },
        { year: 2024, delivery: 0.178967, commodity: 0.129900, mac: 0.009300, rdm: 0.009000, surcharges: 0.007367 },
        { year: 2025, delivery: 0.183233, commodity: 0.137533, mac: 0.008133, rdm: 0.002867, surcharges: 0.006500 }
      ]
    },
    // Accuracy policy (docs/product-strategy.md, "Accuracy gate"): a reconstructed bill that
    // lands within passPct of the actual bill reconciles; within warnPct matches the ±~5%
    // caveat the comparison has always carried; an account may only be trusted (never charged)
    // when at least gateFraction of its supported billing periods reconcile within passPct.
    accuracy: { passPct: 2, warnPct: 5, gateFraction: 0.95, basis: "docs/product-strategy.md 'Accuracy gate': charge only when ≥95% of complete, supported billing periods reconcile within passPct of the actual bill" },
    // Paid-conversion policy (docs/product-strategy.md, "Pricing" + "Accuracy gate"). The
    // analysis is free and a no-savings result is never hidden behind payment; the $29
    // report may be charged only when the projected first-year saving clears the
    // meaningful-savings threshold — measured at the LOW end of the savings range, so the
    // pessimistic reading still has to clear the bar — and only once charging is certified
    // (the strategy's ≥20-backtested-accounts gate) AND a payment provider is wired. Both
    // flags ship false: qualified analyses see the offer they'd qualify for, with the named
    // reason no charge can be taken yet, and nothing is ever collected.
    pricing: {
      policyVersion: 1,
      currency: "usd",
      report: { name: "Self-service report", price: 29 },
      threshold: 150,
      concierge: { min: 99, pctOfVerifiedSavings: 0.20 },
      monitoring: { price: 29, per: "year" },
      refund: { windowDays: 14 },
      maxPaymentAttempts: 3,
      savingsBandPct: 0.05,      // ±5% — the absolute-total caveat (meta.caveats[0])
      demandBandPct: 0.10,       // demand-plan targets: supply held flat, exact rates unpublished → wider
      chargingCertified: false,  // docs/product-strategy.md accuracy gate: ≥20 backtested real accounts
      providerCertified: false,  // independent payment-provider certification gate
      provider: { id: "stripe-checkout", createEndpoint: "/api/checkout/create", sessionEndpoint: "/api/checkout/session" },
      basis: "docs/product-strategy.md 'Pricing' + 'Accuracy gate': $29 report only when projected first-year savings exceed $150 (measured at the low end of the range); never charged until the 20-account backtest certifies the model and a payment provider is wired"
    }
  };
  RATES._nonDelivery = RATES.standard.allIn - RATES.standard.delivery;

  function isSummer(m) { return RATES.summerMonths.indexOf(m) !== -1; }
  function cph(x) { return (x * 100).toFixed(2) + "¢/kWh"; }
  function fmtKwh(k) { return Math.round(k).toLocaleString("en-US") + " kWh"; }
  function smartChargeEnabled(options) {
    return options === true || !!(options && (options.smartChargeNY || options.ev || options.evAtHome));
  }

  // Runtime rate override (from rates.json) — deep-merge into RATES, keep derived fields fresh.
  function deepMerge(dst, src) {
    Object.keys(src).forEach(function (k) {
      if (src[k] && typeof src[k] === "object" && !Array.isArray(src[k]) && dst[k] && typeof dst[k] === "object") deepMerge(dst[k], src[k]);
      else dst[k] = src[k];
    });
  }
  function applyRates(obj) {
    if (!obj) return;
    deepMerge(RATES, obj);
    RATES._nonDelivery = RATES.standard.allIn - RATES.standard.delivery;   // keep derived fields fresh
    RATES.tou.nonCommodity = RATES.standard.allIn - RATES.standard.commodity;
  }

  // ---- CSV helpers ----
  function splitRow(line, delim) {
    var out = [], cur = "", q = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
      else if (ch === '"') q = true;
      else if (ch === delim) { out.push(cur); cur = ""; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  }
  function detectDelim(line) { var best = ",", bn = 0; ["\t", ",", ";"].forEach(function (d) { var n = line.split(d).length - 1; if (n > bn) { bn = n; best = d; } }); return best; }
  function toHour(s) {
    s = String(s).replace(/"/g, "").trim(); if (!s) return null;
    var ampm = /(am|pm)\.?$/i.exec(s), h = parseInt(s.split(":")[0], 10);
    if (isNaN(h)) return null;
    if (ampm) { var pm = /pm/i.test(ampm[1]); if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12; }
    return (h >= 0 && h <= 23) ? h : null;
  }
  function parseDate(s) {
    s = String(s).replace(/"/g, "").trim().split(/[ T]/)[0]; var m;
    if ((m = /^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/.exec(s))) return { y: +m[1], mo: +m[2], d: +m[3] };
    if ((m = /^(\d{1,2})[-\/](\d{1,2})[-\/](\d{2,4})$/.exec(s))) { var y = +m[3]; if (y < 100) y += 2000; return { y: y, mo: +m[1], d: +m[2] }; }
    return null;
  }

  // Shared: hourly map -> {months, hours, ndays,...}
  function finalize(hourMap, days, rowN, minD, maxD) {
    if (rowN === 0) throw new Error("no usable interval data found — is this the 15-min/hourly export, not a daily/monthly summary?");
    var hours = Object.keys(hourMap).map(function (k) { return hourMap[k]; });
    var months = {};
    hours.forEach(function (h) {
      var b = months[h.ym]; if (!b) months[h.ym] = b = { ym: h.ym, month: h.mo, total: 0, peak: 0, off: 0, summer: isSummer(h.mo), _d: {} };
      b.total += h.kwh;
      b._d[h.day] = 1;
      if (h.hour < RATES.peakStartHour) b.off += h.kwh; else b.peak += h.kwh;
    });
    var marr = Object.keys(months).sort().map(function (k) {
      var b = months[k];
      b.ndays = Object.keys(b._d).length;   // days actually observed in this bucket
      delete b._d;
      return b;
    });
    return { months: marr, hours: hours, ndays: Object.keys(days).length, intervals: rowN, minDate: minD, maxDate: maxD };
  }
  // ---- CSV (Green Button "Download my data") ----
  function parseGreenButton(text) {
    text = String(text).replace(/^﻿/, "").replace(/\r/g, "");
    var lines = text.split("\n"), hi = -1;
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i].toLowerCase();
      if ((l.indexOf("usage") !== -1 || l.indexOf("kwh") !== -1) && (l.indexOf("date") !== -1 || l.indexOf("start") !== -1 || l.indexOf("time") !== -1)) { hi = i; break; }
    }
    if (hi === -1) throw new Error("couldn't find the data header — make sure this is the ConEd electric “Download my data” CSV (with DATE, START TIME, and USAGE columns).");
    var delim = detectDelim(lines[hi]);
    var header = splitRow(lines[hi], delim).map(function (c) { return c.replace(/"/g, "").trim().toLowerCase(); });
    function findCol(pred) { for (var j = 0; j < header.length; j++) if (pred(header[j])) return j; return -1; }
    var cDate = findCol(function (c) { return c === "date" || (c.indexOf("date") !== -1 && c.indexOf("end") === -1); });
    var cStart = findCol(function (c) { return c.indexOf("start") !== -1; });
    if (cStart === -1) cStart = findCol(function (c) { return c.indexOf("time") !== -1 && c.indexOf("end") === -1; });
    var cUse = findCol(function (c) { return (c.indexOf("usage") !== -1 || c.indexOf("kwh") !== -1) && c.indexOf("cost") === -1 && c.indexOf("$") === -1; });
    if (cDate === -1 || cStart === -1 || cUse === -1) throw new Error("this file is missing a DATE, START TIME, or USAGE (kWh) column — it may be a gas or billing export rather than the electric interval data.");

    var hourMap = {}, days = {}, minD = null, maxD = null, rowN = 0, seen = 0, maxCol = Math.max(cDate, cStart, cUse);
    for (var r = hi + 1; r < lines.length; r++) {
      if (!lines[r].trim()) continue;
      var cells = splitRow(lines[r], delim); if (cells.length <= maxCol) continue; seen++;
      var dt = parseDate(cells[cDate]), kwh = parseFloat(String(cells[cUse]).replace(/[^0-9.\-]/g, "")), hr = toHour(cells[cStart]);
      if (!dt || isNaN(kwh) || hr === null) continue;
      var ym = dt.y + "-" + (dt.mo < 10 ? "0" + dt.mo : dt.mo), hk = dt.y + "-" + dt.mo + "-" + dt.d + "-" + hr;
      var hm = hourMap[hk]; if (!hm) hourMap[hk] = hm = { ym: ym, mo: dt.mo, day: dt.d, hour: hr, weekday: new Date(dt.y, dt.mo - 1, dt.d).getDay(), kwh: 0 };
      hm.kwh += kwh; days[dt.y + "-" + dt.mo + "-" + dt.d] = 1;
      var t = dt.y * 10000 + dt.mo * 100 + dt.d; if (minD === null || t < minD) minD = t; if (maxD === null || t > maxD) maxD = t; rowN++;
    }
    if (rowN === 0 && seen > 0) throw new Error("found the table but couldn't read the date/time/kWh values — send me the first few lines and I'll add support.");
    return finalize(hourMap, days, rowN, minD, maxD);
  }

  // ---- XML (Green Button ESPI). Timestamps are epoch (UTC) -> convert to America/New_York. ----
  var _ET = (typeof Intl !== "undefined") && new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", weekday: "short" });
  var _WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  function etParts(epoch) {
    var p = {}; _ET.formatToParts(new Date(epoch * 1000)).forEach(function (x) { p[x.type] = x.value; });
    return { y: +p.year, mo: +p.month, d: +p.day, hour: parseInt(p.hour, 10) % 24, weekday: _WD[p.weekday] };
  }
  // ESPI feeds may prefix elements with a namespace (e.g. <espi:IntervalReading>) or not — match either.
  var _P = "(?:[A-Za-z_][\\w.-]*:)?";
  function parseESPI(xml) {
    if (!_ET) throw new Error("this browser can't parse the XML export — please use the CSV format instead.");
    var mm = new RegExp("<" + _P + "powerOfTenMultiplier[^>]*>\\s*(-?\\d+)\\s*<\\/" + _P + "powerOfTenMultiplier>").exec(xml);
    var scale = Math.pow(10, mm ? +mm[1] : 0) / 1000;   // reading value (Wh, scaled) -> kWh
    var blocks = xml.match(new RegExp("<" + _P + "IntervalReading[\\s\\S]*?<\\/" + _P + "IntervalReading>", "g")) || [];
    var hourMap = {}, days = {}, minD = null, maxD = null, rowN = 0;
    blocks.forEach(function (b) {
      var s = new RegExp("<" + _P + "start>\\s*(\\d+)\\s*<\\/" + _P + "start>").exec(b),
          v = new RegExp("<" + _P + "value>\\s*(-?\\d+(?:\\.\\d+)?)\\s*<\\/" + _P + "value>").exec(b);
      if (!s || !v) return;
      var e = etParts(+s[1]), kwh = +v[1] * scale;
      if (isNaN(kwh)) return;
      var ym = e.y + "-" + (e.mo < 10 ? "0" + e.mo : e.mo), hk = e.y + "-" + e.mo + "-" + e.d + "-" + e.hour;
      var hm = hourMap[hk]; if (!hm) hourMap[hk] = hm = { ym: ym, mo: e.mo, day: e.d, hour: e.hour, weekday: e.weekday, kwh: 0 };
      hm.kwh += kwh; days[e.y + "-" + e.mo + "-" + e.d] = 1;
      var t = e.y * 10000 + e.mo * 100 + e.d; if (minD === null || t < minD) minD = t; if (maxD === null || t > maxD) maxD = t; rowN++;
    });
    if (rowN === 0) throw new Error("couldn't find interval readings in the XML — is this the Green Button electric usage export?");
    return finalize(hourMap, days, rowN, minD, maxD);
  }

  // Router: auto-detect CSV vs XML.
  function parse(text) { text = String(text); return /^\s*<\?xml|^\s*<[a-zA-Z]/.test(text.slice(0, 300)) ? parseESPI(text) : parseGreenButton(text); }

  // ---- cost models (return {total, lines} for "show the math") ----
  function costStandard(months) {
    var kwh = 0, cust = 0; months.forEach(function (m) { kwh += m.total; cust += RATES.standard.customer; });
    var delivery = kwh * RATES.standard.delivery, supply = kwh * RATES.standard.commodity, other = kwh * (RATES.standard.allIn - RATES.standard.delivery - RATES.standard.commodity);
    return { total: delivery + supply + other + cust, lines: [
      { label: "Delivery", detail: fmtKwh(kwh) + " × " + cph(RATES.standard.delivery), amount: delivery },
      { label: "Supply", detail: fmtKwh(kwh) + " × " + cph(RATES.standard.commodity), amount: supply },
      { label: "MAC / RDM / surcharges", detail: fmtKwh(kwh) + " × " + cph(RATES.standard.allIn - RATES.standard.delivery - RATES.standard.commodity), amount: other },
      { label: "Basic service charge", detail: "$" + RATES.standard.customer.toFixed(2) + "/mo", amount: cust }
    ] };
  }
  function costTOU(months, options) {
    var kwh = 0, offPeakKwh = 0, noncomm = 0, supplyRaw = 0, cust = 0, smartCharge = smartChargeEnabled(options);
    months.forEach(function (m) { kwh += m.total; offPeakKwh += m.off; noncomm += m.total * RATES.tou.nonCommodity; supplyRaw += m.peak * (m.summer ? RATES.tou.peakSummer : RATES.tou.peakWinter) + m.off * RATES.tou.offPeak; cust += RATES.tou.customer; });
    var supply = supplyRaw * RATES.tou.gross;
    var credit = smartCharge ? offPeakKwh * RATES.smartChargeNY.offPeakCredit : 0;
    var lines = [
      { label: "Delivery + surcharges", detail: fmtKwh(kwh) + " × " + cph(RATES.tou.nonCommodity), amount: noncomm },
      { label: "Supply (time-of-use)", detail: "peak " + cph(RATES.tou.peakSummer) + " summer / " + cph(RATES.tou.peakWinter) + " winter · off-peak " + cph(RATES.tou.offPeak), amount: supply }
    ];
    if (smartCharge) lines.push({ label: "SmartCharge NY off-peak credit", detail: fmtKwh(offPeakKwh) + " × −" + cph(RATES.smartChargeNY.offPeakCredit), amount: -credit });
    lines.push(
      { label: "Basic service charge", detail: "$" + RATES.tou.customer.toFixed(2) + "/mo", amount: cust }
    );
    return { total: noncomm + supply + cust - credit, lines: lines,
      smartChargeNY: { enabled: smartCharge, offPeakKwh: offPeakKwh, credit: credit } };
  }
  function avgTopN(a, n) { if (!a.length) return 0; var s = a.slice().sort(function (x, y) { return y - x; }).slice(0, n); return s.reduce(function (x, y) { return x + y; }, 0) / s.length; }
  function costDemand(hours, plan) {
    var mon = {}, energy = 0;
    hours.forEach(function (h) { energy += h.kwh; var b = mon[h.ym]; if (!b) mon[h.ym] = b = { mo: h.mo, peak: [], off: [] }; var isPeak = h.weekday >= 1 && h.weekday <= 5 && h.hour >= plan.peakStart && h.hour < plan.peakEnd; (isPeak ? b.peak : b.off).push(h.kwh); });
    var delivery = 0, nmonths = 0;
    Object.keys(mon).forEach(function (k) { var b = mon[k], pr = isSummer(b.mo) ? plan.demand.peakSummer : plan.demand.peakWinter; delivery += avgTopN(b.peak, 3) * pr + avgTopN(b.off, 3) * plan.demand.off; nmonths++; });
    var other = energy * RATES._nonDelivery, cust = plan.customer * nmonths;
    return { total: delivery + other + cust, lines: [
      { label: "Delivery (demand-based)", detail: "peak kW × $" + plan.demand.peakSummer + "/$" + plan.demand.peakWinter + " + off kW × $" + plan.demand.off + " per month", amount: delivery },
      { label: "Supply + surcharges (flat est.)", detail: fmtKwh(energy) + " × " + cph(RATES._nonDelivery), amount: other },
      { label: "Basic service charge", detail: "$" + plan.customer.toFixed(2) + "/mo", amount: cust }
    ] };
  }

  // ---- bill reconstruction & accuracy gates ----
  // The paid product promises historical bill reproduction, so the model has to price a real
  // billing period component by component (not the all-in averages the plan comparison uses)
  // and then say how close it came to the bill the customer actually received.
  var BILL_COMPONENTS = [
    { key: "customerCharge", label: "Basic service charge", fixed: true },
    { key: "delivery", label: "Delivery" },
    { key: "commodity", label: "Supply" },
    { key: "mac", label: "MAC" },
    { key: "rdm", label: "RDM" },
    { key: "surcharges", label: "Surcharges" }
  ];

  // The component rate set for a billing year: the published period for that year, else the
  // latest prior year, else the earliest — with `projected` flagging that the year isn't
  // covered by published data (2026 priced at 2025 averages, or a bill older than 2023).
  function billRatePeriod(year) {
    var periods = RATES.bill && RATES.bill.periods;
    if (!periods || !periods.length) throw new Error("no bill rate periods are configured (RATES.bill.periods is empty) — bill reconstruction needs at least one.");
    year = +year;
    if (isNaN(year)) {
      var latest = periods.reduce(function (a, b) { return b.year > a.year ? b : a; });
      return { year: latest.year, rates: latest, projected: latest.year < new Date().getFullYear() };
    }
    var prior = null, earliest = periods[0];
    for (var i = 0; i < periods.length; i++) {
      var p = periods[i];
      if (p.year === year) return { year: p.year, rates: p, projected: false };
      if (p.year < year && (!prior || p.year > prior.year)) prior = p;
      if (p.year < earliest.year) earliest = p;
    }
    return prior ? { year: prior.year, rates: prior, projected: true }
                 : { year: earliest.year, rates: earliest, projected: true };
  }

  // Price one billing period at component level. period: { kwh, year, months, supplyPerKwh }
  // — kwh required; months defaults to 1 (fractions model partial periods); supplyPerKwh
  // replaces the annual average commodity rate with the Market Supply Charge actually billed
  // that month. options: { customerCharge ($/mo override), includeCustomerCharge (default
  // true — pass false for ConEd's published bill history, which EXCLUDES it) }.
  function reconstructBill(period, options) {
    period = period || {}; options = options || {};
    var kwh = +period.kwh;
    if (isNaN(kwh) || kwh < 0) throw new Error("reconstructBill needs the billing period's usage in kWh (period.kwh).");
    if (period.plan && period.plan !== "standard") throw new Error("bill reconstruction prices the Standard rate (the published bill history's basis) — \"" + period.plan + "\" isn't supported yet.");
    var months = period.months !== undefined && period.months !== null ? +period.months : 1;
    if (isNaN(months) || months < 0) months = 1;
    var sel = billRatePeriod(period.year), r = sel.rates;
    var commodity = period.supplyPerKwh !== undefined && period.supplyPerKwh !== null ? +period.supplyPerKwh : r.commodity;
    var custPerMonth = options.customerCharge !== undefined && options.customerCharge !== null ? +options.customerCharge : RATES.standard.customer;
    var amounts = {
      customerCharge: options.includeCustomerCharge === false ? 0 : custPerMonth * months,
      delivery: kwh * r.delivery,
      commodity: kwh * commodity,
      mac: kwh * r.mac,
      rdm: kwh * r.rdm,
      surcharges: kwh * r.surcharges
    };
    var total = 0, lines = [];
    BILL_COMPONENTS.forEach(function (c) {
      var amount = amounts[c.key]; total += amount;
      lines.push({
        component: c.key, label: c.label, amount: amount,
        detail: c.fixed
          ? (options.includeCustomerCharge === false ? "excluded — this bill's basis has no customer charge"
             : "$" + custPerMonth.toFixed(2) + "/mo × " + months + (months === 1 ? " mo" : " mos"))
          : fmtKwh(kwh) + " × " + cph(amount / (kwh || 1)) + (amount < 0 ? " (credit)" : "")
      });
    });
    return {
      plan: "standard", kwh: kwh, months: months, total: total, lines: lines, components: amounts,
      projected: sel.projected,
      ratePeriod: { year: sel.year, projected: sel.projected, basis: RATES.bill.basis, source: RATES.bill.source }
    };
  }

  // Accuracy policy, with per-call overrides: thresholds({ passPct, warnPct, gateFraction }).
  function accuracyThresholds(overrides) {
    var a = RATES.accuracy || {}, t = { passPct: a.passPct, warnPct: a.warnPct, gateFraction: a.gateFraction };
    if (overrides) Object.keys(t).forEach(function (k) { if (overrides[k] !== undefined) t[k] = overrides[k]; });
    // Same coherence rule validate-rates.js enforces on rates.json, applied to the
    // override path: a pass band wider than the warn band makes "warn" meaningless.
    if (t.passPct > t.warnPct) throw new Error("accuracy thresholds: passPct (" + t.passPct + ") may not exceed warnPct (" + t.warnPct + ") — the pass band would be wider than the warn band.");
    return t;
  }

  // Compare a modeled period against the bill the customer actually received.
  // actual: { kwh, year, months?, total, components? (per-component actuals), supplyPerKwh?,
  // label? } — options pass through to reconstructBill, plus thresholds.
  function reconcileBill(actual, options) {
    actual = actual || {}; options = options || {};
    var modeled = reconstructBill(actual, options);
    var actTotal = +actual.total;
    if (isNaN(actTotal)) throw new Error("reconcileBill needs the actual bill total in dollars (actual.total).");
    var th = accuracyThresholds(options.thresholds);
    var delta = modeled.total - actTotal;
    var pctError = actTotal === 0 ? (Math.abs(delta) < 1e-9 ? 0 : Infinity) : Math.abs(delta) / Math.abs(actTotal) * 100;
    var componentDeltas = null, driver = null;
    if (actual.components) {
      componentDeltas = [];
      BILL_COMPONENTS.forEach(function (c) {
        var a = actual.components[c.key];
        if (a === undefined || a === null) return;
        var m = modeled.components[c.key], d = m - a;
        var row = { component: c.key, label: c.label, actual: a, modeled: m, delta: d };
        componentDeltas.push(row);
        if (!driver || Math.abs(d) > Math.abs(driver.delta)) driver = row;
      });
    }
    return {
      label: actual.label || (modeled.kwh + " kWh" + (actual.year !== undefined ? " · " + actual.year : "")),
      actualTotal: actTotal, modeledTotal: modeled.total, delta: delta, pctError: pctError,
      band: pctError <= th.passPct ? "pass" : pctError <= th.warnPct ? "warn" : "fail",
      withinGate: pctError <= th.passPct,
      componentDeltas: componentDeltas, driver: driver,
      modeled: modeled, thresholds: th
    };
  }

  // The product-strategy accuracy gate over a set of reconciled periods: the model may be
  // trusted on an account only when at least gateFraction (default 95%) of its supported
  // billing periods reconcile within passPct (default 2%). Every miss is listed — never
  // averaged away.
  function accuracyGate(reconciliations, options) {
    options = options || {};
    var th = accuracyThresholds(options.thresholds);
    var rs = reconciliations || [], n = rs.length;
    var within2 = 0, within5 = 0, sumPct = 0, maxPct = 0, failures = [];
    rs.forEach(function (r) {
      if (r.withinGate) within2++;
      if (r.pctError <= th.warnPct) within5++;
      sumPct += r.pctError; if (r.pctError > maxPct) maxPct = r.pctError;
      if (!r.withinGate) failures.push({ label: r.label, delta: r.delta, pctError: r.pctError, driver: r.driver ? r.driver.label : null });
    });
    return {
      periods: n, within2: within2, within5: within5,
      pctWithin2: n ? within2 / n * 100 : 0, pctWithin5: n ? within5 / n * 100 : 0,
      meanPctError: n ? sumPct / n : 0, maxPctError: maxPct,
      gateFraction: th.gateFraction,
      gate: n > 0 && within2 / n >= th.gateFraction ? "pass" : "fail",
      failures: failures
    };
  }

  // ---- billing history import, reconciliation & confidence gating ----
  // The strategy's customer journey is "import billing + interval history → validate
  // data quality and reconstruct actual bills", and its free result must carry
  // "calculation confidence and missing-data warnings" BEFORE the savings claim.
  // Actual bills arrive as ESPI UsageSummary summaries (the Green Button Connect
  // billing feed); they are reconstructed component-by-component at the published
  // rates and reconciled against the modeled charge, and the result gates how much
  // confidence the verdict is allowed to claim.

  var DAYS_PER_MONTH = 30.4375;   // mean Gregorian month — prorates the customer charge over a bill's days
  var BILL_GAP_DAYS = 45;         // adjacent bill periods farther apart than this have a missing bill between them
  var BILL_COVERAGE = 0.8;        // interval data must cover this share of a bill's days to price it
  var MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function ymdInt(y, mo, d) { return y * 10000 + mo * 100 + d; }
  // Calendar-day serial number for a NY-local calendar date (DST-proof day counts).
  function daySerial(y, mo, d) { return Math.round(Date.UTC(y, mo - 1, d) / 86400000); }
  function billLabel(a, b) {
    function part(p, withYear) { return MONTH_NAMES[p.mo - 1] + " " + p.d + (withYear ? ", " + p.y : ""); }
    return a.y === b.y ? part(a, false) + " – " + part(b, true) : part(a, true) + " – " + part(b, true);
  }

  // One billing period from an ESPI UsageSummary entry. Dates may be epoch seconds
  // (the GBCMD shape) or an xsd:dateTime / date string; both resolve to the
  // NY-local calendar date the bill boundary names.
  function billDate(s) {
    s = String(s).trim();
    if (/^\d+$/.test(s)) {
      if (!_ET) return null;                       // epoch needs the NY conversion
      var p = etParts(+s);
      return { parts: p, epoch: +s };
    }
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
    if (!m) return null;
    var parts = { y: +m[1], mo: +m[2], d: +m[3] };
    var epoch = Date.parse(s) / 1000;              // NaN for a bare date — only used for ordering/gaps
    return { parts: parts, epoch: isNaN(epoch) ? daySerial(parts.y, parts.mo, parts.d) * 86400 : epoch };
  }

  // ESPI billing (UsageSummary) feed -> { bills, incomplete }. Cost is the
  // <cost> amount in minor currency units (cents for USD), as ESPI publishes it.
  // Entries that can't be priced are returned in `incomplete` with the reason —
  // never silently dropped and never allowed to poison the reconciled set.
  function parseBillingESPI(xml) {
    xml = String(xml);
    var entries = xml.match(new RegExp("<" + _P + "entry>[\\s\\S]*?</" + _P + "entry>", "g")) || [];
    var bills = [], incomplete = [];
    entries.forEach(function (e) {
      var us = new RegExp("<" + _P + "UsageSummary[\\s\\S]*?</" + _P + "UsageSummary>").exec(e);
      if (!us) return;                             // not a billing summary entry
      var idM = new RegExp("<" + _P + "id>\\s*([^<]+?)\\s*<\\/(?:[A-Za-z_][\\w.-]*:)?id>").exec(e);
      function reject(reason) { incomplete.push({ label: idM ? idM[1] : "billing summary", reason: reason }); }
      var sM = new RegExp("<" + _P + "start>\\s*([^<]+?)\\s*<\\/").exec(us[0]),
          eM = new RegExp("<" + _P + "end>\\s*([^<]+?)\\s*<\\/").exec(us[0]);
      if (!sM || !eM) return reject("no billing period");
      var S = billDate(sM[1]), E = billDate(eM[1]);
      if (!S || !E) return reject("unreadable billing period dates");
      var days = daySerial(E.parts.y, E.parts.mo, E.parts.d) - daySerial(S.parts.y, S.parts.mo, S.parts.d);
      if (days <= 0) return reject("billing period ends before it starts");
      var vM = new RegExp("<" + _P + "cost>[\\s\\S]*?<" + _P + "value>\\s*(-?[\\d.]+)\\s*<\\/" + _P + "value>[\\s\\S]*?<\\/" + _P + "cost>").exec(us[0])
            || new RegExp("<" + _P + "cost[^>]*\\bvalue=\"(-?[\\d.]+)\"[^>]*>").exec(us[0]);
      if (!vM) return reject("no bill total");
      var curM = new RegExp("<" + _P + "currency>\\s*([^<]+?)\\s*<\\/").exec(us[0])
            || new RegExp("<" + _P + "cost[^>]*\\bcurrency=\"([A-Za-z]{3})\"").exec(us[0]);
      var cur = curM ? curM[1].toUpperCase() : "USD";
      if (cur !== "USD") return reject("unsupported currency " + cur + " — the model prices US dollars");
      bills.push({
        start: S.epoch, end: E.epoch, days: days,
        ymdStart: ymdInt(S.parts.y, S.parts.mo, S.parts.d),
        ymdEnd: ymdInt(E.parts.y, E.parts.mo, E.parts.d),
        cost: +vM[1] / 100, currency: cur,
        label: billLabel(S.parts, E.parts)
      });
    });
    if (!bills.length && !incomplete.length) throw new Error("no billing summaries (UsageSummary entries) in this feed — is this the billing export?");
    bills.sort(function (a, b) { return a.start - b.start; });
    return { bills: bills, incomplete: incomplete };
  }

  // Accept already-parsed bill records as-is and minimal { start, end, cost }
  // objects (epochs or date strings) — one shape for every caller.
  function normalizeBills(bills) {
    var out = [], incomplete = [];
    (Array.isArray(bills) ? bills : []).forEach(function (b) {
      if (!b || typeof b !== "object") return;
      if (b.ymdStart && b.ymdEnd && typeof b.cost === "number") { out.push(b); return; }
      var S = b.start !== undefined ? billDate(b.start) : null, E = b.end !== undefined ? billDate(b.end) : null;
      if (!S || !E || typeof b.cost !== "number" || isNaN(b.cost)) {
        incomplete.push({ label: b.label || "bill", reason: "missing period or total" });
        return;
      }
      var days = daySerial(E.parts.y, E.parts.mo, E.parts.d) - daySerial(S.parts.y, S.parts.mo, S.parts.d);
      if (days <= 0) { incomplete.push({ label: b.label || "bill", reason: "ends before it starts" }); return; }
      out.push({
        start: S.epoch, end: E.epoch, days: days, cost: b.cost,
        ymdStart: ymdInt(S.parts.y, S.parts.mo, S.parts.d),
        ymdEnd: ymdInt(E.parts.y, E.parts.mo, E.parts.d),
        label: b.label || billLabel(S.parts, E.parts), currency: b.currency || "USD"
      });
    });
    out.sort(function (a, b) { return a.start - b.start; });
    return { bills: out, incomplete: incomplete };
  }

  // Reconcile actual bills against the interval data and the published-rate
  // reconstruction. A bill is *supported* only when the interval data covers at
  // least BILL_COVERAGE of its days — "complete, supported billing periods" in
  // the strategy's accuracy gate — and unsupported ones are excluded from the
  // gate rather than priced on invented usage. gate is null when nothing was
  // checkable: "unverified", not "failed".
  function reconcileBills(parsed, bills, options) {
    options = options || {};
    var norm = Array.isArray(bills) && bills.length && bills[0] && bills[0].ymdStart ? { bills: bills, incomplete: [] } : normalizeBills(bills);
    var hours = (parsed && parsed.hours) || [];
    var rows = [], unsupported = [];
    norm.bills.forEach(function (b) {
      var kwh = 0, seen = {};
      hours.forEach(function (h) {
        var t = ymdInt(+String(h.ym).slice(0, 4), h.mo, h.day);
        if (t >= b.ymdStart && t < b.ymdEnd) { kwh += h.kwh; seen[t] = 1; }
      });
      var observedDays = Object.keys(seen).length;
      if (observedDays < BILL_COVERAGE * b.days) {
        unsupported.push({ label: b.label, reason: "interval data covers " + observedDays + " of " + b.days + " days" });
        return;
      }
      var endY = Math.floor(b.ymdEnd / 10000);
      var r = reconcileBill({ kwh: kwh, year: endY, months: b.days / DAYS_PER_MONTH, total: b.cost, label: b.label }, options);
      r.kwh = kwh; r.observedDays = observedDays; r.billDays = b.days; r.supported = true;
      rows.push(r);
    });
    return {
      complete: norm.bills.length, incomplete: norm.incomplete, rows: rows, unsupported: unsupported,
      gate: rows.length ? accuracyGate(rows, { thresholds: options.thresholds }) : null
    };
  }

  // Missing and incomplete periods across both inputs: interval months absent
  // from the middle of the export window, truncated export months, holes between
  // adjacent billing periods, and billing summaries that carry no usable total.
  function auditDataQuality(parsed, bills) {
    var months = (parsed && parsed.months ? parsed.months : parsed) || [];
    var partialMonths = [], missingMonths = [];
    (Array.isArray(months) ? months : []).forEach(function (m) {
      if (m.ndays && m.ndays < 0.8 * daysInMonth(m.ym)) partialMonths.push(m.ym);
    });
    if (Array.isArray(months) && months.length) {
      var present = {};
      months.forEach(function (m) { present[m.ym] = 1; });
      var y = +String(months[0].ym).slice(0, 4), mo = +String(months[0].ym).slice(5, 7);
      var last = months[months.length - 1].ym;
      for (;;) {
        var ym = y + "-" + (mo < 10 ? "0" : "") + mo;
        if (ym > last) break;
        if (!present[ym]) missingMonths.push(ym);
        mo++; if (mo > 12) { mo = 1; y++; }
      }
    }
    var norm = normalizeBills(bills || []);
    var billGaps = [];
    for (var i = 1; i < norm.bills.length; i++) {
      var gap = Math.round((norm.bills[i].start - norm.bills[i - 1].end) / 86400);
      if (gap > BILL_GAP_DAYS) billGaps.push({ after: norm.bills[i - 1].label, before: norm.bills[i].label, days: gap });
    }
    return { partialMonths: partialMonths, missingMonths: missingMonths, billGaps: billGaps, incompleteBills: norm.incomplete };
  }

  // The confidence the verdict may claim, with the reasons stated alongside —
  // the strategy's "calculation confidence and missing-data warnings" before
  // any savings figure. high = verified against actual bills; medium =
  // unverified or partially checkable; low = the model disagrees with the
  // bills it could check. Every downgrade is named, never averaged away.
  function assessConfidence(ctx) {
    ctx = ctx || {};
    var recon = ctx.reconciliation || {}, audit = ctx.audit || {}, profile = ctx.profile || {};
    var level = "high", reasons = [];
    // Independent unverified-conditions each name themselves; they don't compound —
    // "medium" is the floor for everything except a failed gate, which is the one
    // signal that means the model actively disagrees with the customer's bills.
    function drop() { if (level === "high") level = "medium"; }

    if (!recon.complete && !(recon.incomplete && recon.incomplete.length)) {
      drop();
      reasons.push("no actual bills imported — these are modeled from ConEd's published rates, not yet verified against your real bills (connect your account to verify them).");
    } else if (recon.gate === null) {
      drop();
      reasons.push("billing history imported but nothing could be checked against your interval data" +
        (recon.skipped ? " (" + recon.skipped + ")" : "") + ".");
    } else if (recon.gate.gate === "pass") {
      reasons.push(recon.gate.within2 + " of " + recon.gate.periods + " actual bills reconstructed within the " +
        recon.gate.gateFraction * 100 + "% accuracy gate (worst ±" + recon.gate.maxPctError.toFixed(1) + "%).");
      if (recon.unsupported.length) {
        drop();
        reasons.push(recon.unsupported.length + " bill" + (recon.unsupported.length === 1 ? "" : "s") +
          " couldn't be checked — no interval coverage for those dates.");
      }
    } else {
      level = "low";
      var worst = recon.gate.failures.reduce(function (a, b) { return !a || b.pctError > a.pctError ? b : a; }, null);
      reasons.push("the model missed " + recon.gate.failures.length + " of " + recon.gate.periods +
        " actual bills" + (worst ? " — worst " + worst.label + " (±" + worst.pctError.toFixed(1) + "%)" : "") +
        " — treat the savings figures as unverified.");
    }

    if (audit.missingMonths && audit.missingMonths.length) {
      drop();
      reasons.push("no usage data for " + audit.missingMonths.join(", ") + " — those periods are missing from the export.");
    }
    if (audit.billGaps && audit.billGaps.length) {
      drop();
      reasons.push(audit.billGaps.length + " gap" + (audit.billGaps.length === 1 ? "" : "s") + " in the billing history (a missing bill between " +
        audit.billGaps[0].after + " and " + audit.billGaps[0].before + ").");
    }
    if (audit.incompleteBills && audit.incompleteBills.length) {
      drop();
      reasons.push(audit.incompleteBills.length + " billing summar" + (audit.incompleteBills.length === 1 ? "y" : "ies") +
        " had no usable total and couldn't be checked.");
    }
    if (ctx.hasHours === false) {
      drop();
      reasons.push("monthly totals only — the hourly load shape (and the demand plans) can't be checked.");
    }
    if (ctx.ndays && ctx.ndays < 350) {
      drop();
      reasons.push(ctx.ndays + " days of usage annualized — a full year would firm this up.");
    }
    if (profile.territory === "westchester") {
      drop();
      reasons.push("reconstruction uses ConEd's published NYC rates — Westchester delivery differs.");
    }
    if (recon.complete && profile.currentPlan && profile.currentPlan !== "standard") {
      drop();
      reasons.push("actual-bill reconstruction is Standard-rate only; your plan's bills are modeled, not verified.");
    }
    return { level: level, reasons: reasons };
  }

  // ---- paid conversion (docs/product-strategy.md, "Free result" → "Paid result") ----
  // The analysis is free, and a no-savings verdict is itself the product ("Do not hide
  // a 'no savings' result behind payment"). The paid report is offered only when the
  // projected first-year saving is real AND meaningful; the charge is taken only when
  // the deployment is certified to charge at all.

  function usd0(n) { return (n < 0 ? "−$" : "$") + Math.abs(Math.round(n)).toLocaleString("en-US"); }

  function providerConfigured(P) {
    var p = P && P.provider;
    // The server and browser adapter below are specifically the Stripe-hosted
    // Checkout integration. Treating an arbitrary descriptor as wired would
    // allow a certification flag for one provider to arm a different adapter.
    return !!(p && typeof p === "object" && p.id === "stripe-checkout" &&
      (!p.createEndpoint || typeof p.createEndpoint === "string") &&
      (!p.sessionEndpoint || typeof p.sessionEndpoint === "string"));
  }

  function providerCertified(P) {
    // Certification is an explicit deployment decision. It cannot be supplied
    // by a client-visible provider descriptor or inferred from its presence.
    return !!(P && P.providerCertified === true);
  }

  // The annual-savings RANGE the free verdict shows ("the estimated annual opportunity,
  // as a range"). The comparison's honest uncertainty — ±~5% on absolute totals, wider
  // for a demand-plan target whose supply rates aren't published — is applied
  // adversarially to both sides of the difference: the low end prices the current plan
  // at its cheap edge and the alternative at its expensive edge, so `low` is the
  // pessimistic reading the meaningful-savings threshold is measured against.
  function savingsRange(curAnnual, altAnnual, bandPct) {
    var b = isFinite(bandPct) && bandPct > 0 ? bandPct : (RATES.pricing || {}).savingsBandPct || 0.05;
    return {
      estimate: curAnnual - altAnnual,
      low: curAnnual * (1 - b) - altAnnual * (1 + b),
      high: curAnnual * (1 + b) - altAnnual * (1 - b),
      bandPct: b
    };
  }

  // The free-verdict-to-paid-result gate. `a` is an analyze() result (or the fields of
  // one this flow reads: plans, switchTarget, savings, annualFactor,
  // eligibility, confidence, savings). Returns:
  //   eligible    — savings-qualified and actionable: this analysis MAY be offered the report
  //   collectible — eligible AND the deployment may actually take the charge
  //                 (accuracy-gate certified + payment provider wired)
  //   reasons     — every failed condition named, in the confidence system's style
  //   offer / noSavings — exactly one side of the flow's fork
  function paidConversion(a) {
    a = a || {};
    var P = RATES.pricing || {};
    var factor = a.annualFactor || 1;
    var reasons = [];
    var target = a.switchTarget || null;
    // The report gate is a second boundary, not a trust boundary around a caller's
    // `switchTarget` object. Reuse the analysis' availability flags so a stale report,
    // a hand-built result, or a changed eligibility profile cannot turn an excluded
    // plan into a valid savings claim.
    var listedTarget = target && (a.plans || []).filter(function (p) { return p.key === target.key; })[0];
    if (listedTarget && (listedTarget.avail === false || listedTarget.current)) target = null;
    var blockers = (a.eligibility && a.eligibility.blockers) || [];
    var cur = (a.plans || []).filter(function (p) { return p.current; })[0] || (a.plans || [])[0];
    var curCost = cur ? cur.cost : 0, altCost = target ? target.cost : curCost;
    var band = target && target.demand ? (P.demandBandPct || 0.10) : (P.savingsBandPct || 0.05);
    var savings = a.savings || savingsRange(curCost * factor, altCost * factor, band);
    var threshold = P.threshold;
    var reportPrice = P.report && P.report.price;
    var fixedReportPrice = reportPrice === 29;
    var thresholdCleared = isFinite(threshold) && savings.low > threshold;
    var hasSaving = !!target && savings.estimate > 0;
    var confidenceLevel = a.confidence && a.confidence.level;

    if (blockers.length) {
      reasons.push("the analysis is blocked — the account you described isn't one this tool can advise on, so nothing is offered.");
    } else if (!hasSaving) {
      reasons.push("no eligible plan switch lowers this bill — there is nothing to sell, and nothing is hidden behind payment.");
    } else if (!thresholdCleared) {
      reasons.push("a switch would save an estimated " + usd0(savings.estimate) + "/yr (range " + usd0(savings.low) + "–" + usd0(savings.high) +
        "), under the " + usd0(threshold) + "/yr meaningful-savings bar for the report — the free comparison already covers you.");
    } else if (confidenceLevel === "low") {
      reasons.push("the model disagrees with your actual bills — a charge is never taken against that evidence.");
    } else if (!fixedReportPrice) {
      reasons.push("the report price is not the certified $29 product, so checkout remains closed until the pricing policy and provider agree.");
    }

    var eligible = !blockers.length && hasSaving && thresholdCleared && confidenceLevel !== "low" && fixedReportPrice;
    var collectible = false;
    if (eligible) {
      if (P.chargingCertified !== true) {
        reasons.push("charging isn't armed in this deployment — the strategy's accuracy gate (≥20 backtested real accounts) isn't certified, so the report can't be sold to anyone yet.");
      } else if (!providerConfigured(P)) {
        reasons.push("no payment provider is wired into this deployment.");
      } else if (!providerCertified(P)) {
        reasons.push("the payment provider is not certified for this deployment, so checkout remains closed.");
      }
      collectible = P.chargingCertified === true && providerConfigured(P) && providerCertified(P);
    }

    var offer = null;
    if (eligible) {
      offer = {
        product: "report",
        name: (P.report && P.report.name) || "Self-service report",
        price: 29,
        currency: P.currency || "usd",
        policyVersion: P.policyVersion,
        savings: savings, threshold: threshold,
        demandEstimate: !!(target && target.demand),
        targetPlan: target ? { key: target.key, name: target.name, lockIn: target.lockIn || null } : null,
        // The strategy's "Paid result" contents, quoted so the offer never invents scope.
        includes: [
          "complete plan-by-plan comparison",
          "exact rate name and eligibility notes",
          "month-by-month counterfactual charges",
          "switching timing and lock-in warning",
          "step-by-step enrollment instructions",
          "optional concierge switching and first-year verification"
        ]
      };
    }

    var noSavings = null;
    if (!blockers.length && !hasSaving) {
      noSavings = {
        message: "Your current plan is the cheapest eligible plan for your usage — there is nothing to sell you here, and nothing about this result is hidden behind payment.",
        annualRecheck: "Rates and load shapes change: re-run the analysis after a season (or a year) and it re-checks every plan on whatever your usage does next."
      };
    }

    return {
      eligible: eligible, collectible: collectible, reasons: reasons,
      savings: savings,
      threshold: { value: threshold, cleared: thresholdCleared, measure: "low end of the savings range" },
      offer: offer, noSavings: noSavings
    };
  }

  // Explicit consent before any charge. The record must name the current pricing-policy
  // version (a consent given under one price can't authorize a charge under another)
  // and carry every required acknowledgment. The payment flow's "consent" transition
  // calls this — nothing charges without it passing.
  var CONSENT_FIELDS = [
    { key: "sawPrice", label: "saw the report's price" },
    { key: "sawContents", label: "saw what the report contains" },
    { key: "sawNoAffiliation", label: "saw that this service is independent — not Con Edison" },
    { key: "sawEstimateCaveat", label: "saw that the savings are a projected estimate, not a guarantee" },
    { key: "authorizesCharge", label: "authorized the charge itself" }
  ];
  function validateConsent(record, pricing) {
    var P = pricing || RATES.pricing || {};
    if (!record || typeof record !== "object") return { valid: false, missing: [], reason: "no consent recorded" };
    if (record.version !== P.policyVersion) {
      return { valid: false, missing: [], reason: "consent was given under pricing policy v" + record.version +
        "; the current policy is v" + P.policyVersion + " — re-consent required" };
    }
    var missing = CONSENT_FIELDS.filter(function (f) { return record[f.key] !== true; }).map(function (f) { return f.label; });
    if (missing.length) return { valid: false, missing: missing, reason: "consent is missing: " + missing.join("; ") };
    if (typeof record.grantedAt !== "number" || !isFinite(record.grantedAt)) {
      return { valid: false, missing: ["a consent timestamp"], reason: "consent carries no timestamp" };
    }
    return { valid: true, missing: [], reason: null };
  }

  // Refund policy: full refund through two doors — "the report's own claim didn't hold"
  // (any time: the value promise is ours to keep), or change of mind within the policy
  // window. Idempotent: an already-refunded purchase is never refunded twice.
  function refundDecision(purchase, request, now) {
    var P = RATES.pricing || {}, win = P.refund && P.refund.windowDays;
    var t = typeof now === "number" && isFinite(now) ? now : Date.now();
    if (!purchase || typeof purchase.paidAt !== "number" || !(purchase.amount > 0)) {
      return { granted: false, amount: 0, reason: "nothing paid — nothing to refund" };
    }
    if (purchase.refunded) return { granted: false, amount: 0, reason: "already refunded" };
    if (request && request.reason === "savings_not_realized") {
      return { granted: true, amount: purchase.amount, reason: "the report's projected saving didn't hold — refunded in full, any time" };
    }
    if (request && request.reason === "change_of_mind") {
      if (isFinite(win) && (t - purchase.paidAt) <= win * 86400000) {
        return { granted: true, amount: purchase.amount, reason: "change of mind within the " + win + "-day window" };
      }
      return { granted: false, amount: 0, reason: "the " + win + "-day change-of-mind window has passed (a saving that doesn't hold is still refundable any time)" };
    }
    return { granted: false, amount: 0, reason: "unrecognized refund reason" };
  }

  // The payment state machine — the only path from "offered" to a charge, with every
  // fork the strategy names handled explicitly: no savings (never offered), failed
  // payment (bounded retries, the free result untouched), refund (policy-decided,
  // idempotent), and consent (validated, version-bound, and worthless without an active
  // offer — a consent event can never start a charge the verdict didn't offer).
  //
  // flow: the current flow object (null to start); NEVER mutated — every transition
  // returns a new one, so a re-render can replay safely.
  //   states:  start → offered | not_offered | unavailable → consented → charging
  //            → redirecting → paid → refunded; charging → failed | cancelled
  //            → charging | abandoned
  //   events:  verdict, consent, charge, redirected, charge_failed,
  //            charge_cancelled, charge_succeeded, checkout_succeeded,
  //            checkout_cancelled, refund_requested
  // ctx: { pricing, now } — pricing overrides RATES.pricing (tests, future per-deploy policy).
  function newPaymentFlow() {
    return { state: "start", attempts: 0, consent: null, purchase: null, refund: null, reason: null };
  }
  function paymentTransition(flow, event, payload, ctx) {
    var f = JSON.parse(JSON.stringify(flow || newPaymentFlow()));   // flows are tiny; copy beats aliasing
    var P = (ctx && ctx.pricing) || RATES.pricing || {};
    f.reason = null;
    function refuse(reason) { f.reason = reason; return f; }

    if (event === "verdict") {
      var paid = payload && payload.paid;
      if (!paid) return refuse("no verdict to act on");
      if (!paid.eligible) { f.state = "not_offered"; f.reason = paid.noSavings ? null : (paid.reasons[0] || null); return f; }
      if (!paid.collectible) { f.state = "unavailable"; f.reason = paid.reasons[paid.reasons.length - 1] || null; return f; }
      f.state = "offered"; return f;
    }
    if (event === "consent") {
      if (["offered", "failed", "cancelled"].indexOf(f.state) === -1) {
        return refuse("no offer is active — consent can't start a charge the verdict never offered");
      }
      var v = validateConsent(payload && payload.consent, P);
      if (!v.valid) return refuse(v.reason);
      f.consent = payload.consent; f.state = "consented";
      return f;
    }
    if (event === "charge") {
      if (f.state === "abandoned") return refuse("this offer was withdrawn after " + (P.maxPaymentAttempts || 3) + " failed payment attempts");
      if (f.state !== "consented" && f.state !== "failed") return refuse("no authorized charge is pending");
      f.state = "charging";
      return f;
    }
    if (event === "redirected") {
      if (f.state !== "charging") return refuse("no charge is being redirected");
      f.state = "redirecting";
      return f;
    }
    if (event === "charge_failed") {
      if (f.state !== "charging") return refuse("no charge in flight");
      f.attempts += 1;
      var max = P.maxPaymentAttempts || 3, left = max - f.attempts;
      if (left <= 0) {
        f.state = "abandoned";
        f.reason = "payment failed " + f.attempts + " times — the offer is withdrawn for this session (your free result is unaffected)";
      } else {
        f.state = "failed";
        f.reason = "payment failed — you can retry (" + left + " attempt" + (left === 1 ? "" : "s") + " left)";
      }
      return f;
    }
    if (event === "charge_succeeded") {
      if (f.state !== "charging") return refuse("no charge in flight");
      f.attempts += 1;
      f.state = "paid";
      f.purchase = { paidAt: (ctx && ctx.now) || Date.now(), amount: P.report && P.report.price, currency: P.currency || "usd", refunded: false };
      return f;
    }
    if (event === "charge_cancelled") {
      if (["charging", "redirecting"].indexOf(f.state) === -1) return refuse("no charge in flight");
      f.state = "cancelled";
      f.reason = "checkout was cancelled — no charge was made; the free result remains available";
      return f;
    }
    if (event === "checkout_succeeded") {
      if (["offered", "redirecting", "charging"].indexOf(f.state) === -1) {
        return refuse("no provider-confirmed checkout is pending");
      }
      f.state = "paid";
      f.purchase = { paidAt: (ctx && ctx.now) || Date.now(), amount: P.report && P.report.price, currency: P.currency || "usd", refunded: false };
      return f;
    }
    if (event === "checkout_cancelled") {
      if (["offered", "redirecting", "charging"].indexOf(f.state) === -1) {
        return refuse("no provider checkout is pending");
      }
      f.state = "cancelled";
      f.reason = "checkout was cancelled — no charge was made; the free result remains available";
      return f;
    }
    if (event === "checkout_failed") {
      if (["offered", "redirecting", "charging"].indexOf(f.state) === -1) {
        return refuse("no provider checkout is pending");
      }
      f.state = "failed";
      f.reason = "the payment provider could not confirm checkout — no report was unlocked and the free result remains available";
      return f;
    }
    if (event === "refund_requested") {
      if (f.state !== "paid") return refuse("nothing to refund — no completed purchase in this flow");
      var d = refundDecision(f.purchase, payload || {}, ctx && ctx.now);
      if (!d.granted) { f.reason = d.reason; return f; }
      f.purchase.refunded = true;
      f.refund = { amount: d.amount, requested: payload.reason, decided: d.reason, at: (ctx && ctx.now) || Date.now() };
      f.state = "refunded";
      return f;
    }
    return refuse("unknown event");
  }

  // ---- period dashboard (docs/product-strategy.md, "Month-over-month experience") ----
  // Answers the doc's four questions over the measured window, one row per period:
  // what did I pay (actual), why did it change (decomposition), am I still on the best
  // eligible rate (best), what would the switch have saved (difference). Periods are the
  // calendar-month buckets the interval data gives — callers must label them as such,
  // never silently present them as ConEd bill periods.

  // Calendar days in the month a "YYYY-MM" label names.
  function daysInMonth(ym) {
    var m = /^(\d{4})-(\d{1,2})$/.exec(String(ym));
    return m ? new Date(+m[1], +m[2], 0).getDate() : 30;
  }

  // One record per period from parsed input. Days: days actually observed in the
  // bucket when interval data says (a truncated export month is a real partial
  // period), the calendar month otherwise (months-only input can't tell).
  function periodsFrom(parsed) {
    var months = parsed.months ? parsed.months : parsed;
    var hours = parsed.hours || [], byYm = {};
    hours.forEach(function (h) { (byYm[h.ym] || (byYm[h.ym] = [])).push(h); });
    return months.map(function (m) {
      var mo = m.month !== undefined ? m.month : m.mo;
      return {
        ym: m.ym, mo: mo, month: mo, summer: m.summer !== undefined ? !!m.summer : isSummer(mo),
        total: m.total, peak: m.peak, off: m.off,     // costStandard/costTOU read these names
        kwh: m.total, peakKwh: m.peak, offKwh: m.off, // the dashboard's names for the same numbers
        days: m.ndays || daysInMonth(m.ym),
        observedDays: m.ndays || 0,
        hours: byYm[m.ym] || null
      };
    });
  }

  // Price ONE period on ONE plan — the single-period slice of the same
  // costStandard/costTOU/costDemand models the verdict uses, so a plan's
  // periods sum to its window total. Demand plans need that period's hours;
  // without them they are unpriceable (null).
  function pricePeriod(p, planKey, options) {
    options = options || {};
    if (planKey === "standard") {
      var c = costStandard([p]);
      return { plan: "standard", total: c.total, fixed: RATES.standard.customer, variable: c.total - RATES.standard.customer };
    }
    if (planKey === "tou") {
      var t = costTOU([p], options);
      return { plan: "tou", total: t.total, fixed: RATES.tou.customer, variable: t.total - RATES.tou.customer };
    }
    if (planKey === "steady" || planKey === "smart") {
      if (!p.hours || !p.hours.length) return null;
      var plan = planKey === "steady" ? RATES.steadyUse : RATES.smartEnergy;
      var d = costDemand(p.hours, plan);
      return { plan: planKey, demand: true, total: d.total, fixed: plan.customer, variable: d.total - plan.customer };
    }
    return null;
  }

  // Month-over-month change decomposition between two priced periods of the same
  // series. An exact split with no residual — the parts always sum to the change:
  //
  //   Δtotal = calendar + usage + rate + fixed
  //
  //   calendar — more/fewer billed days at the prior period's daily usage and
  //              effective rate (billing-day span; a partial period lands here)
  //   usage    — daily-usage change at the prior effective rate
  //   rate     — effective $/kWh change applied to this period's usage
  //   fixed    — customer-charge difference (nonzero only across prorated bills)
  //
  // a/b: { kwh, days, total, fixed }. Zero usage on either side reads that
  // side's effective rate as 0 instead of dividing by zero.
  function decomposeChange(a, b) {
    var dA = a.days > 0 ? a.days : 1, dB = b.days > 0 ? b.days : 1;
    var fixed = (b.fixed || 0) - (a.fixed || 0);
    var varA = (a.total || 0) - (a.fixed || 0), varB = (b.total || 0) - (b.fixed || 0);
    var rA = a.kwh ? varA / a.kwh : 0, rB = b.kwh ? varB / b.kwh : 0;
    var calendar = (dB - dA) * (a.kwh / dA) * rA;
    var usage = dB * (b.kwh / dB - a.kwh / dA) * rA;
    var rate = (rB - rA) * b.kwh;
    return { calendar: calendar, usage: usage, rate: rate, fixed: fixed, total: (b.total || 0) - (a.total || 0) };
  }

  // The published component whose rate moved most between two billing years —
  // the name behind a nonzero rate effect on reconstructed bills. Null when
  // both years price from the same published period (e.g. 2026 at 2025 rates).
  function rateDriver(yearA, yearB) {
    var pa = billRatePeriod(yearA).rates, pb = billRatePeriod(yearB).rates;
    if (pa === pb) return null;
    var best = null;
    ["delivery", "commodity", "mac", "rdm", "surcharges"].forEach(function (k) {
      var d = pb[k] - pa[k];
      if (!best || Math.abs(d) > Math.abs(best.delta)) best = { component: k, delta: d };
    });
    return best;
  }

  // The per-period table itself. actual = what the CURRENT plan charged:
  // reconstructed component-by-component from the published bill history when
  // the current plan is Standard (that publication's basis), modeled on the
  // plan's own rates otherwise. best = the cheapest ELIGIBLE plan for that
  // period — the per-period answer to "am I still on the best eligible rate".
  function periodDashboard(months, hours, ctx) {
    ctx = ctx || {};
    var cur = ctx.currentPlan || "standard";
    // An explicitly empty eligibility set means there is no valid counterfactual
    // (for example, a non-SC1 or outside-territory account). Do not fall back to
    // the current plan and accidentally label an ineligible charge as "best".
    var eligible = Array.isArray(ctx.eligibleKeys) ? ctx.eligibleKeys.slice() : [cur];
    var rows = [], actualTotal = 0, bestTotal = 0;
    periodsFrom({ months: months, hours: hours }).forEach(function (p) {
      var yearM = /^(\d{4})-/.exec(String(p.ym)), year = yearM ? +yearM[1] : null;
      var actual;
      if (cur === "standard" && year !== null) {
        var rec = reconstructBill({ kwh: p.kwh, year: year });
        actual = { plan: "standard", total: rec.total, fixed: rec.components.customerCharge,
          variable: rec.total - rec.components.customerCharge, reconstructed: rec };
      } else {
        actual = pricePeriod(p, cur, ctx.options);
      }
      var best = null;
      eligible.forEach(function (k) {
        var c = pricePeriod(p, k, ctx.options);
        if (c && (!best || c.total < best.total)) best = c;
      });
      if (!best && !Array.isArray(ctx.eligibleKeys)) best = actual;
      var prev = rows.length ? rows[rows.length - 1] : null;
      var mom = prev && actual ? decomposeChange(
        { kwh: prev.kwh, days: prev.days, total: prev.actual.total, fixed: prev.actual.fixed },
        { kwh: p.kwh, days: p.days, total: actual.total, fixed: actual.fixed }) : null;
      var calendarDays = daysInMonth(p.ym);
      var row = {
        ym: p.ym, days: p.days, observedDays: p.observedDays, calendarDays: calendarDays,
        kwh: p.kwh || 0, peakPct: p.kwh ? p.peakKwh / p.kwh * 100 : 0,
        partial: !!(p.observedDays && p.observedDays < 0.8 * calendarDays),
        actual: actual, best: best, bestKey: best ? best.plan : null,
        difference: actual && best ? actual.total - best.total : null,
        mom: mom, rateDriver: null,
        projected: !!(actual && actual.reconstructed && actual.reconstructed.projected),
        prevDays: prev ? prev.days : null, prevPeakPct: prev ? prev.peakPct : null
      };
      if (mom && prev && prev.actual && actual &&
          prev.actual.reconstructed && actual.reconstructed)
        row.rateDriver = rateDriver(prev.actual.reconstructed.ratePeriod.year, actual.reconstructed.ratePeriod.year);
      rows.push(row);
      if (actual) actualTotal += actual.total;
      if (best) bestTotal += best.total;
    });
    return {
      currentPlan: cur, rows: rows,
      actualTotal: actualTotal, bestTotal: bestTotal,
      difference: rows.length && rows.every(function (r) { return !!r.best; }) ? actualTotal - bestTotal : null,
      partialCount: rows.filter(function (r) { return r.partial; }).length,
      esco: !!ctx.esco
    };
  }

  // RATES key for a plan key ("steady" -> steadyUse, "smart" -> smartEnergy).
  function planRates(key) { return RATES[key === "steady" ? "steadyUse" : key === "smart" ? "smartEnergy" : key] || {}; }
  // Copy the plan metadata (exact display name, basis, eligibility, as-of date) onto a priced plan.
  function enrich(p) {
    var r = planRates(p.key);
    p.short = r.short || p.name;
    p.basis = r.basis || (p.demand ? "demand" : "energy");
    p.eligibility = r.eligibility || null;
    p.formerly = r.formerly || null;
    p.ratesAsOf = r.ratesAsOf || RATES.meta.asOf;
    p.source = r.source || null;
    p.lockIn = (r.lockIn && r.lockIn.note) || null;
    return p;
  }

  // ---- eligibility & lock-in engine ----
  // ConEd's published rules decide which plans are valid alternatives for a given home; the
  // profile carries the facts the customer declares (all optional — defaults describe the home
  // the rate data already assumes: an SC1 · NYC · smart-meter home on Standard).
  var DEFAULT_PROFILE = {
    territory: "nyc",          // nyc | westchester | outside (ConEd electric territory)
    serviceClass: "sc1",       // only SC1 residential is modeled; anything else is out of scope
    meter: "smart",            // smart | legacy — the demand plans require an AMI smart meter
    currentPlan: "standard",   // standard | tou | steady | smart — you can't switch to your own plan
    solar: false,              // net-metered solar changes which plans make sense (advisory)
    esco: false,               // ESCO supply changes both the math and the TOU commitment
    heatPump: false            // unlocks ConEd's 12-month Steady Use price guarantee note
  };
  var PLAN_KEYS = ["standard", "tou", "steady", "smart"];
  var PLAN_ALIASES = {
    standardresidential: "standard",
    "time-of-use": "tou",
    timeofuse: "tou",
    steadyuse: "steady",
    smartenergy: "smart"
  };

  function normalizePlanKey(value) {
    if (value === undefined || value === null || value === "") return null;
    var key = String(value).toLowerCase().replace(/\s+/g, "");
    return PLAN_ALIASES[key] || (PLAN_KEYS.indexOf(key) !== -1 ? key : null);
  }

  function normalizeMonths(value) {
    if (value === undefined || value === null) return null;
    if (typeof value === "string" && value.trim() === "") return null;
    var months = typeof value === "number" ? value : Number(value);
    return isFinite(months) && months >= 0 ? months : null;
  }

  function firstDefined(obj, keys) {
    for (var i = 0; i < keys.length; i++) {
      if (obj && obj[keys[i]] !== undefined && obj[keys[i]] !== null && obj[keys[i]] !== "") return obj[keys[i]];
    }
    return null;
  }

  // Lock-in is based on facts a customer may know without sharing account data:
  // how long they have been on the current plan and, if they recently left one,
  // which plan they left and how many months ago. The per-plan map accepts direct
  // API callers that know the plan-specific fact as well as the compact UI shape.
  // Unknown history is deliberately left unknown; it must not silently become a
  // lock-in exclusion.
  function normalizePlanHistory(raw, root) {
    raw = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    root = root && typeof root === "object" ? root : {};
    var currentMonths = normalizeMonths(firstDefined(raw,
      ["currentPlanMonths", "monthsOnCurrentPlan", "monthsEnrolled"]));
    if (currentMonths === null) currentMonths = normalizeMonths(firstDefined(root,
      ["currentPlanMonths", "monthsOnCurrentPlan", "monthsEnrolled"]));
    var lastPlan = normalizePlanKey(firstDefined(raw,
      ["lastPlan", "previousPlan", "priorPlan", "lastOptedOutPlan"]));
    if (!lastPlan) lastPlan = normalizePlanKey(firstDefined(root,
      ["lastPlan", "previousPlan", "priorPlan", "lastOptedOutPlan"]));
    var monthsSinceExit = normalizeMonths(firstDefined(raw,
      ["monthsSinceExit", "monthsSinceLastPlan", "monthsSinceOptOut"]));
    if (monthsSinceExit === null) monthsSinceExit = normalizeMonths(firstDefined(root,
      ["monthsSinceExit", "monthsSinceLastPlan", "monthsSinceOptOut"]));
    var monthsSinceOptOut = {};

    PLAN_KEYS.forEach(function (key) {
      var aliases = key === "tou" ? ["touMonthsSinceOptOut", "touOptedOutMonthsAgo", "touMonthsSinceExit"]
        : key === "steady" ? ["steadyMonthsSinceOptOut", "steadyOptedOutMonthsAgo", "steadyMonthsSinceExit"]
        : key === "smart" ? ["smartMonthsSinceOptOut", "smartOptedOutMonthsAgo", "smartMonthsSinceExit"] : [];
      var entry = raw[key];
      var value = entry && typeof entry === "object"
        ? firstDefined(entry, ["monthsSinceOptOut", "monthsSinceExit", "monthsSinceLastPlan", "optedOutMonthsAgo"])
        : entry;
      value = normalizeMonths(value);
      if (value === null) {
        var mapped = raw.monthsSinceOptOut && typeof raw.monthsSinceOptOut === "object" ? raw.monthsSinceOptOut : null;
        value = normalizeMonths(firstDefined(mapped, [key]));
      }
      if (value === null) value = normalizeMonths(firstDefined(raw, aliases));
      if (value === null) {
        var rootMapped = root.monthsSinceOptOut && typeof root.monthsSinceOptOut === "object" ? root.monthsSinceOptOut : null;
        value = normalizeMonths(firstDefined(rootMapped, [key]));
      }
      if (value === null) value = normalizeMonths(firstDefined(root, aliases));
      if (value !== null) monthsSinceOptOut[key] = value;
    });
    if (lastPlan && monthsSinceExit !== null && monthsSinceOptOut[lastPlan] === undefined)
      monthsSinceOptOut[lastPlan] = monthsSinceExit;

    return {
      currentPlanMonths: currentMonths,
      lastPlan: lastPlan,
      monthsSinceExit: monthsSinceExit,
      monthsSinceOptOut: monthsSinceOptOut
    };
  }

  function normalizeBoolean(value, fallback) {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      if (/^(?:true|yes|1)$/i.test(value.trim())) return true;
      if (/^(?:false|no|0)$/i.test(value.trim())) return false;
    }
    if (value === 1) return true;
    if (value === 0) return false;
    return fallback;
  }

  function normalizeProfile(raw) {
    raw = raw || {};
    var p = {};
    Object.keys(DEFAULT_PROFILE).forEach(function (k) {
      var v = raw[k], d = DEFAULT_PROFILE[k];
      if (v === undefined || v === null || v === "") { p[k] = d; return; }
      if (typeof d === "boolean") { p[k] = normalizeBoolean(v, d); return; }
      p[k] = String(v).toLowerCase();
    });
    if (p.territory !== "nyc" && p.territory !== "westchester") p.territory = "outside";
    p.serviceClass = p.serviceClass === "sc1" ? "sc1" : "other";
    if (p.meter !== "smart" && p.meter !== "legacy") p.meter = "legacy";
    p.currentPlan = PLAN_ALIASES[p.currentPlan] || p.currentPlan;
    if (PLAN_KEYS.indexOf(p.currentPlan) === -1) p.currentPlan = "standard";
    p.planHistory = normalizePlanHistory(raw.planHistory || raw.history, raw);
    return p;
  }

  function planRequirementReason(key, profile, ctx) {
    var r = planRates(key), requires = r.requires || {};
    if (requires.serviceClass && requires.serviceClass.toLowerCase() !== profile.serviceClass.toLowerCase())
      return "SC1 residential accounts only";
    if (requires.meter && requires.meter !== profile.meter)
      return "requires a smart meter — a traditional meter can't bill on demand";
    if (r.basis === "demand" && !ctx.hasDemand)
      return "requires a smart meter's hourly interval data — your file has none, so it can't even be estimated";
    return null;
  }

  function historyOptOutMonths(profile, key) {
    var history = profile.planHistory || {};
    if (history.monthsSinceOptOut && history.monthsSinceOptOut[key] !== undefined)
      return history.monthsSinceOptOut[key];
    return history.lastPlan === key ? history.monthsSinceExit : null;
  }

  function planHistoryReason(key, profile) {
    var months = historyOptOutMonths(profile, key), r = planRates(key);
    var lockIn = r.lockIn || {};
    if (months === null || months === undefined || !lockIn.reenrollBlockMonths || months >= lockIn.reenrollBlockMonths)
      return null;
    var remaining = lockIn.reenrollBlockMonths - months;
    var unit = remaining === 1 ? "month" : "months";
    var label = key === "tou" ? (r.name || r.short || key) : (r.short || r.name || key);
    return "can't re-enroll in " + label + " for " + lockIn.reenrollBlockMonths +
      " months after opting out (" + months + " months ago; " + remaining + " " + unit + " remaining)";
  }

  // The pure rule check. ctx: { hasDemand: interval hours present, smartCharge: EV what-if on }.
  // Returns { profile, blockers, notes, verdicts } — verdicts[key] =
  // { available, current, reason, notes } for each of the four plans. Blockers invalidate the
  // whole analysis (wrong territory / service class); per-plan notes explain timing, lock-in,
  // and fit caveats on the plans that remain valid.
  function checkEligibility(profileRaw, ctx) {
    var profile = normalizeProfile(profileRaw);
    ctx = ctx || {};
    var blockers = [], notes = [], verdicts = {};
    PLAN_KEYS.forEach(function (key) {
      verdicts[key] = { available: true, current: key === profile.currentPlan, reason: null, notes: [] };
    });
    function each(fn) { PLAN_KEYS.forEach(function (key) { fn(key, verdicts[key]); }); }

    // -- account: the modeled inventory is SC1 residential only
    if (profile.serviceClass !== "sc1") {
      blockers.push("This tool models Con Edison's SC1 residential plans only — a non-residential or non-SC1 account isn't covered, so treat every estimate below as reference, not advice.");
      each(function (key, v) { v.available = false; v.reason = "SC1 residential accounts only"; });
    }

    // -- location: ConEd electric territory; Westchester gets NYC-priced caveat
    if (profile.territory === "outside") {
      blockers.push("This analysis covers Con Edison electric customers (NYC & Westchester) only.");
      each(function (key, v) { if (!v.reason) { v.available = false; v.reason = "not a ConEd electric account"; } });
    } else if (profile.territory === "westchester") {
      notes.push("Your result is priced on ConEd's published NYC SC1 averages — Westchester delivery rates differ, so treat totals as directional.");
    }

    // -- plan requirements: read the published requirements from the plan data so the
    //    same rules apply after a rates.json refresh, rather than duplicating plan-specific
    //    checks in the engine.
    each(function (key, v) {
      var reason = planRequirementReason(key, profile, ctx);
      if (reason) { v.available = false; v.reason = reason; }
    });

    // -- current plan: it stays visible as your baseline, but is never a switch candidate
    verdicts[profile.currentPlan].notes.push("You're already on this plan — shown as your baseline, not a switch option.");

    // -- history: TOU's minimum stay applies while leaving the current plan; each
    //    plan's re-enrollment block applies only to a plan the customer recently
    //    left. The current plan remains visible as the baseline even if the facts
    //    supplied are contradictory, but no unavailable plan can be recommended.
    var currentHistory = profile.planHistory || {};
    var currentLockIn = planRates(profile.currentPlan).lockIn || {};
    if (profile.currentPlan === "tou" && !profile.esco && currentHistory.currentPlanMonths !== null &&
        currentHistory.currentPlanMonths < (currentLockIn.minStayMonths || 0)) {
      var stayMonths = currentLockIn.minStayMonths;
      each(function (key, v) {
        if (key !== profile.currentPlan && v.available)
          v.available = false;
        if (key !== profile.currentPlan && !v.reason)
          v.reason = "TOU requires a " + stayMonths + "-month minimum stay before switching plans (" +
            currentHistory.currentPlanMonths + " months enrolled)";
      });
      verdicts.tou.notes.push("You have been on TOU for " + currentHistory.currentPlanMonths +
        " months; the one-year minimum stay still applies before switching (unless ESCO-supplied).");
    }

    each(function (key, v) {
      if (v.current || !v.available) return;
      var reason = planHistoryReason(key, profile);
      if (reason) { v.available = false; v.reason = reason; }
    });

    // -- solar: ConEd's own guidance is advisory ("not a good fit" / "do not recommend"), so
    //    these are notes rather than exclusions — the customer knows their setup best.
    if (profile.solar) {
      each(function (key, v) {
        var note = planRates(key).solar;
        if (note && v.available) v.notes.push(note);
      });
    }

    // -- ESCO supply: ConEd bills supply at the ESCO contract price, which reshapes both the
    //    math and the terms on every plan
    if (profile.esco) {
      notes.push("You buy supply from an ESCO: ConEd bills supply at your ESCO's contract price, so the time-differentiated supply estimates below don't apply — the delivery-side comparison does.");
      if (verdicts.tou.available) verdicts.tou.notes.push("TOU's one-year commitment doesn't apply to you — ConEd exempts ESCO-supplied homes from it.");
    }

    // -- enrollment timing + lock-in: only meaningful on plans you could actually switch to
    each(function (key, v) {
      if (v.current || !v.available) return;
      if (key === "tou") {
        v.notes.push("Seasonality changes the math: summer (Jun–Sep) TOU peak supply is " + cph(RATES.tou.peakSummer) + " vs " + cph(RATES.tou.peakWinter) + " the rest of the year — check what a summer month does to this estimate before switching.");
      }
      if (key === "steady" && profile.heatPump) {
        v.notes.push("New-to-plan heat-pump homes get ConEd's 12-month price guarantee on Steady Use: if your first year costs more than Standard would have, ConEd credits the difference.");
      }
      var r = planRates(key);
      if (r.lockIn && r.lockIn.note) v.notes.push("Lock-in: " + r.lockIn.note + ".");
    });

    // -- SmartCharge NY conflict: the Steady Use enrollment kicks you off the program
    if (ctx.smartCharge && profile.currentPlan !== "steady" && verdicts.steady.available) {
      var conflict = planRates("steady").smartChargeConflict;
      if (conflict) verdicts.steady.notes.push(conflict);
    }

    return {
      profile: profile, blockers: blockers, notes: notes, verdicts: verdicts,
      eligibleKeys: PLAN_KEYS.filter(function (key) { return verdicts[key].available; })
    };
  }

  function analyze(parsed, options) {
    options = options || {};
    var months = parsed.months ? parsed.months : parsed, hours = parsed.hours, ndays = parsed.ndays || 365;
    var totals = months.reduce(function (a, m) { a.total += m.total; a.peak += m.peak; a.off += m.off; return a; }, { total: 0, peak: 0, off: 0 });
    var factor = (ndays >= 350 && ndays <= 385) ? 1 : (ndays > 0 ? 365 / ndays : 1);
    var stdC = costStandard(months), touC = costTOU(months, options), std = stdC.total, tou = touC.total;
    var plans = [
      enrich({ key: "standard", name: RATES.standard.name, cost: std, breakdown: stdC.lines, avail: true }),
      enrich({ key: "tou", name: RATES.tou.name, cost: tou, breakdown: touC.lines, avail: true, smartChargeNY: touC.smartChargeNY })
    ];
    var hasDemand = !!(hours && hours.length);
    if (hasDemand) {
      var s1 = costDemand(hours, RATES.steadyUse), s2 = costDemand(hours, RATES.smartEnergy);
      plans.push(enrich({ key: "steady", name: RATES.steadyUse.name, cost: s1.total, breakdown: s1.lines, demand: true, eligibility: RATES.steadyUse.eligibility }));
      plans.push(enrich({ key: "smart", name: RATES.smartEnergy.name, cost: s2.total, breakdown: s2.lines, demand: true, eligibility: RATES.smartEnergy.eligibility }));
    }
    // Eligibility & lock-in rules (location, account, meter, current plan, fit, timing, lock-in)
    // decide which priced plans are valid alternatives — excluded ones stay visible with reasons.
    var elig = checkEligibility(options && options.profile, { hasDemand: hasDemand, smartCharge: touC.smartChargeNY.enabled });
    plans.forEach(function (p) {
      var v = elig.verdicts[p.key];
      if (!v) { p.avail = false; p.excludedReason = "not in the modeled inventory"; return; }
      p.avail = !!v.available;
      p.current = !!v.current;
      p.excludedReason = v.available ? null : v.reason;
      p.eligibilityNotes = v.notes.slice();
    });
    var currentPlan = plans.filter(function (p) { return p.current; })[0] || null;
    // A demand-plan current account cannot be treated as Standard merely because the
    // retained/imported input has no hourly readings. There is no defensible baseline
    // cost in that shape, so the result is reference-only until the current plan can be
    // priced. This is especially important to monitoring rechecks, which otherwise could
    // alert from a silently substituted plan.
    if (!currentPlan) {
      var currentRate = planRates(elig.profile.currentPlan);
      elig.blockers.push("Your current " + (currentRate.short || currentRate.name || elig.profile.currentPlan) +
        " plan cannot be priced from this file — import hourly interval data before using its savings comparison.");
    }
    var switchable = currentPlan ? plans.filter(function (p) { return p.avail && !p.current; }) : [];
    var switchTarget = switchable.reduce(function (a, b) { return !a || b.cost < a.cost ? b : a; }, null);
    var cheapest = plans.filter(function (p) { return p.avail === true; })
      .reduce(function (a, b) { return !a || b.cost < a.cost ? b : a; }, null);
    var bestDemand = plans.filter(function (p) { return p.demand && p.avail; }).reduce(function (a, b) { return !a || b.cost < a.cost ? b : a; }, null);
    var curCost = currentPlan ? currentPlan.cost : null;
    // Ranked plan-by-plan comparison: viable plans cheapest-first, excluded ones after (still
    // visible, with the reason), deltas vs the current Standard plan.
    var comparison = plans.map(function (p) {
      return { key: p.key, name: p.name, short: p.short, basis: p.basis, eligibility: p.eligibility, source: p.source, formerly: p.formerly,
        current: !!p.current, estimate: !!p.demand, cost: p.cost, annualCost: p.cost * factor,
        deltaAnnual: (p.cost - std) * factor, ratesAsOf: p.ratesAsOf,
        avail: p.avail !== false, excludedReason: p.excludedReason || null,
        eligibilityNotes: p.eligibilityNotes || [], lockIn: p.lockIn || null };
    }).sort(function (a, b) {
      if (a.avail !== b.avail) return a.avail ? -1 : 1;
      return (a.annualCost - b.annualCost) || ((b.current ? 1 : 0) - (a.current ? 1 : 0));
    });
    // Per-period actual-vs-best table + month-over-month decomposition (the
    // product-strategy dashboard) over the same eligibility verdict.
    var dashboard = periodDashboard(months, hours, {
      currentPlan: elig.profile.currentPlan,
      eligibleKeys: comparison.filter(function (e) { return e.avail; }).map(function (e) { return e.key; }),
      esco: elig.profile.esco === true, options: options
    });
    // Actual billing history (options.bills — bill records parsed from the Green
    // Button Connect billing feed): reconcile each supported bill against the
    // published-rate reconstruction, audit both inputs for missing or incomplete
    // periods, and derive the confidence the verdict may claim before its
    // savings figure.
    var billsIn = (options && options.bills) || [];
    var reconciliation;
    if (elig.profile.currentPlan === "standard") {
      reconciliation = reconcileBills(parsed, billsIn, {});
    } else {
      var normBills = normalizeBills(billsIn);
      reconciliation = {
        complete: normBills.bills.length, incomplete: normBills.incomplete,
        rows: [], unsupported: [], gate: null,
        skipped: "actual-bill reconstruction prices the Standard rate"
      };
    }
    var audit = auditDataQuality(parsed, billsIn);
    var confidence = assessConfidence({
      reconciliation: reconciliation, audit: audit,
      hasHours: hasDemand, ndays: ndays, profile: elig.profile
    });
    var recommendation;
    if (elig.blockers.length) recommendation = "These plans aren't applicable to the account you described — the numbers are reference only. See the warning above your results.";
    else if (!switchTarget) recommendation = "No eligible alternative — " + (currentPlan ? currentPlan.name : "your current plan") + " is the only plan available to you.";
    else if (switchTarget.cost < curCost - 0.005) recommendation = "Switch to " + switchTarget.name + " to save.";
    else recommendation = "Stay on " + (currentPlan ? currentPlan.short || currentPlan.name : "Standard") + " — no plan switch lowers your bill.";
    var result = {
      ndays: ndays, annualFactor: factor, totalKwh: totals.total, peakKwh: totals.peak, offKwh: totals.off,
      peakPct: totals.total ? totals.peak / totals.total * 100 : 0,
      months: months, hours: hours, plans: plans, cheapest: cheapest, hasDemand: hasDemand,
      profile: elig.profile, eligibility: { blockers: elig.blockers, notes: elig.notes, verdicts: elig.verdicts },
      switchTarget: switchTarget,
      comparison: comparison,
      smartChargeNY: touC.smartChargeNY,
      bestDemand: bestDemand, demandOpportunity: bestDemand && bestDemand.cost < std * 0.97,
      standardCost: std, touCost: tou, standardAnnual: std * factor, touAnnual: tou * factor,
      touDelta: tou - std, touDeltaAnnual: (tou - std) * factor,
      // Savings if you leave your current plan for the best eligible alternative — negative
      // means switching can't help. (With the default profile the current plan is Standard.)
      currentPlanKey: elig.profile.currentPlan,
      currentPlanPriced: !!currentPlan,
      savingsIfSwitch: switchTarget && curCost !== null ? curCost - switchTarget.cost : 0,
      recommendation: recommendation,
      dashboard: dashboard,
      reconciliation: reconciliation,
      dataQuality: audit,
      confidence: confidence
    };
    // The free verdict shows the annual opportunity as a RANGE (the strategy's free-result
    // list), and the paid-conversion gate rides on the assembled analysis — eligibility for
    // the offer, the meaningful-savings threshold, and whether charging may happen at all.
    var pcfg = RATES.pricing || {};
    result.savings = savingsRange(curCost * factor, (switchTarget ? switchTarget.cost : curCost) * factor,
      switchTarget && switchTarget.demand ? pcfg.demandBandPct : pcfg.savingsBandPct);
    result.paid = paidConversion(result);
    return result;
  }

  // ---- ZIP support (client-side, deflate) ----
  function inflateRaw(bytes) {
    if (typeof DecompressionStream === "undefined") return Promise.reject(new Error("this browser can't unzip in-page — please unzip and upload the CSV inside."));
    return new Response(new Response(bytes).body.pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer().then(function (ab) { return new Uint8Array(ab); });
  }
  function unzipCsv(buf) {
    var dv = new DataView(buf), u8 = new Uint8Array(buf), n = u8.length, dec = new TextDecoder(), eocd = -1, lim = Math.max(0, n - 22 - 65536);
    for (var i = n - 22; i >= lim; i--) { if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; } }
    if (eocd < 0) return Promise.reject(new Error("that .zip looks corrupt (no directory found)."));
    var cd = dv.getUint32(eocd + 16, true), count = dv.getUint16(eocd + 10, true), p = cd, chosen = null;
    for (var e = 0; e < count; e++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      var entry = { name: dec.decode(u8.subarray(p + 46, p + 46 + dv.getUint16(p + 28, true))), method: dv.getUint16(p + 10, true), compSize: dv.getUint32(p + 20, true), lho: dv.getUint32(p + 42, true) };
      if (/\.(csv|xml)$/i.test(entry.name)) { chosen = entry; break; }
      if (!chosen) chosen = entry;
      p += 46 + dv.getUint16(p + 28, true) + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
    }
    if (!chosen) return Promise.reject(new Error("couldn't find a file inside the .zip."));
    if (dv.getUint32(chosen.lho, true) !== 0x04034b50) return Promise.reject(new Error("that .zip looks corrupt (bad file header)."));
    var start = chosen.lho + 30 + dv.getUint16(chosen.lho + 26, true) + dv.getUint16(chosen.lho + 28, true), comp = u8.subarray(start, start + chosen.compSize);
    if (chosen.method === 0) return Promise.resolve(dec.decode(comp));
    if (chosen.method === 8) return inflateRaw(comp).then(function (raw) { return dec.decode(raw); });
    return Promise.reject(new Error("unsupported compression in the .zip (method " + chosen.method + ")."));
  }

  var api = { RATES: RATES, parse: parse, parseGreenButton: parseGreenButton, parseESPI: parseESPI, costStandard: costStandard, costTOU: costTOU, costDemand: costDemand, analyze: analyze, checkEligibility: checkEligibility, normalizeProfile: normalizeProfile, unzipCsv: unzipCsv, applyRates: applyRates,
    BILL_COMPONENTS: BILL_COMPONENTS, billRatePeriod: billRatePeriod, reconstructBill: reconstructBill, reconcileBill: reconcileBill, accuracyGate: accuracyGate, accuracyThresholds: accuracyThresholds,
    parseBillingESPI: parseBillingESPI, normalizeBills: normalizeBills, reconcileBills: reconcileBills, auditDataQuality: auditDataQuality, assessConfidence: assessConfidence,
    planRates: planRates, daysInMonth: daysInMonth, periodsFrom: periodsFrom, pricePeriod: pricePeriod, decomposeChange: decomposeChange, rateDriver: rateDriver, periodDashboard: periodDashboard,
    savingsRange: savingsRange, paidConversion: paidConversion, CONSENT_FIELDS: CONSENT_FIELDS, validateConsent: validateConsent, refundDecision: refundDecision, newPaymentFlow: newPaymentFlow, paymentTransition: paymentTransition };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ConedCalc = api;
})(typeof window !== "undefined" ? window : globalThis);
