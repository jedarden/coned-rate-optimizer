/* Stage-1 backtest harness tests (tools/backtest-accounts.js).
   Usage: node test/backtest-harness.js

   Drives the real harness end-to-end over synthetic corpora built in a temp
   directory at run time — the harness itself has no fixture mode (it exists to
   audit REAL accounts), so the tests generate accounts whose bills the
   published-rate reconstruction reproduces exactly (bill totals derived from
   reconstructBill, rounded to the cent), then break them in controlled ways:
   a passing corpus at the strategy's ≥20-account bar, a corpus that fails the
   95% share, a below-bar corpus, an unconsented bundle, and a bundle that
   carries a field the anonymization contract refuses. */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const calc = require("../public/calc.js");

calc.applyRates(JSON.parse(fs.readFileSync(path.join(__dirname, "../public/rates.json"), "utf8")));

let testsPassed = 0;
let testsFailed = 0;
function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    testsPassed++;
  } else {
    console.log(`  ✗ ${message}`);
    testsFailed++;
  }
}

const HARNESS = path.join(__dirname, "..", "tools", "backtest-accounts.js");
const DAYS_PER_MONTH = 30.4375; // calc.js's mean Gregorian month — the customer-charge proration basis

// ---- synthetic corpus -------------------------------------------------------
// 12 bill periods across 2025 (the latest fully-published bill-rate year),
// inclusive start / exclusive end exactly as ESPI and reconcileBills treat them.
const BILL_STARTS = [
  [2025, 1, 1], [2025, 2, 1], [2025, 3, 1], [2025, 4, 1], [2025, 5, 1], [2025, 6, 1],
  [2025, 7, 1], [2025, 8, 1], [2025, 9, 1], [2025, 10, 1], [2025, 11, 1], [2025, 12, 1],
];
const BILL_ENDS = [
  [2025, 2, 1], [2025, 3, 1], [2025, 4, 1], [2025, 5, 1], [2025, 6, 1], [2025, 7, 1],
  [2025, 8, 1], [2025, 9, 1], [2025, 10, 1], [2025, 11, 1], [2025, 12, 1], [2025, 12, 31],
];
const serial = (y, mo, d) => Math.round(Date.UTC(y, mo - 1, d) / 86400000);
const ymd = (y, mo, d) => y * 10000 + mo * 100 + d;
function hourLabel(h) {
  if (h === 0) return "12:00 AM";
  if (h < 12) return `${h}:00 AM`;
  if (h === 12) return "12:00 PM";
  return `${h - 12}:00 PM`;
}

