/* Tariff data gate for public/rates.json — the pre-deploy half of the tariff
   update workflow (docs/tariff-update-workflow.md).

   Validates the tariff data file itself (schema, units, cross-field
   consistency, effective-period coverage, freshness of meta.reviewedThrough
   and of each plan's own ratesAsOf against its source's re-verification
   cadence — read from the workflow doc's §2 source table at run time, so gate
   and doc cannot drift) and its mirror discipline against the defaults baked
   into public/calc.js.

   Usage:
     node scripts/validate-rates.js              # the gate — exits 1 on any error
     node scripts/validate-rates.js --allow-stale  # gate, but stale reviewedThrough / cadence ages warn instead of failing
     node scripts/validate-rates.js --self-test    # run the validator against mutated copies of itself

   Exit codes: 0 = no errors (warnings may print), 1 = errors or self-test failure. */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const RATES_PATH = path.join(ROOT, "public", "rates.json");
const CALC_PATH = path.join(ROOT, "public", "calc.js");
const DOC_PATH = path.join(ROOT, "docs", "tariff-update-workflow.md");

// Plans the tool prices (smartChargeNY is an incentive what-if, not a priced plan).
const PRICED_PLANS = ["standard", "tou", "steadyUse", "smartEnergy"];
const ALL_PLAN_KEYS = PRICED_PLANS.concat(["smartChargeNY"]);

// Freshness policy (docs/tariff-update-workflow.md §Freshness): the UI banner
// (app.js checkStaleness) tells users rates "may be out of date" past STALE_FAIL
// months, so shipping such data silently is a gate failure, not a warning.
const STALE_WARN_MONTHS = 4;
const STALE_FAIL_MONTHS = 6;

// Per-source re-verification cadence (docs/tariff-update-workflow.md §2): how
// old a plan's own verification may get before the gate complains. These are
// the machine-readable reading of the §2 table's Cadence column — "checked at
// least quarterly" = fail past 95 days (a quarter plus a grace week),
// "Annual" = fail past 13 months (a year plus the PDF's published-on-a-lag
// month) — each with a heads-up warning at ~2/3 of the window, matching the
// reviewedThrough warn/fail ratio above. The table itself is parsed at run
// time (loadCadences), so the doc stays the single authority: a cadence
// reworded in the doc without a matching rule here fails the gate loudly
// instead of silently drifting.
const CADENCE_RULES = [
  { re: /quarterly/i, label: "quarterly", warn: { days: 60 }, fail: { days: 95 } },
  { re: /annual|yearly/i, label: "annual", warn: { months: 9 }, fail: { months: 13 } },
];

const EPS_ADJ = 0.05;   // allIn vs delivery + commodity — the gap is MAC/RDM/surcharges, cents-scale
const EPS_TIE = 1e-3;   // latest bill period vs standard (both are the same ConEd publication)

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function clone(v) {
  return JSON.parse(JSON.stringify(v));
}
function isPos(v) {
  return typeof v === "number" && isFinite(v) && v > 0;
}
function isHttps(v) {
  return typeof v === "string" && /^https:\/\/\S+$/.test(v);
}
function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
// Whole-month difference, UTC on both sides (app.js checkStaleness does the
// same arithmetic in local time; UTC keeps the gate TZ-independent).
function monthsSince(isoDate, now) {
  const r = new Date(isoDate + "T00:00:00Z");
  return (now.getUTCFullYear() - r.getUTCFullYear()) * 12 + (now.getUTCMonth() - r.getUTCMonth());
}
function daysSince(isoDate, now) {
  return Math.floor((now.getTime() - new Date(isoDate + "T00:00:00Z").getTime()) / 86400000);
}
// Age past a cadence window, compared in the window's own unit (days for the
// quarterly sources, whole calendar months for the annual PDF).
function pastWindow(isoDate, now, win) {
  return win.days !== undefined ? daysSince(isoDate, now) > win.days
                                : monthsSince(isoDate, now) > win.months;
}
function windowName(win) {
  return win.days !== undefined ? `${win.days}-day` : `${win.months}-month`;
}
function ageIn(win, isoDate, now) {
  return win.days !== undefined ? `${daysSince(isoDate, now)} days` : `${monthsSince(isoDate, now)} months`;
}
function normalizeUrl(u) {
  return String(u || "").trim().replace(/\/+$/, "").toLowerCase();
}
/* Verification dates recorded in a ratesAsOf string, normalized to YYYY-MM-DD
   and sorted ascending — the latest is the most recent re-verification, and
   that is what cadence staleness measures. Month precision ("verified
   2026-07") is fine; a bare publication year ("2025 published averages") is
   deliberately not accepted — it names the publication, not the verification. */
