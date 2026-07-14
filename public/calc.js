/* ConEd Rate Optimizer — pure calculation core (no DOM).
   Browser (window.ConedCalc) + Node (module.exports). Estimate only; not affiliated
   with Con Edison. Rate data is overridable at runtime via applyRates() (see rates.json). */
(function (root) {
  "use strict";

  var RATES = {
    meta: {
      version: "1.4.0",
      asOf: "Standard/TOU: 2025 published SC1 NYC averages. TOU & demand rates: current as of 2026-07.",
      utility: "Con Edison",
      serviceClass: "SC1 (Rate I) — NYC Residential",
      basis: "Standard/TOU = ConEd 2025 published SC1 NYC average (grossed up for GRT + sales tax). Demand plans use ConEd's published $/kW delivery rates.",
      updated: "2026-07",
      peakWindow: "Energy plans: peak 8am–midnight, off-peak midnight–8am. Demand plans (Steady Use / Smart Energy): peak weekdays noon–8pm.",
      caveats: [
        "Absolute totals are ±~5%: the monthly Market Supply Charge varies, and 2026 months are priced at 2025 rates.",
        "Standard & Time-of-Use assume delivery/MAC/RDM/surcharges are identical; only supply is time-differentiated.",
        "Steady Use & Smart Energy are DEMAND-based (billed on your peak kW, not total kWh). Delivery uses ConEd's published $/kW rates applied to the peak demand derived from your interval data (avg of the 3 highest hourly demands per period); supply + other charges are held at the standard flat rate because ConEd doesn't publish the exact time-of-use supply rates for these plans. Estimates, best for heat-pump / flat-demand homes.",
        "There is no separate residential EV rate — EV owners use Residential Time-of-Use (priced here) plus SmartCharge NY rebates (a separate program, not modeled).",
        "Estimate only — not affiliated with Con Edison. Verify against your actual bill."
      ],
      sources: [
        "https://www.coned.com/en/accounts-billing/your-bill/time-of-use",
        "https://www.coned.com/en/accounts-billing/steady-use-rate",
        "https://www.coned.com/en/accounts-billing/smart-energy-plan",
        "https://www.coned.com/-/media/files/coned/documents/save-energy-money/using-private-generation/historical-average-full-service-electric-rates.pdf"
      ]
    },
    peakStartHour: 8,
    summerMonths: [6, 7, 8, 9],
    standard: { name: "Standard Residential", allIn: 0.338267, commodity: 0.137533, delivery: 0.183233, customer: 16.33 },
    tou: { name: "Time-of-Use", nonCommodity: 0.338267 - 0.137533, offPeak: 0.0522, peakSummer: 0.2786, peakWinter: 0.1711, gross: 1.10, customer: 21.00 },
    steadyUse: { name: "Steady Use Rate", eligibility: "heat-pump homes", peakStart: 12, peakEnd: 20, demand: { peakSummer: 27.35, peakWinter: 21.04, off: 7.17 }, customer: 16.33 },
    smartEnergy: { name: "Smart Energy Plan", eligibility: "any smart-meter home", peakStart: 12, peakEnd: 20, demand: { peakSummer: 30.68, peakWinter: 23.60, off: 10.06 }, customer: 16.33 }
  };
  RATES._nonDelivery = RATES.standard.allIn - RATES.standard.delivery;

  function isSummer(m) { return RATES.summerMonths.indexOf(m) !== -1; }
  function cph(x) { return (x * 100).toFixed(2) + "¢/kWh"; }
  function fmtKwh(k) { return Math.round(k).toLocaleString("en-US") + " kWh"; }

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
      var b = months[h.ym]; if (!b) months[h.ym] = b = { ym: h.ym, month: h.mo, total: 0, peak: 0, off: 0, summer: isSummer(h.mo) };
      b.total += h.kwh;
      if (h.hour < RATES.peakStartHour) b.off += h.kwh; else b.peak += h.kwh;
    });
    var marr = Object.keys(months).sort().map(function (k) { return months[k]; });
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
      var hm = hourMap[hk]; if (!hm) hourMap[hk] = hm = { ym: ym, mo: dt.mo, hour: hr, weekday: new Date(dt.y, dt.mo - 1, dt.d).getDay(), kwh: 0 };
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
  function parseESPI(xml) {
    if (!_ET) throw new Error("this browser can't parse the XML export — please use the CSV format instead.");
    var mm = /<powerOfTenMultiplier[^>]*>\s*(-?\d+)\s*<\/powerOfTenMultiplier>/.exec(xml);
    var scale = Math.pow(10, mm ? +mm[1] : 0) / 1000;   // reading value (Wh, scaled) -> kWh
    var blocks = xml.match(/<IntervalReading[\s\S]*?<\/IntervalReading>/g) || [];
    var hourMap = {}, days = {}, minD = null, maxD = null, rowN = 0;
    blocks.forEach(function (b) {
      var s = /<start>\s*(\d+)\s*<\/start>/.exec(b), v = /<value>\s*(-?\d+(?:\.\d+)?)\s*<\/value>/.exec(b);
      if (!s || !v) return;
      var e = etParts(+s[1]), kwh = +v[1] * scale;
      if (isNaN(kwh)) return;
      var ym = e.y + "-" + (e.mo < 10 ? "0" + e.mo : e.mo), hk = e.y + "-" + e.mo + "-" + e.d + "-" + e.hour;
      var hm = hourMap[hk]; if (!hm) hourMap[hk] = hm = { ym: ym, mo: e.mo, hour: e.hour, weekday: e.weekday, kwh: 0 };
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
  function costTOU(months) {
    var kwh = 0, noncomm = 0, supplyRaw = 0, cust = 0;
    months.forEach(function (m) { kwh += m.total; noncomm += m.total * RATES.tou.nonCommodity; supplyRaw += m.peak * (m.summer ? RATES.tou.peakSummer : RATES.tou.peakWinter) + m.off * RATES.tou.offPeak; cust += RATES.tou.customer; });
    var supply = supplyRaw * RATES.tou.gross;
    return { total: noncomm + supply + cust, lines: [
      { label: "Delivery + surcharges", detail: fmtKwh(kwh) + " × " + cph(RATES.tou.nonCommodity), amount: noncomm },
      { label: "Supply (time-of-use)", detail: "peak " + cph(RATES.tou.peakSummer) + " summer / " + cph(RATES.tou.peakWinter) + " winter · off-peak " + cph(RATES.tou.offPeak), amount: supply },
      { label: "Basic service charge", detail: "$" + RATES.tou.customer.toFixed(2) + "/mo", amount: cust }
    ] };
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

  function analyze(parsed) {
    var months = parsed.months ? parsed.months : parsed, hours = parsed.hours, ndays = parsed.ndays || 365;
    var totals = months.reduce(function (a, m) { a.total += m.total; a.peak += m.peak; a.off += m.off; return a; }, { total: 0, peak: 0, off: 0 });
    var factor = (ndays >= 350 && ndays <= 385) ? 1 : (ndays > 0 ? 365 / ndays : 1);
    var stdC = costStandard(months), touC = costTOU(months), std = stdC.total, tou = touC.total;
    var plans = [
      { key: "standard", name: RATES.standard.name, cost: std, breakdown: stdC.lines, current: true, avail: true },
      { key: "tou", name: RATES.tou.name, cost: tou, breakdown: touC.lines, avail: true }
    ];
    var hasDemand = !!(hours && hours.length);
    if (hasDemand) {
      var s1 = costDemand(hours, RATES.steadyUse), s2 = costDemand(hours, RATES.smartEnergy);
      plans.push({ key: "steady", name: RATES.steadyUse.name, cost: s1.total, breakdown: s1.lines, demand: true, eligibility: RATES.steadyUse.eligibility });
      plans.push({ key: "smart", name: RATES.smartEnergy.name, cost: s2.total, breakdown: s2.lines, demand: true, eligibility: RATES.smartEnergy.eligibility });
    }
    var cheapest = plans.filter(function (p) { return p.avail; }).reduce(function (a, b) { return b.cost < a.cost ? b : a; });
    var bestDemand = plans.filter(function (p) { return p.demand; }).reduce(function (a, b) { return !a || b.cost < a.cost ? b : a; }, null);
    return {
      ndays: ndays, annualFactor: factor, totalKwh: totals.total, peakKwh: totals.peak, offKwh: totals.off,
      peakPct: totals.total ? totals.peak / totals.total * 100 : 0,
      months: months, hours: hours, plans: plans, cheapest: cheapest, hasDemand: hasDemand,
      bestDemand: bestDemand, demandOpportunity: bestDemand && bestDemand.cost < std * 0.97,
      standardCost: std, touCost: tou, standardAnnual: std * factor, touAnnual: tou * factor,
      touDelta: tou - std, touDeltaAnnual: (tou - std) * factor, savingsIfSwitch: std - cheapest.cost,
      recommendation: cheapest.key === "standard" ? "Stay on Standard — no plan switch lowers your bill." : "Switch to " + cheapest.name + " to save."
    };
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

  var api = { RATES: RATES, parse: parse, parseGreenButton: parseGreenButton, parseESPI: parseESPI, costStandard: costStandard, costTOU: costTOU, costDemand: costDemand, analyze: analyze, unzipCsv: unzipCsv, applyRates: applyRates };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ConedCalc = api;
})(typeof window !== "undefined" ? window : globalThis);