// A tiny stored ZIP writer keeps the test independent of the host `zip`
// command while exercising the same archive path as a ConEd download.
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function storedZip(name, text) {
  const nameBytes = Buffer.from(name);
  const data = Buffer.from(text);
  const crc = crc32(data);
  const local = Buffer.alloc(30 + nameBytes.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt16LE(0, 10);
  local.writeUInt16LE(0, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  nameBytes.copy(local, 30);
  const central = Buffer.alloc(46 + nameBytes.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(0, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(0, 42);
  nameBytes.copy(central, 46);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length + data.length, 16);
  return Buffer.concat([local, data, central, end]);
}

// Two interval rows per day (coverage counts days, pricing counts kWh) with a
// mild deterministic seasonal shape and a per-account offset for diversity.
function usageCsv(acctIdx) {
  const rows = ['"Date","Start Time","Usage (kWh)"'];
  const start = serial(2025, 1, 1), end = serial(2025, 12, 31);
  for (let s = start; s <= end; s++) {
    const [y, mo, d] = new Date(s * 86400000).toISOString().slice(0, 10).split("-").map(Number);
    const bias = 0.02 * (acctIdx % 5);
    [3, 16].forEach((h) => {
      const kwh = (0.30 + 0.08 * Math.sin((2 * Math.PI * s) / 365) + bias).toFixed(3);
      rows.push(`"${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}","${hourLabel(h)}",${kwh}`);
    });
  }
  return rows.join("\n") + "\n";
}

function writeAccount(root, id, acctIdx, breakBillIdx = -1, archiveUsage = false) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "consent.json"),
    JSON.stringify({ granted: true, grantedAt: "2026-09-01", method: "written permission" }, null, 2));
  const cohorts = [
    ["nyc", "standard", "winter-peaking", "smart"],
    ["westchester", "standard", "summer-peaking", "smart"],
    ["nyc", "tou", "dual-peak", "smart"],
    ["westchester", "other", "flat", "legacy"],
  ];
  const cohort = cohorts[acctIdx % cohorts.length];
  fs.writeFileSync(path.join(dir, "cohort.json"), JSON.stringify({
    territory: cohort[0], currentPlan: cohort[1], loadShape: cohort[2], meter: cohort[3]
  }, null, 2));
  const csv = usageCsv(acctIdx);
  fs.writeFileSync(path.join(dir, archiveUsage ? "usage.zip" : "usage.csv"), archiveUsage ? storedZip("usage.csv", csv) : csv);

  // kWh per bill window from the same rows the parser will read, then the bill
  // total from the reconstruction itself — so an honest corpus lands at the
  // cent-rounding residual, orders of magnitude inside the 2% band.
  const hours = {};
  csv.split("\n").slice(1).forEach((line) => {
    const m = /^"(\d+)-(\d+)-(\d+)"/.exec(line);
    const kwh = parseFloat(line.split(",")[2]);
    if (!m || isNaN(kwh)) return;
    const t = ymd(+m[1], +m[2], +m[3]);
    hours[t] = (hours[t] || 0) + kwh;
  });
  const bills = BILL_STARTS.map((S, i) => {
    const E = BILL_ENDS[i];
    let kwh = 0;
    for (let s = serial(...S); s < serial(...E); s++) {
      const [y, mo, d] = new Date(s * 86400000).toISOString().slice(0, 10).split("-").map(Number);
      kwh += hours[ymd(y, mo, d)] || 0;
    }
    const r = calc.reconstructBill({ kwh, year: E[0], months: (serial(...E) - serial(...S)) / DAYS_PER_MONTH });
    let total = Math.round(r.total * 100) / 100;
    if (i === breakBillIdx) total = Math.round(total * 1.1 * 100) / 100; // a 10% miss — deep in the fail band
    return { start: S.join("-"), end: E.join("-"), total };
  });
  fs.writeFileSync(path.join(dir, "bills.json"), JSON.stringify(bills, null, 2));
  return dir;
}

function writeCorpus(root, n, breakBillIn = () => -1, archiveUsageFor = () => false) {
  fs.mkdirSync(root, { recursive: true });
  for (let i = 0; i < n; i++) {
    const id = `acct-${String(i + 1).padStart(2, "0")}`;
    writeAccount(root, id, i, breakBillIn(i), archiveUsageFor(i));
  }
  return root;
}

function runHarness(corpus, out, extra = []) {
  const r = spawnSync(process.execPath, [HARNESS, "--corpus", corpus, "--out", out, ...extra], { encoding: "utf8" });
  let results = null;
  const resultsPath = path.join(out, "backtest-results.json");
  if (fs.existsSync(resultsPath)) results = JSON.parse(fs.readFileSync(resultsPath, "utf8"));
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "", results };
}