function verificationDates(s) {
  if (typeof s !== "string") return [];
  const found = s.match(/\b\d{4}-\d{2}(?:-\d{2})?\b/g) || [];
  const out = [];
  found.forEach((d) => {
    const full = d.length === 7 ? d + "-01" : d;
    if (!isNaN(new Date(full + "T00:00:00Z").getTime())) out.push(full);
  });
  return out.sort();
}

/* ---- the cadence source table: parsed from the workflow doc at run time ----
   The §2 "Sources — what is authoritative" table is the single authority for
   how stale each publication's verification may get; the gate reads it rather
   than a private copy, so the doc and the gate cannot drift. Returns
   { byUrl: Map<normalized source URL, cadence rule>, errors } — errors mean
   the table itself is unreadable or reworded past recognition, which is a
   gate failure, never a silent skip. */
function loadCadences(docPath) {
  const byUrl = new Map();
  const errors = [];
  let text = null;
  try { text = fs.readFileSync(docPath, "utf8"); } catch (e) { /* reported below */ }
  if (text === null) {
    errors.push(`cadence source table: cannot read ${path.relative(ROOT, docPath)} — the gate takes each ` +
                `source's re-verification cadence from the workflow doc's §2 table so the two cannot drift`);
    return { byUrl, errors };
  }
  let inTable = false;
  for (const line of text.split("\n")) {
    if (!/^\s*\|/.test(line)) { if (inTable) break; continue; }  // the table ends at its first non-row line
    const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    if (cells.every((c) => /^:?-{3,}:?$/.test(c))) continue;     // header separator row
    if (!inTable) {
      if (/^publication/i.test(cells[0] || "") && /^cadence/i.test(cells[cells.length - 1] || "")) inTable = true;
      continue;
    }
    const url = (cells[0].match(/\]\((\S+?)\)/) || [])[1];
    const phrase = cells[cells.length - 1];
    if (!url) {
      errors.push(`cadence source table: row has no [publication](url) link: "${cells[0].slice(0, 80)}"`);
      continue;
    }
    const rule = CADENCE_RULES.find((r) => r.re.test(phrase));
    if (!rule) {
      errors.push(`cadence source table: cadence "${phrase}" for ${url} matches no known window — reword it ` +
                  `(quarterly / annual) or extend CADENCE_RULES in scripts/validate-rates.js`);
      continue;
    }
    byUrl.set(normalizeUrl(url), rule);
  }
  if (!inTable) {
    errors.push(`cadence source table: no Publication/Cadence table found in ${path.relative(ROOT, docPath)} §2`);
  }
  return { byUrl, errors };
}

/* The validator. Pure: no I/O, no clock — `now` is injected so --self-test can
   exercise the freshness checks deterministically. Returns { errors, warnings }
   with human-readable messages that name the offending key. */
