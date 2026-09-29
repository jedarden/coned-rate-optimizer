/* Stage-1 calculation-audit harness — docs/product-strategy.md, "Accuracy gate"
   and "Stage 1: calculation audit".

   Runs the production bill-reconstruction pipeline (parse → reconcileBills →
   accuracyGate — the same functions the browser uses) over a corpus of
   anonymized, consented REAL accounts, reports the share of complete,
   supported billing periods that reconcile within the accuracy gate, and
   writes the reproducible anonymized results summary.

   THE AUDIT RUNS ON REAL DATA ONLY. This tool has no fixture mode and cannot
   manufacture a passing verdict: a corpus below the strategy's mandatory
   20-account floor exits 2 "incomplete" — reported, never certified.
   --min-accounts may raise that floor for a stricter run, but cannot lower it.

   Corpus layout (--corpus DIR; one directory per account; the directory name
   is the account's opaque anonymized id, e.g. acct-01 — never a name):

     acct-01/
       consent.json    { "granted": true, "grantedAt": "2026-09-28",
                         "method": "written permission" }
       cohort.json     { "territory": "nyc", "currentPlan": "standard",
                         "loadShape": "winter-peaking", "meter": "smart" }
       usage.csv       the participant's actual Green Button export, exactly as
       usage.xml       ConEd delivers it (.csv/.tsv, .xml/ESPI, or the raw .zip;
       usage.zip       any one of these)
       bills.json      [ { "start": "2025-01-14", "end": "2025-02-12",
                           "total": 96.42 }, ... ]
                       actual bill totals transcribed from the participant's
                       bills (dates inclusive-start, exclusive-end, as ESPI
                       publishes them)

   The accounts themselves live OUTSIDE the repo (participant data is never
   committed — the data-boundary contract in docs/notes/gbc-data-boundary.md
   extends to the audit); the conventional location is ./audit-corpus/, which
   is gitignored. Results default to ./audit-results/, also gitignored.

   Exit codes: 0 = gate PASSED (≥ min-accounts usable accounts AND ≥ 95% of
   their complete, supported periods within the 2% band); 1 = gate FAILED or
   the corpus is unusable (refused consent, unreadable export, schema
   violation); 2 = audit INCOMPLETE (fewer usable accounts than the bar —
   cannot certify either way). */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const calc = require("../public/calc.js");

const STRATEGY_MIN_ACCOUNTS = 20;
const ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const FIXED_ACCOUNT_FILES = new Set(["consent.json", "cohort.json", "bills.json"]);

// Same rate data the live site uses (app.js fetches rates.json at runtime).
const ratesJson = JSON.parse(fs.readFileSync(path.join(__dirname, "../public/rates.json"), "utf8"));
calc.applyRates(ratesJson);

// ---- CLI --------------------------------------------------------------------
const args = process.argv.slice(2);
function argOf(name) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}
const corpusDir = argOf("--corpus");
const outDir = argOf("--out") || "audit-results";
const requestedMinAccounts = argOf("--min-accounts");
let minAccounts = STRATEGY_MIN_ACCOUNTS;
if (args.includes("--min-accounts") && requestedMinAccounts === null) {
  console.error("error: --min-accounts needs a positive integer value");
  process.exit(1);
}
if (requestedMinAccounts !== null) {
  const requestedNumber = Number(requestedMinAccounts);
  if (!/^\d+$/.test(requestedMinAccounts) || !Number.isSafeInteger(requestedNumber) || requestedNumber < 1) {
    console.error("error: --min-accounts must be a positive integer");
    process.exit(1);
  }
  // This option can make the bar stricter for an experiment, never weaker than
  // the product-strategy certification bar.
  minAccounts = Math.max(STRATEGY_MIN_ACCOUNTS, requestedNumber);
}
if (!corpusDir) {
  console.error("usage: node tools/backtest-accounts.js --corpus <dir> [--out <dir>] [--min-accounts N]");
  process.exit(1);
}
if (!fs.existsSync(corpusDir) || !fs.statSync(corpusDir).isDirectory()) {
  console.error(`error: corpus directory not found: ${corpusDir}`);
  process.exit(1);
}