// ---- scenarios --------------------------------------------------------------
console.log("Running backtest-harness tests...\n");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "backtest-harness-"));
try {
  // Test 1: a full 20-account corpus of honest bills passes the gate.
  console.log("Test 1: 20 honest accounts → gate PASSES (exit 0)");
  {
    const corpus = writeCorpus(path.join(tmp, "pass"), 20, () => -1, (i) => i === 0);
    const r = runHarness(corpus, path.join(tmp, "out-pass"));
    assert(r.status === 0, `exit 0 (got ${r.status})`);
    assert(r.results && r.results.verdict === "pass", `verdict "pass" (got ${r.results && r.results.verdict})`);
    const a = r.results.aggregate;
    assert(a.usableAccounts === 20, `20 usable accounts (got ${a.usableAccounts})`);
    assert(a.supportedPeriods === 240, `240 supported periods (got ${a.supportedPeriods})`);
    assert(a.within2 === 240 && a.shareWithin2 === 100, `all 240 periods within 2% (got ${a.within2}, ${a.shareWithin2}%)`);
    assert(r.results.accounts.every((m) => m.gate === "pass" && m.misses.length === 0), "every account's own gate passes with no misses");
    const summary = fs.readFileSync(path.join(tmp, "out-pass", "backtest-summary.md"), "utf8");
    assert(summary.includes("**Verdict: PASS**"), "summary records the PASS verdict");
    assert(r.results.accounts.every((m) => summary.includes(m.id)), "summary lists every anonymized account id");
    assert(summary.includes("not a license to charge") === false && r.stdout.includes("not a license to charge"), "charging stays gated behind chargingCertified even on a PASS");
    assert(r.results.gitHead === null || /^[0-9a-f]{40}$/.test(r.results.gitHead), "provenance records the pipeline commit (or null outside git)");
  }

  // Test 2: a 10% miss in one bill across 13 accounts drops the share to
  // 227/240 = 94.58% — under the 95% gate. Every miss must be documented with
  // both totals and its worst component.
  console.log("Test 2: 13 accounts with one broken bill → gate FAILS (exit 1), every miss documented");
  {
    const corpus = writeCorpus(path.join(tmp, "fail"), 20, (i) => (i < 13 ? 3 : -1));
    const r = runHarness(corpus, path.join(tmp, "out-fail"));
    assert(r.status === 1, `exit 1 (got ${r.status})`);
    assert(r.results.verdict === "fail", `verdict "fail" (got ${r.results.verdict})`);
    const a = r.results.aggregate;
    assert(a.within2 === 227 && a.supportedPeriods === 240, `227 of 240 within 2% (got ${a.within2}/${a.supportedPeriods})`);
    assert(a.shareWithin2 < 95, `share ${a.shareWithin2}% is under the 95% gate`);
    const misses = r.results.accounts.reduce((s, m) => s + m.misses.length, 0);
    assert(misses === 13, `13 misses documented (got ${misses})`);
    assert(r.results.accounts.every((m) => m.misses.every((f) =>
      f.pctError > 5 && f.band === "fail" && f.actualTotal > 0 && f.modeledTotal > 0
      && Array.isArray(f.modeledComponents) && f.modeledComponents.length && f.worstModeledComponent)),
      "every miss names its band, both totals, and the modeled component breakdown to investigate");
    const summary = fs.readFileSync(path.join(tmp, "out-fail", "backtest-summary.md"), "utf8");
    assert(summary.includes("Every miss (13 across 13 account(s))"), "summary carries the miss-investigation section");
  }

  // Test 3: below the strategy's 20-account bar the audit is incomplete —
  // reported, never certified.
  console.log("Test 3: 20-account corpus, --min-accounts 21 → INCOMPLETE (exit 2), not certified");
  {
    const r = runHarness(path.join(tmp, "pass"), path.join(tmp, "out-short"), ["--min-accounts", "21"]);
    assert(r.status === 2, `exit 2 (got ${r.status})`);
    assert(r.results.verdict === "incomplete", `verdict "incomplete" (got ${r.results.verdict})`);
    assert(/INCOMPLETE/.test(r.stdout) && /cannot certify/.test(r.stdout), "stdout says the audit cannot certify below the bar");
  }

  // The option may make the bar stricter but must never weaken the strategy's
  // mandatory minimum. A smaller requested value still requires 20 accounts.
  console.log("Test 4: --min-accounts 1 cannot lower the 20-account certification floor");
  {
    const corpus = writeCorpus(path.join(tmp, "floor"), 19);
    const r = runHarness(corpus, path.join(tmp, "out-floor"), ["--min-accounts", "1"]);
    assert(r.status === 2 && r.results.verdict === "incomplete", `19 accounts remain incomplete (exit ${r.status}, verdict ${r.results && r.results.verdict})`);
    assert(r.results.minAccounts === 20 && r.results.strategyMinimumAccounts === 20, "report preserves the mandatory 20-account floor");
  }

  // Test 5: an unconsented bundle refuses the whole run — the audit never
  // proceeds past missing consent.
  console.log("Test 5: missing consent.json → REFUSED (exit 1)");
  {
    const corpus = writeCorpus(path.join(tmp, "consent"), 20);
    fs.rmSync(path.join(corpus, "acct-07", "consent.json"));
    const r = runHarness(corpus, path.join(tmp, "out-consent"));
    assert(r.status === 1, `exit 1 (got ${r.status})`);
    assert(!r.results, "no results artifact is written after a consent refusal");
    assert(/acct-07:.*consent/.test(r.stdout), `acct-07 refused for consent: ${r.stdout.trim()}`);
    assert(!fs.existsSync(path.join(tmp, "out-consent", "backtest-summary.md")), "no summary is written after the refusal");
  }

  // Test 6: the anonymization contract is enforced on the corpus itself — a
  // bills.json entry carrying a field outside the schema refuses the run.
  console.log("Test 6: a bill record with an out-of-contract field → REFUSED (exit 1)");
  {
    const corpus = writeCorpus(path.join(tmp, "schema"), 20);
    const bills = JSON.parse(fs.readFileSync(path.join(corpus, "acct-03", "bills.json"), "utf8"));
    bills[0].phone = "2125550100";
    fs.writeFileSync(path.join(corpus, "acct-03", "bills.json"), JSON.stringify(bills));
    const r = runHarness(corpus, path.join(tmp, "out-schema"));
    assert(r.status === 1 && !r.results, "exit 1, no results artifact after refusal");
    assert(/outside the audit schema/.test(r.stdout), `refusal names the schema violation: ${r.stdout.trim()}`);
  }

  // Test 7: a missing corpus directory is a usage error, not a silent pass.
  console.log("Test 7: nonexistent corpus → usage error (exit 1)");
  {
    const r = runHarness(path.join(tmp, "does-not-exist"), path.join(tmp, "out-none"));
    assert(r.status === 1 && /not found/.test(r.stderr), `exit 1 with a clear error (got ${r.status}: ${r.stderr.trim()})`);
  }

  // Test 8: cohort buckets are categorical and cannot carry participant text.
  console.log("Test 8: free-form cohort data → REFUSED (exit 1)");
  {
    const corpus = writeCorpus(path.join(tmp, "cohort"), 20);
    const cohort = JSON.parse(fs.readFileSync(path.join(corpus, "acct-04", "cohort.json"), "utf8"));
    cohort.loadShape = "participant works nights at 123 Main Street";
    fs.writeFileSync(path.join(corpus, "acct-04", "cohort.json"), JSON.stringify(cohort));
    const r = runHarness(corpus, path.join(tmp, "out-cohort"));
    assert(r.status === 1 && !r.results, "exit 1, no results artifact after cohort refusal");
    assert(/lowercase categorical bucket/.test(r.stdout), "refusal prevents free-form participant data");
  }

  // A root-level stray file is refused instead of being silently ignored; this
  // keeps a copied bill scan or participant note out of the audit boundary.
  console.log("Test 9: stray corpus-root file → REFUSED (exit 1)");
  {
    const corpus = writeCorpus(path.join(tmp, "root-entry"), 20);
    fs.writeFileSync(path.join(corpus, "participant-note.txt"), "not part of the anonymized corpus");
    const r = runHarness(corpus, path.join(tmp, "out-root-entry"));
    assert(r.status === 1 && !r.results, "exit 1, no results artifact after root-entry refusal");
    assert(/corpus root contains a non-account entry/.test(r.stdout), "refusal names the unexpected root entry");
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${testsPassed} passed, ${testsFailed} failed`);
if (testsFailed > 0) process.exitCode = 1;