function validate(rates, calcRates, opts) {
  const now = opts.now;
  const errors = [];
  const warnings = [];
  const err = (msg) => errors.push(msg);
  const warn = (msg) => warnings.push(msg);

  // ---- file shape ----
  if (!isPlainObject(rates)) {
    err("rates.json must be a JSON object");
    return { errors, warnings };
  }
  if (typeof rates._comment !== "string" || rates._comment.length < 20) {
    err("rates.json: _comment must explain the file's role (edit + redeploy, no code change)");
  }

  // ---- meta & freshness ----
  const meta = rates.meta;
  if (!isPlainObject(meta)) {
    err("meta: section missing (reviewedThrough, asOf, switchTiming)");
  } else {
    if (typeof meta.reviewedThrough !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(meta.reviewedThrough)) {
      err(`meta.reviewedThrough: must be an ISO date YYYY-MM-DD (got ${JSON.stringify(meta.reviewedThrough)})`);
    } else if (isNaN(new Date(meta.reviewedThrough + "T00:00:00Z").getTime())) {
      err(`meta.reviewedThrough: not a real date (${meta.reviewedThrough})`);
    } else {
      const months = monthsSince(meta.reviewedThrough, now);
      if (months >= STALE_FAIL_MONTHS && !opts.allowStale) {
        err(`meta.reviewedThrough: rate data is ${months} months old (verified through ${meta.reviewedThrough}; ` +
            `gate fails at ${STALE_FAIL_MONTHS}). Re-verify against coned.com and bump the date, ` +
            `or run with --allow-stale to ship knowingly (the UI banner tells users it may be out of date).`);
      } else if (months >= STALE_WARN_MONTHS) {
        warn(`meta.reviewedThrough: rate data is ${months} months old — due for a source re-verification` +
             (opts.allowStale ? " (--allow-stale: shipping stale knowingly)" : ""));
      }
    }
    if (typeof meta.asOf !== "string" || !meta.asOf) err("meta.asOf: must describe what the rates are current as of");
    if (typeof meta.switchTiming !== "string" || !meta.switchTiming) err("meta.switchTiming: must carry the meter-read switch-timing note");
  }

  // calc.js-side release metadata the workflow requires on every tariff change.
  const calcMeta = (calcRates && calcRates.meta) || {};
  if (!/^\d+\.\d+\.\d+$/.test(String(calcMeta.version || ""))) {
    err(`calc.js meta.version: must be semver X.Y.Z (got ${JSON.stringify(calcMeta.version)})`);
  }
  if (!/^\d{4}-\d{2}$/.test(String(calcMeta.updated || ""))) {
    err(`calc.js meta.updated: must be YYYY-MM (got ${JSON.stringify(calcMeta.updated)})`);
  }
  if (meta && meta.version && meta.version !== calcMeta.version) {
    warn(`meta.version: rates.json says ${meta.version} but calc.js says ${calcMeta.version} — bump both together`);
  }

  // ---- plans: presence, metadata, rate fields by pricing basis ----
  ALL_PLAN_KEYS.forEach((key) => {
    if (!isPlainObject(rates[key])) err(`${key}: plan missing from rates.json`);
  });
  if (!isPlainObject(calcRates)) return { errors, warnings };

  Object.keys(rates).forEach((key) => {
    if (key === "_comment" || key === "meta" || key === "bill" || key === "accuracy") return;
    if (!isPlainObject(calcRates[key])) err(`${key}: not a plan the engine knows (calc.js has no such section) — typo or a plan added to rates.json only`);
  });

  PRICED_PLANS.forEach((key) => {
    const p = rates[key];
    if (!isPlainObject(p)) return;
    ["name", "short", "basis", "eligibility", "ratesAsOf"].forEach((f) => {
      if (typeof p[f] !== "string" || !p[f]) err(`${key}.${f}: required non-empty string`);
    });
    if (!isHttps(p.source)) err(`${key}.source: required https URL to the ConEd publication the rates come from`);
    if (p.basis !== "energy" && p.basis !== "demand") {
      err(`${key}.basis: must be "energy" or "demand" (got ${JSON.stringify(p.basis)})`);
    }
    if (!isPlainObject(p.requires) || p.requires.serviceClass !== "SC1") {
      err(`${key}.requires.serviceClass: must be "SC1" (the tool models SC1 residential only)`);
    }
    if (p.basis === "energy" && key === "standard") {
      // Standard is the only plan carrying the full flat rate: allIn folds in the
      // MAC/RDM/surcharge adjustments on top of delivery + commodity (see RATES.bill).
      ["allIn", "commodity", "delivery", "customer"].forEach((f) => {
        if (!isPos(p[f])) err(`${key}.${f}: required positive number in $/kWh`);
      });
      if (isPos(p.allIn) && (p.allIn < 0.05 || p.allIn > 2)) {
        err(`${key}.allIn: ${p.allIn} $/kWh is outside the plausible range (0.05–2) — unit slip? Cents must be expressed as $/kWh`);
      }
      if (isPos(p.allIn) && isPos(p.delivery) && isPos(p.commodity)) {
        const adjust = p.allIn - (p.delivery + p.commodity);
        if (Math.abs(adjust) > EPS_ADJ) {
          err(`${key}.allIn (${p.allIn}) differs from delivery + commodity (${(p.delivery + p.commodity).toFixed(6)}) ` +
              `by ${adjust.toFixed(6)} $/kWh — only the cents-scale MAC/RDM/surcharge adjustments may sit between them`);
        }
      }
    }
    if (p.basis === "energy" && key === "tou") {
      // TOU differentiates supply only; its delivery side is standard's (calc.js derives
      // nonCommodity from standard.allIn − standard.commodity), so it carries no allIn here.
      if (p.allIn !== undefined || p.commodity !== undefined || p.delivery !== undefined) {
        err(`tou: carries flat-rate fields (allIn/commodity/delivery) it must not have — TOU supply is ` +
            `offPeak/peakSummer/peakWinter and the non-commodity side derives from standard`);
      }
    }
    if (p.basis === "demand") {
      if (!isPlainObject(p.demand)) {
        err(`${key}.demand: required for a demand-basis plan (peakSummer, peakWinter, off in $/kW)`);
      } else {
        ["peakSummer", "peakWinter", "off"].forEach((f) => {
          if (!isPos(p.demand[f])) err(`${key}.demand.${f}: required positive number in $/kW`);
          else if (p.demand[f] < 0.5 || p.demand[f] > 150) {
            err(`${key}.demand.${f}: ${p.demand[f]} $/kW is outside the plausible range (0.5–150) — unit slip?`);
          }
        });
        if (isPos(p.demand.peakSummer) && isPos(p.demand.peakWinter) && isPos(p.demand.off) &&
            !(p.demand.peakSummer >= p.demand.peakWinter && p.demand.peakWinter >= p.demand.off)) {
          err(`${key}.demand: expected peakSummer ≥ peakWinter ≥ off, got ` +
              `${p.demand.peakSummer} / ${p.demand.peakWinter} / ${p.demand.off}`);
        }
      }
      if (typeof p.peakWindow !== "string" || !p.peakWindow) err(`${key}.peakWindow: required for a demand-basis plan`);
    }
    if (!isPos(p.customer)) err(`${key}.customer: required positive monthly charge in $`);
  });

  // TOU-specific shape and seasonal ordering (summer peak supply is ConEd's most
  // expensive residential energy rate; winter sits between it and off-peak).
  const tou = rates.tou;
  if (isPlainObject(tou)) {
    ["offPeak", "peakSummer", "peakWinter"].forEach((f) => {
      if (!isPos(tou[f])) err(`tou.${f}: required positive number in $/kWh`);
    });
    if (isPos(tou.offPeak) && isPos(tou.peakWinter) && isPos(tou.peakSummer) &&
        !(tou.offPeak <= tou.peakWinter && tou.peakWinter <= tou.peakSummer)) {
      err(`tou: expected offPeak ≤ peakWinter ≤ peakSummer, got ` +
          `${tou.offPeak} / ${tou.peakWinter} / ${tou.peakSummer} $/kWh`);
    }
    if (!isPos(tou.gross) || tou.gross < 1 || tou.gross > 1.5) {
      err(`tou.gross: required gross-up multiplier in [1, 1.5] (got ${JSON.stringify(tou.gross)})`);
    }
  }

  // SmartCharge NY (what-if incentive, not a priced plan).
  const sc = rates.smartChargeNY;
  if (isPlainObject(sc)) {
    if (!isPos(sc.offPeakCredit) || sc.offPeakCredit > 1) {
      err(`smartChargeNY.offPeakCredit: required positive $/kWh credit ≤ 1 (got ${JSON.stringify(sc.offPeakCredit)})`);
    }
    if (typeof sc.offPeakWindow !== "string" || !sc.offPeakWindow) err("smartChargeNY.offPeakWindow: required");
    ["eligibility", "ratesAsOf"].forEach((f) => {
      if (typeof sc[f] !== "string" || !sc[f]) err(`smartChargeNY.${f}: required non-empty string`);
    });
    if (!isHttps(sc.source)) err("smartChargeNY.source: required https URL");
  }

  // ---- per-source re-verification cadence (docs/tariff-update-workflow.md §2) ----
  // meta.reviewedThrough is the file-wide freshness anchor (checked above);
  // this is the per-plan half: each publication's own cadence, measured from
  // the latest verification date recorded in that plan's ratesAsOf prose. A
  // plan can be current in age-checked terms while its page quietly lapses —
  // e.g. a quarterly page nobody has re-checked since spring passes a
  // reviewedThrough bump that only the annual PDF deserved.
  const cadences = opts.cadences;
  if (cadences) {
    ALL_PLAN_KEYS.forEach((key) => {
      const p = rates[key];
      if (!isPlainObject(p)) return;
      if (!isHttps(p.source)) return; // already errored above; nothing to look up
      const cad = cadences.get(normalizeUrl(p.source));
      if (!cad) {
        err(`${key}.source: no row in the docs/tariff-update-workflow.md §2 source table names this publication — ` +
            `every plan source needs a row there (with its re-verification cadence) or the gate cannot enforce it`);
        return;
      }
      const dates = verificationDates(p.ratesAsOf);
      if (!dates.length) {
        err(`${key}.ratesAsOf: carries no verification date (add YYYY-MM or YYYY-MM-DD, e.g. "… verified 2026-07") — ` +
            `the §2 fetching discipline records the snapshot date in this string, and the ${cad.label} ` +
            `cadence can't be checked without one`);
        return;
      }
      const latest = dates[dates.length - 1];
      const verified = `last verified ${latest}, ${ageIn(cad.fail, latest, now)} ago`;
      if (pastWindow(latest, now, cad.fail) && !opts.allowStale) {
        err(`${key}.ratesAsOf: ${cad.label} source (${windowName(cad.fail)} re-verification cadence, ` +
            `docs/tariff-update-workflow.md §2) ${verified} — past the window. Re-check the publication ` +
            `(Wayback, per §2) and update the date, or run with --allow-stale to ship knowingly.`);
      } else if (pastWindow(latest, now, cad.warn)) {
        warn(`${key}.ratesAsOf: ${cad.label} source ${verified} — re-verification due before the ` +
             `${windowName(cad.fail)} gate line` +
             (opts.allowStale ? " (--allow-stale: shipping stale knowingly)" : ""));
      }
    });
  }

  // ---- bill history: the effective-period table ----
  const bill = rates.bill;
  if (!isPlainObject(bill) || !Array.isArray(bill.periods) || bill.periods.length === 0) {
    err("bill.periods: required non-empty array of { year, delivery, commodity, mac, rdm, surcharges }");
  } else {
    let prevYear = 0;
    bill.periods.forEach((per, i) => {
      const label = `bill.periods[${i}] (${per && per.year})`;
      if (!isPlainObject(per)) { err(`${label}: must be an object`); return; }
      if (!Number.isInteger(per.year)) err(`${label}.year: required integer`);
      else if (per.year <= prevYear) err(`${label}.year: periods must be strictly increasing by year (got ${per.year} after ${prevYear})`);
      else prevYear = per.year;
      let sum = 0;
      ["delivery", "commodity", "mac", "rdm", "surcharges"].forEach((f) => {
        if (typeof per[f] !== "number" || !isFinite(per[f])) err(`${label}.${f}: required number in $/kWh (rdm may be negative)`);
        else sum += per[f];
      });
      if (sum > 0 && (sum < 0.05 || sum > 2)) {
        err(`${label}: component sum ${sum.toFixed(6)} $/kWh is outside the plausible range — unit slip?`);
      }
    });

    const last = bill.periods[bill.periods.length - 1];
    const std = rates.standard;
    if (isPlainObject(last) && isPlainObject(std) && isPos(std.allIn) && isPos(std.commodity) &&
        typeof last.delivery === "number") {
      const sum = ["delivery", "commodity", "mac", "rdm", "surcharges"].reduce((a, f) => a + (per_num(last, f) || 0), 0);
      // standard.* IS the latest published year of the same ConEd historical-averages
      // PDF bill.periods comes from — the two must move together.
      if (Math.abs(sum - std.allIn) > EPS_TIE) {
        err(`bill.periods: latest period (${last.year}) sums to ${sum.toFixed(6)} $/kWh but standard.allIn is ` +
            `${std.allIn} — both come from the same ConEd historical-averages publication, so update ` +
            `standard.* and add the matching bill.periods year together`);
      }
      if (typeof last.commodity === "number" && Math.abs(last.commodity - std.commodity) > EPS_TIE) {
        err(`bill.periods: latest period (${last.year}) commodity ${last.commodity} ≠ standard.commodity ` +
            `${std.commodity} — update both sides of the publication together`);
      }
    }

    if (Number.isInteger(last && last.year) && last.year < now.getUTCFullYear()) {
      warn(`bill.periods: no period for the current year (${now.getUTCFullYear()}) — usage is priced at the ` +
           `${last.year} average and reconstructBill flags it "projected" (ConEd publishes on a lag; keep the ` +
           `meta caveat that says so)`);
    }
    if (typeof bill.basis !== "string" || !bill.basis) err("bill.basis: required description of the publication");
    if (!isHttps(bill.source)) err("bill.source: required https URL");
  }

  // ---- accuracy policy ----
  const acc = rates.accuracy;
  if (!isPlainObject(acc)) {
    err("accuracy: section missing (passPct, warnPct, gateFraction)");
  } else {
    if (!isPos(acc.passPct)) err("accuracy.passPct: required positive number (percent)");
    if (!isPos(acc.warnPct)) err("accuracy.warnPct: required positive number (percent)");
    if (isPos(acc.passPct) && isPos(acc.warnPct) && acc.passPct >= acc.warnPct) {
      err(`accuracy: passPct (${acc.passPct}) must be < warnPct (${acc.warnPct})`);
    }
    if (typeof acc.gateFraction !== "number" || !(acc.gateFraction > 0) || acc.gateFraction > 1) {
      err(`accuracy.gateFraction: required fraction in (0, 1] (got ${JSON.stringify(acc.gateFraction)})`);
    }
  }

  // ---- mirror discipline: rates.json vs the defaults baked into calc.js ----
  // Rule/provenance data must match exactly (the eligibility engine and the test
  // suite's mirroring tests depend on it). Numeric tariff values may diverge —
  // rates.json is the runtime override — but divergence is always flagged so it
  // is a decision, never an accident.
  const MIRROR_EXACT = ["name", "short", "formerly", "basis", "eligibility", "ratesAsOf", "source",
                        "requires", "lockIn", "solar", "smartChargeConflict"];
  const MIRROR_NUMERIC = ["allIn", "commodity", "delivery", "customer", "offPeak", "peakSummer",
                          "peakWinter", "gross", "offPeakCredit"];
  ALL_PLAN_KEYS.forEach((key) => {
    const r = rates[key];
    const c = calcRates[key];
    if (!isPlainObject(r) || !isPlainObject(c)) return;
    MIRROR_EXACT.forEach((f) => {
      if (r[f] === undefined && c[f] === undefined) return;
      if (!sameJson(r[f] === undefined ? null : r[f], c[f] === undefined ? null : c[f])) {
        err(`${key}.${f}: rates.json and calc.js defaults disagree — rule/provenance data must be ` +
            `identical in both (update both files in the same change)`);
      }
    });
    MIRROR_NUMERIC.forEach((f) => {
      if (r[f] !== undefined && c[f] !== undefined && r[f] !== c[f]) {
        warn(`${key}.${f}: rates.json (${r[f]}) overrides calc.js default (${c[f]}) — ` +
             `allowed (rates.json is the runtime override) but keep both mirrored in the same release`);
      }
    });
    ["demand", "peakWindow"].forEach((f) => {
      if (r[f] !== undefined && c[f] !== undefined && !sameJson(r[f], c[f])) {
        warn(`${key}.${f}: rates.json overrides the calc.js default — keep both mirrored in the same release`);
      }
    });
  });
  ["asOf", "switchTiming"].forEach((f) => {
    if (meta && meta[f] !== undefined && calcMeta[f] !== undefined && meta[f] !== calcMeta[f]) {
      warn(`meta.${f}: rates.json and calc.js wording differ — keep the user-facing note identical in both`);
    }
  });

  return { errors, warnings };
}