// ---- privacy contracts, enforced mechanically -------------------------------
// The corpus is real people's utility data behind anonymized ids; these
// allowlists are the audit-side equivalent of test/analytics-privacy.js: an
// account bundle that carries an identifier the contract does not name is
// refused, not silently carried into the results.
const CONSENT_KEYS = ["granted", "grantedAt", "method"];
const BILL_KEYS = ["start", "end", "total", "label", "currency"];
const COHORT_KEYS = ["territory", "currentPlan", "loadShape", "meter"];
function refuseUnknownKeys(obj, allow, what, acct) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error(`${acct}: ${what} must be a JSON object`);
  }
  const unknown = Object.keys(obj).filter((k) => !allow.includes(k));
  if (unknown.length) throw new Error(`${acct}: ${what} carries field(s) outside the audit schema (${unknown.join(", ")}) — participant data must stay anonymized to the contract in this file's header.`);
}

function requireSafeText(value, what, acct, maxLength) {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${acct}: ${what} must be a short, non-empty text value without control characters`);
  }
}

// ---- provenance (reproducibility) --------------------------------------------
let gitHead = null;
try { gitHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: path.join(__dirname, ".."), encoding: "utf8" }).trim(); } catch (e) { /* archive/checkout without git — provenance falls back to rates meta */ }

const accuracy = calc.accuracyThresholds();
const billYears = calc.RATES.bill.periods.map((p) => p.year);

// ---- one account --------------------------------------------------------------
function runAccount(dir, acct) {
  if (!ACCOUNT_ID_PATTERN.test(acct)) {
    throw new Error(`${acct}: account directory name must be an opaque lowercase id (letters, numbers, _ or - only)`);
  }
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  const unexpected = entries
    .filter((entry) => !entry.isFile() || (!FIXED_ACCOUNT_FILES.has(entry.name) && !/\.(csv|tsv|xml|zip)$/i.test(entry.name)))
    .map((entry) => entry.name);
  if (unexpected.length) {
    throw new Error(`${acct}: unexpected corpus entry(s): ${unexpected.join(", ")} — only consent.json, cohort.json, bills.json, and one usage export are allowed`);
  }
  const meta = { id: acct, status: "ok", consent: null, billsComplete: 0, supported: 0, unsupported: [], incomplete: [], periods: 0, within2: 0, pctWithin2: 0, meanPctError: 0, maxPctError: 0, gate: null, misses: [], error: null };

  // consent first: an unconsented bundle never reaches the pipeline.
  if (!files.includes("consent.json")) throw new Error(`${acct}: no consent.json — the audit runs on consented accounts only`);
  const consent = JSON.parse(fs.readFileSync(path.join(dir, "consent.json"), "utf8"));
  refuseUnknownKeys(consent, CONSENT_KEYS, "consent.json", acct);
  if (consent.granted !== true) throw new Error(`${acct}: consent.json does not record granted:true — refused`);
  if (!consent.grantedAt || !consent.method) throw new Error(`${acct}: consent.json lacks grantedAt or method — consent must be dated and attributable to how it was obtained`);
  requireSafeText(consent.grantedAt, "consent.json.grantedAt", acct, 64);
  requireSafeText(consent.method, "consent.json.method", acct, 64);
  meta.consent = { grantedAt: String(consent.grantedAt), method: consent.method };

  // Diversity is an attested, categorical profile rather than an account
  // identifier. It is deliberately small and allowlisted so the durable
  // result can prove the corpus was not twenty copies of one household
  // without carrying participant data into the report.
  if (!files.includes("cohort.json")) throw new Error(`${acct}: no cohort.json — every account needs an anonymized diversity profile`);
  const cohort = JSON.parse(fs.readFileSync(path.join(dir, "cohort.json"), "utf8"));
  refuseUnknownKeys(cohort, COHORT_KEYS, "cohort.json", acct);
  COHORT_KEYS.forEach((key) => {
    if (typeof cohort[key] !== "string" || !cohort[key].trim()) {
      throw new Error(`${acct}: cohort.json.${key} must be a non-empty categorical value`);
    }
    if (typeof cohort[key] === "string" && !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(cohort[key])) {
      throw new Error(`${acct}: cohort.json.${key} must be a lowercase categorical bucket, not free-form participant data`);
    }
  });
  meta.cohort = Object.assign({}, cohort);

  const usage = files.filter((f) => /\.(csv|tsv|xml|zip)$/i.test(f));
  if (usage.length !== 1) throw new Error(`${acct}: expected exactly one usage export (.csv/.tsv/.xml/.zip), found ${usage.length}`);
  const buf = fs.readFileSync(path.join(dir, usage[0]));
  const u8 = new Uint8Array(buf);
  const usagePromise = (u8[0] === 0x50 && u8[1] === 0x4b && u8[2] === 0x03 && u8[3] === 0x04)
    ? calc.unzipCsv(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
    : Promise.resolve(new TextDecoder().decode(buf));

  if (!files.includes("bills.json")) throw new Error(`${acct}: no bills.json — the gate reconciles against actual bills`);
  const rawBills = JSON.parse(fs.readFileSync(path.join(dir, "bills.json"), "utf8"));
  if (!Array.isArray(rawBills)) throw new Error(`${acct}: bills.json must be an array of { start, end, total } bill records`);
  if (rawBills.length === 0) throw new Error(`${acct}: bills.json must contain at least one transcribed actual bill`);
  rawBills.forEach((b, i) => {
    refuseUnknownKeys(b, BILL_KEYS, `bills.json[${i}]`, acct);
    if (typeof b.total !== "number" || !Number.isFinite(b.total)) throw new Error(`${acct}: bills.json[${i}] lacks a finite numeric total — the transcribed actual bill amount in dollars`);
    if (b.currency !== undefined && b.currency !== "USD") throw new Error(`${acct}: bills.json[${i}] uses unsupported currency ${String(b.currency)} — actual Con Edison bills must be in USD`);
  });
  // The corpus schema says `total` (what a transcribed bill shows); the
  // pipeline's normalized bill record says `cost`. Do not carry a caller's
  // free-form label into the report: calc.js derives an anonymized period label
  // from the dates, so a handwritten label cannot leak participant data.
  const bills = rawBills.map((b) => ({ start: b.start, end: b.end, cost: b.total }));

  return usagePromise.then((text) => {
    const parsed = calc.parse(text);
    const norm = calc.normalizeBills(bills);
    meta.billsComplete = norm.bills.length;
    meta.incomplete = norm.incomplete.map((b) => `${b.label}: ${b.reason}`);
    const recon = calc.reconcileBills(parsed, norm.bills);
    meta.unsupported = recon.unsupported.map((u) => `${u.label}: ${u.reason}`);
    meta.supported = recon.rows.length;
    if (recon.gate) {
      meta.periods = recon.gate.periods;
      meta.within2 = recon.gate.within2;
      meta.pctWithin2 = recon.gate.pctWithin2;
      meta.meanPctError = recon.gate.meanPctError;
      meta.maxPctError = recon.gate.maxPctError;
      meta.gate = recon.gate.gate;
      // Every miss is documented, never averaged away: both sides of the
      // comparison, the modeled component breakdown (the investigation's
      // starting point — a transcribed total carries no component split of
      // its own), and the worst modeled component.
      meta.misses = recon.rows.filter((r) => !r.withinGate).map((r) => {
        const comps = Object.keys(r.modeled.components).map((k) => ({ component: k, amount: +r.modeled.components[k].toFixed(2) }));
        const worst = comps.reduce((a, b) => (Math.abs(b.amount) > Math.abs(a.amount) ? b : a), comps[0]);
        return {
          label: r.label,
          actualTotal: +r.actualTotal.toFixed(2), modeledTotal: +r.modeledTotal.toFixed(2),
          delta: +r.delta.toFixed(4), pctError: +r.pctError.toFixed(4),
          band: r.pctError <= accuracy.warnPct ? "warn" : "fail",
          observedDays: r.observedDays, billDays: r.billDays,
          modeledComponents: comps, worstModeledComponent: worst ? `${worst.component} ($${worst.amount.toFixed(2)})` : null,
        };
      });
    }
    return meta;
  });
}

// ---- the corpus ---------------------------------------------------------------
const corpusEntries = fs.readdirSync(corpusDir, { withFileTypes: true });
const acctDirs = corpusEntries
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

const results = [];
const refusals = corpusEntries
  .filter((d) => !d.isDirectory())
  .map((d) => ({ id: d.name, error: "corpus root contains a non-account entry; put only account directories under --corpus" }));
acctDirs.filter((acct) => !ACCOUNT_ID_PATTERN.test(acct)).forEach((acct) => {
  refusals.push({ id: acct, error: "account directory name must be an opaque lowercase id (letters, numbers, _ or - only)" });
});
let pending = Promise.resolve();
acctDirs.filter((acct) => ACCOUNT_ID_PATTERN.test(acct)).forEach((acct) => {
  pending = pending.then(() =>
    Promise.resolve() // defer: a synchronous throw (no consent, bad schema) must land in refusals, not abort the run
      .then(() => runAccount(path.join(corpusDir, acct), acct))
      .then((meta) => results.push(meta))
      .catch((e) => refusals.push({ id: acct, error: e.message })));
});

pending.then(() => {
  // A refused corpus produces no artifacts at all: an audit run that carried
  // even one unconsented or out-of-contract bundle must never leave behind a
  // results file that could be mistaken for an audit. Name every offending
  // bundle in one pass; fix the corpus and rerun.
  if (refusals.length) {
    console.log(`Stage-1 backtest REFUSED — ${refusals.length} bundle(s) failed the consent/anonymization contract. Nothing was audited and nothing was written:`);
    refusals.forEach((x) => console.log(`  ${x.id}: ${x.error}`));
    process.exit(1);
  }
  const usable = results.filter((r) => r.status === "ok" && r.gate);
  const periods = usable.reduce((s, r) => s + r.periods, 0);
  const within2 = usable.reduce((s, r) => s + r.within2, 0);
  const within5 = within2 + usable.reduce((s, r) => s + r.misses.filter((m) => m.band === "warn").length, 0);
  const share = periods ? (within2 / periods) * 100 : 0;
  const diversity = {};
  COHORT_KEYS.forEach((key) => {
    diversity[key] = {};
    usable.forEach((r) => { diversity[key][r.cohort[key]] = (diversity[key][r.cohort[key]] || 0) + 1; });
  });
  const diverseDimensions = COHORT_KEYS.filter((key) => Object.keys(diversity[key]).length >= 2);
  const diverse = diverseDimensions.length >= 2;
  const verdict = usable.length < minAccounts ? "incomplete"
    : !diverse ? "fail"
    : share >= accuracy.gateFraction * 100 ? "pass" : "fail";

  const report = {
    tool: "tools/backtest-accounts.js",
    generatedAt: new Date().toISOString(),
    gitHead,
    rates: { asOf: calc.RATES.meta.asOf, reviewedThrough: calc.RATES.meta.reviewedThrough, billYears, accuracy },
    // Never put a user-selected filesystem path in the durable report. The
    // path can itself contain a participant name; the command line is the
    // reproducibility instruction and gitHead/rates are the provenance.
    corpus: "<external corpus>",
    minAccounts,
    strategyMinimumAccounts: STRATEGY_MIN_ACCOUNTS,
    accounts: results,
    diversity: { dimensions: diversity, diverseDimensions, diverse },
    refusals,
    aggregate: {
      usableAccounts: usable.length,
      supportedPeriods: periods, within2, within5,
      shareWithin2: +share.toFixed(4), gateFractionPct: accuracy.gateFraction * 100,
      meanPctError: periods ? +(usable.reduce((s, r) => s + r.meanPctError * r.periods, 0) / periods).toFixed(4) : 0,
      maxPctError: usable.reduce((m, r) => Math.max(m, r.maxPctError), 0),
    },
    verdict,
  };

  fs.mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, "backtest-results.json");
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n");
  fs.writeFileSync(path.join(outDir, "backtest-summary.md"), renderSummary(report));

  printReport(report, jsonPath);
  process.exit(verdict === "pass" ? 0 : verdict === "incomplete" ? 2 : 1);
}).catch((e) => {
  console.error(`error: ${e.message}`);
  process.exit(1);
});

// ---- output -------------------------------------------------------------------
function printReport(r, jsonPath) {
  const a = r.aggregate;
  console.log(`Stage-1 backtest — ${a.usableAccounts} usable account(s), ${a.supportedPeriods} complete, supported period(s)`);
  r.accounts.forEach((m) => {
    console.log(`  ${m.id}: ${m.within2}/${m.periods} within ${accuracy.passPct}%  (max ${m.maxPctError.toFixed(2)}%)  gate ${m.gate}${m.misses.length ? `  — ${m.misses.length} miss(es)` : ""}`);
  });
  console.log(`\naggregate: ${a.within2}/${a.supportedPeriods} = ${a.shareWithin2.toFixed(2)}% within ${accuracy.passPct}% (gate: ≥ ${a.gateFractionPct}% across ≥ ${r.minAccounts} accounts)`);
  if (r.verdict === "incomplete") console.log(`\nVERDICT: INCOMPLETE — ${a.usableAccounts} of ${r.minAccounts} accounts backtested; the audit cannot certify below the strategy's bar. Reported, not certified.`);
  if (r.verdict === "fail" && !r.diversity.diverse) console.log(`\nVERDICT: FAIL — the corpus is not diverse across at least two required categorical dimensions; reported, not certified.`);
  if (r.verdict === "fail") console.log(`\nVERDICT: FAIL — the model missed the gate. Every miss is documented in ${jsonPath}; investigate each one before touching any threshold.`);
  if (r.verdict === "pass") console.log(`\nVERDICT: PASS — the accuracy gate holds on this corpus. This certifies the model, not a license to charge: charging also requires RATES.pricing.chargingCertified (an explicit operator decision).`);
}