function per_num(obj, f) {
  return typeof obj[f] === "number" && isFinite(obj[f]) ? obj[f] : null;
}

/* ---- self-test: mutate a known-good copy, assert the gate catches each defect ---- */
function selfTest() {
  const rates = JSON.parse(fs.readFileSync(RATES_PATH, "utf8"));
  const calc = require(CALC_PATH);
  const cad = loadCadences(DOC_PATH);
  const now = new Date();
  const failures = [];
  let total = 0;
  const check = (label, cond) => {
    total++;
    if (!cond) failures.push(label);
  };
  const vopts = (o) => Object.assign({ now, cadences: cad.byUrl }, o || {});

  // The cadence table parses out of the workflow doc; without it the per-source
  // checks below would all fail for the wrong reason.
  check("cadence source table parses from docs/tariff-update-workflow.md §2",
        cad.errors.length === 0 && cad.byUrl.size >= ALL_PLAN_KEYS.length);
  if (cad.errors.length) {
    cad.errors.forEach((e) => console.error(`    cadence table error: ${e}`));
  }

  // Known-good baseline: the shipped data with a fresh reviewedThrough so the
  // happy path never ages out. Must produce zero errors (warnings are fine).
  const base = clone(rates);
  base.meta.reviewedThrough = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15))
    .toISOString().slice(0, 10);
  const baseOut = validate(base, calc.RATES, vopts());
  check("baseline copy of shipped rates.json validates with zero errors", baseOut.errors.length === 0);
  if (baseOut.errors.length) {
    baseOut.errors.forEach((e) => console.error(`    baseline error: ${e}`));
  }

  const mutant = (label, needle, fn, opts) => {
    const m = clone(base);
    fn(m);
    const out = validate(m, calc.RATES, vopts(opts));
    const hit = out.errors.some((e) => needle.test(e));
    check(`${label} — error matching ${needle}`, hit);
    if (!hit) {
      console.error(`    ${label}: expected error matching ${needle}, got ` +
        JSON.stringify(out.errors.concat(out.warnings), null, 2));
    }
    return out;
  };

  mutant("missing plan section", /standard: plan missing/, (m) => { delete m.standard; });
  mutant("unknown plan section", /not a plan the engine knows/, (m) => { m.bogusPlan = m.standard; });
  mutant("missing required rate field", /tou\.offPeak: required/, (m) => { delete m.tou.offPeak; });
  mutant("allIn far from delivery + commodity", /differs from delivery \+ commodity/, (m) => { m.standard.allIn = 0.5; });
  mutant("latest bill period not tied to standard", /same ConEd historical-averages publication/,
         (m) => { m.standard.allIn = 0.300001; });
  mutant("TOU seasonal ordering broken", /offPeak ≤ peakWinter ≤ peakSummer/, (m) => { m.tou.peakSummer = 0.01; });
  mutant("demand rate out of plausible range", /demand\.peakSummer: .*outside the plausible range/,
         (m) => { m.steadyUse.demand.peakSummer = 0.02; });
  mutant("non-https source", /standard\.source: required https/, (m) => { m.standard.source = "http://example.com/rates"; });
  mutant("bill periods out of order", /strictly increasing by year/, (m) => { m.bill.periods.reverse(); });
  mutant("bill period missing a component", /bill\.periods\[2\].*mac: required/, (m) => { delete m.bill.periods[2].mac; });
  mutant("accuracy gate fraction > 1", /gateFraction: required fraction/, (m) => { m.accuracy.gateFraction = 1.5; });
  mutant("missing reviewedThrough", /meta\.reviewedThrough: must be an ISO date/, (m) => { delete m.meta.reviewedThrough; });
  mutant("stale reviewedThrough fails the gate", /rate data is 7 months old/,
         (m) => { m.meta.reviewedThrough = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 7, 15))
           .toISOString().slice(0, 10); });

  // --allow-stale downgrades the same staleness to a warning (mutant() asserts a
  // needle fires; this asserts the absence of the freshness error instead).
  const staleAllowed = clone(base);
  staleAllowed.meta.reviewedThrough = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 7, 15))
    .toISOString().slice(0, 10);
  const staleOut = validate(staleAllowed, calc.RATES, { now, allowStale: true });
  check("--allow-stale downgrades staleness to a warning, not an error",
        staleOut.errors.length === 0 && staleOut.warnings.some((w) => /allow-stale/.test(w)));

  // Numeric override is a warning, never an error.
  const overridden = clone(base);
  overridden.standard.customer = base.standard.customer + 0.66;
  const ovOut = validate(overridden, calc.RATES, { now });
  check("numeric override of a calc.js default warns without failing",
        ovOut.errors.length === 0 && ovOut.warnings.some((w) => /standard\.customer.*overrides/.test(w)));

  // Rule-data divergence is an error (mirror discipline).
  mutant("lockIn divergence from calc.js", /steadyUse\.lockIn: rates\.json and calc\.js defaults disagree/,
         (m) => { m.steadyUse.lockIn.reenrollBlockMonths = 24; });
  mutant("ratesAsOf divergence from calc.js", /tou\.ratesAsOf: rates\.json and calc\.js defaults disagree/,
         (m) => { m.tou.ratesAsOf = "unverified"; });

  // Per-source cadence (docs/tariff-update-workflow.md §2): back-dating a
  // plan's ratesAsOf past its source's cadence window fails the gate.
  mutant("quarterly source past its cadence window", /tou\.ratesAsOf: quarterly source/,
         (m) => { m.tou.ratesAsOf = "residential TOU supply rates current as of 2025-01"; });
  mutant("annual source past its cadence window", /standard\.ratesAsOf: annual source/,
         (m) => { m.standard.ratesAsOf = "2025 published SC1 NYC averages; PDF verified 2025-01"; });
  mutant("ratesAsOf with no verification date", /steadyUse\.ratesAsOf: carries no verification date/,
         (m) => { m.steadyUse.ratesAsOf = "delivery $/kW rates current as of mid-2026"; });
  mutant("plan source absent from the §2 cadence table", /smartEnergy\.source: no row in the docs/,
         (m) => { m.smartEnergy.source = "https://www.coned.com/en/accounts-billing/some-other-page"; });

  // --allow-stale downgrades a stale per-source cadence too. The mirror
  // discipline would otherwise also error on the ratesAsOf divergence, so this
  // mutant mirrors the string into the calc.js side it is validated against —
  // the only seeded defect is the stale cadence.
  const staleCadenceAllowed = clone(base);
  staleCadenceAllowed.tou.ratesAsOf = "residential TOU supply rates current as of 2025-01";
  const calcForIt = clone(calc.RATES);
  calcForIt.tou.ratesAsOf = staleCadenceAllowed.tou.ratesAsOf;
  const scaOut = validate(staleCadenceAllowed, calcForIt, vopts({ allowStale: true }));
  check("--allow-stale downgrades a stale per-source cadence to a warning, not an error",
        scaOut.errors.length === 0 &&
        scaOut.warnings.some((w) => /tou\.ratesAsOf: quarterly source.*allow-stale/.test(w)));

  if (failures.length) {
    console.error(`self-test FAILED (${failures.length}/${total} checks):`);
    failures.forEach((f) => console.error(`  ✗ ${f}`));
    return false;
  }
  console.log(`self-test: all ${total} validator checks behave as documented`);
  return true;
}