function renderSummary(r) {
  const a = r.aggregate;
  const lines = [];
  lines.push(`# Stage-1 bill-reconstruction backtest — anonymized results summary`);
  lines.push("");
  lines.push(`Generated ${r.generatedAt} by \`${r.tool}\` from an external corpus.`);
  lines.push(`Rates: ${r.rates.asOf} (reviewed through ${r.rates.reviewedThrough}; bill-rate years ${r.rates.billYears.join(", ")}).`);
  lines.push(`Diversity: ${r.diversity.diverse ? "PASS" : "FAIL"} across ${r.diversity.diverseDimensions.join(", ") || "no dimensions"}; cohort counts are recorded in backtest-results.json.`);
  if (r.gitHead) lines.push(`Pipeline at commit \`${r.gitHead}\`; accuracy thresholds: pass ${r.rates.accuracy.passPct}%, warn ${r.rates.accuracy.warnPct}%, gate fraction ${r.rates.accuracy.gateFraction * 100}%.`);
  lines.push("");
  lines.push(`**Verdict: ${r.verdict.toUpperCase()}** — ${a.within2} of ${a.supportedPeriods} complete, supported billing periods (${a.shareWithin2.toFixed(2)}%) reconcile within ${r.rates.accuracy.passPct}% across ${a.usableAccounts} usable account(s); the strategy's bar is ≥ ${a.gateFractionPct}% across ≥ ${r.minAccounts} accounts. Mean period error ${a.meanPctError.toFixed(2)}%, worst ${a.maxPctError.toFixed(2)}%.`);
  lines.push("");
  lines.push(`| Account | Supported periods | Within ${r.rates.accuracy.passPct}% | Share | Max error | Gate |`);
  lines.push(`|---|---:|---:|---:|---:|---|`);
  r.accounts.forEach((m) => lines.push(`| ${m.id} | ${m.periods} | ${m.within2} | ${m.pctWithin2.toFixed(2)}% | ${m.maxPctError.toFixed(2)}% | ${m.gate} |`));
  lines.push(`| **aggregate** | **${a.supportedPeriods}** | **${a.within2}** | **${a.shareWithin2.toFixed(2)}%** | **${a.maxPctError.toFixed(2)}%** | **${r.verdict}** |`);
  const missed = r.accounts.filter((m) => m.misses.length);
  if (missed.length) {
    lines.push("");
    lines.push(`## Every miss (${missed.reduce((s, m) => s + m.misses.length, 0)} across ${missed.length} account(s)) — investigate each, never average them away`);
    lines.push("");
    missed.forEach((m) => {
      m.misses.forEach((f) => {
        lines.push(`- **${m.id}** · ${f.label} — modeled $${f.modeledTotal.toFixed(2)} vs actual $${f.actualTotal.toFixed(2)} (Δ $${f.delta >= 0 ? "+" : ""}${f.delta.toFixed(2)}, ${f.pctError.toFixed(2)}%, ${f.band} band; interval coverage ${f.observedDays}/${f.billDays} days); largest modeled component: ${f.worstModeledComponent}. The full component breakdown is in backtest-results.json.`);
      });
    });
  }
  if (r.refusals.length) {
    lines.push("");
    lines.push(`## Refused bundles (${r.refusals.length}) — never audited`);
    r.refusals.forEach((x) => lines.push(`- ${x.id}: ${x.error}`));
  }
  const excluded = r.accounts.filter((m) => m.unsupported.length || m.incomplete.length);
  if (excluded.length) {
    lines.push("");
    lines.push(`## Excluded from the gate (unsupported or unusable bill records)`);
    excluded.forEach((m) => {
      m.unsupported.forEach((u) => lines.push(`- ${m.id} · ${u}`));
      m.incomplete.forEach((u) => lines.push(`- ${m.id} · ${u}`));
    });
  }
  lines.push("");
  lines.push(`Reproduce: \`node tools/backtest-accounts.js --corpus <corpus-dir> --out <out-dir>\`. The corpus lives outside the repo (participant data is never committed); this summary carries anonymized ids only.`);
  return lines.join("\n") + "\n";
}