/* ---- CLI ---- */
function main() {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) {
    process.exit(selfTest() ? 0 : 1);
  }
  const allowStale = args.includes("--allow-stale");

  let rates;
  try {
    rates = JSON.parse(fs.readFileSync(RATES_PATH, "utf8"));
  } catch (e) {
    console.error(`validate-rates: cannot parse ${path.relative(ROOT, RATES_PATH)}: ${e.message}`);
    process.exit(1);
  }
  const calc = require(CALC_PATH);
  const cad = loadCadences(DOC_PATH);
  const { errors, warnings } = validate(rates, calc.RATES, { now: new Date(), allowStale, cadences: cad.byUrl });
  const allErrors = cad.errors.concat(errors);

  warnings.forEach((w) => console.warn(`WARN: ${w}`));
  allErrors.forEach((e) => console.error(`FAIL: ${e}`));
  if (allErrors.length) {
    console.error(`\nvalidate-rates: ${allErrors.length} error(s), ${warnings.length} warning(s) — ` +
                  `fix rates.json/calc.js before deploying (docs/tariff-update-workflow.md)`);
    process.exit(1);
  }
  console.log(`validate-rates: OK — rates.json is complete, internally consistent, and fresh ` +
              `(reviewedThrough ${rates.meta.reviewedThrough}; per-source cadences enforced against ` +
              `the workflow doc's §2 table; ${warnings.length} warning(s))`);
  process.exit(0);
}

if (require.main === module) main();

module.exports = { validate, selfTest, loadCadences, CADENCE_RULES, STALE_WARN_MONTHS, STALE_FAIL_MONTHS };
