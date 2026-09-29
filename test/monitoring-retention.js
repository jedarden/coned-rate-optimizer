/* Focused contract tests for the browser-only monitoring store.
   Usage: node test/monitoring-retention.js */
const fs = require("fs");
const path = require("path");
const calc = require("../public/calc.js");
const monitor = require("../public/monitor.js");

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.log(`  ✗ ${message}`);
    failed++;
  }
}

function month(ym, total, peak, ndays) {
  return {
    ym,
    month: Number(ym.slice(5)),
    total,
    peak,
    off: total - peak,
    summer: [6, 7, 8, 9].includes(Number(ym.slice(5))),
    ndays: ndays || 30
  };
}

function bill(start, end, cost, label) {
  return { start, end, days: 30, ymdStart: start, ymdEnd: end, cost, currency: "USD", label };
}

function memoryStore() {
  const values = new Map();
  return {
    setItem: (key, value) => values.set(key, String(value)),
    getItem: (key) => values.has(key) ? values.get(key) : null,
    removeItem: (key) => values.delete(key)
  };
}

function run(name, fn) {
  console.log(name);
  try {
    fn();
  } catch (error) {
    console.log(`  ✗ ${error.stack || error.message}`);
    failed++;
  }
  console.log("");
}

console.log("Monitoring retention and deletion tests\n");

run("Imports, merging, and revisions", () => {
  let series = monitor.blank();
  series = monitor.ingest(series, {
    source: "file", label: "old.csv", importedAt: 1000, plan: "standard",
    months: [month("2025-06", 400, 280), month("2025-07", 420, 300)]
  });
  series = monitor.ingest(series, {
    source: "gbc", label: "new.csv", importedAt: 2000, plan: "standard",
    months: [month("2025-07", 430, 305), month("2025-08", 380, 250)]
  });
  assert(series.imports === 2 && series.lastImportedAt === 2000,
    "imports and the latest import timestamp belong to the merged series");
  assert(series.months.map((m) => m.ym).join(",") === "2025-06,2025-07,2025-08",
    "an import merges months without erasing uncovered history");
  assert(series.months[1].total === 430 && series.months[1].revisions === 1,
    "an overlapping month takes the newest data and counts a revision");

  series = monitor.ingest(series, {
    source: "gbc", label: "pull", importedAt: 3000, plan: "standard", months: [],
    bills: [bill(20250601, 20250701, 151.6, "Jun 2025"), bill(20250701, 20250731, 207.9, "Jul 2025")]
  });
  series = monitor.ingest(series, {
    source: "gbc", label: "pull-again", importedAt: 4000, plan: "standard", months: [],
    bills: [bill(20250701, 20250731, 199.5, "Jul 2025")]
  });
  assert(series.bills.length === 2 && series.bills.find((b) => b.label === "Jul 2025").cost === 199.5,
    "bill imports merge on their period label and keep the newest summary");
  assert(series.bills.find((b) => b.label === "Jul 2025").revisions === 1,
    "a revised bill summary counts its revision");
});

run("36-month trimming and bill retention", () => {
  const months = [];
  for (let i = 0; i < 40; i++) {
    const year = 2023 + Math.floor(i / 12);
    const mo = String((i % 12) + 1).padStart(2, "0");
    months.push(month(`${year}-${mo}`, 300 + i, 200));
  }
  let series = monitor.ingest(monitor.blank(), {
    source: "file", label: "40-month.csv", importedAt: 5000, months,
    bills: [
      bill(20230101, 20230131, 100, "expired bill"),
      bill(20230501, 20230531, 105, "window-edge bill"),
      bill(20260101, 20260131, 110, "retained bill")
    ]
  });
  assert(series.months.length === 36 && monitor.RETENTION_MONTHS === 36,
    "retention keeps exactly the newest 36 monthly buckets");
  assert(series.months[0].ym === "2023-05" && series.trimmed === 4,
    "the oldest four buckets age out and are counted");
  assert(series.bills.some((b) => b.label === "window-edge bill") &&
         series.bills.some((b) => b.label === "retained bill") &&
         !series.bills.some((b) => b.label === "expired bill"),
    "bills ending inside the retained window stay while older bills fall out");

  series = monitor.ingest(series, {
    source: "file", label: "new-month.csv", importedAt: 6000,
    months: [month("2026-05", 340, 220)]
  });
  assert(series.months[0].ym === "2023-06" && series.months[series.months.length - 1].ym === "2026-05" &&
         series.trimmed === 5,
    "a later import advances the rolling window by one month");
  assert(!series.bills.some((b) => b.label === "window-edge bill") &&
         series.bills.some((b) => b.label === "retained bill"),
    "bill retention follows the rolling oldest-month boundary");
});

run("Plan timelines and monthly restoration", () => {
  let series = monitor.blank();
  series = monitor.ingest(series, {
    source: "file", label: "standard-jan", importedAt: 1, plan: "standard",
    months: [month("2025-01", 300, 200)]
  });
  series = monitor.ingest(series, {
    source: "file", label: "standard-feb", importedAt: 2, plan: "standard",
    months: [month("2025-02", 300, 200)]
  });
  series = monitor.ingest(series, {
    source: "gbc", label: "tou-spring", importedAt: 3, plan: "tou",
    months: [month("2025-03", 300, 200), month("2025-04", 300, 200)]
  });
  assert(series.timeline.length === 1 && series.timeline[0].from === "2025-03" &&
         series.timeline[0].plan === "tou",
    "a changed declared plan is dated to the earliest covered month");
  assert(monitor.planFor(series, "2025-02") === "standard" &&
         monitor.planFor(series, "2025-03") === "tou" &&
         monitor.planFor(series, "2025-12") === "tou",
    "planFor resolves the plan in effect at each retained month");
  assert(JSON.stringify(monitor.segments(series).map((segment) => segment.plan)) ===
         '["standard","tou"]' && monitor.segments(series)[0].yms.length === 2,
    "timeline entries form contiguous same-plan segments");
  const restored = monitor.restoreParsed(series);
  assert(restored.hours.length === 0 && restored.ndays === 120,
    "restoration keeps monthly summaries and observed days, never hourly readings");
});

run("Recheck fingerprints and local deletion", () => {
  const analysis = {
    profile: { currentPlan: "standard" },
    plans: [
      { key: "standard", current: true, cost: 100, short: "Standard" },
      { key: "tou", cost: 120, short: "Time-of-Use" }
    ],
    recommendation: "Stay on Standard"
  };
  let series = monitor.ingest(monitor.blank(), {
    source: "file", importedAt: 7000, profile: analysis.profile,
    months: [month("2026-01", 300, 200)]
  });
  const first = monitor.recheck(series, analysis, { trigger: "usage", now: 1 });
  assert(first.initialized === true && typeof first.state.usageFingerprint === "string" &&
         typeof first.state.profileFingerprint === "string" && typeof first.state.rateFingerprint === "string",
    "the first recheck stores derived usage, profile, and rate fingerprints");
  const equivalentRates = JSON.parse(JSON.stringify(calc.RATES));
  assert(monitor.rateFingerprint(equivalentRates) === first.state.rateFingerprint,
    "equivalent tariff objects produce the same deterministic fingerprint");
  equivalentRates.meta.version = `${equivalentRates.meta.version}-changed`;
  assert(monitor.rateFingerprint(equivalentRates) !== first.state.rateFingerprint,
    "a tariff input change produces a different fingerprint");

  series = monitor.ingest(series, {
    source: "file", importedAt: 8000, profile: analysis.profile,
    months: [month("2026-01", 301, 200)]
  });
  series.recheck = first.state;
  const changed = monitor.recheck(series, analysis, { trigger: "usage", now: 2 });
  assert(changed.usageChanged === true && changed.state.usageFingerprint !== first.state.usageFingerprint,
    "a revised month changes the usage fingerprint without retaining raw inputs");

  const store = memoryStore();
  monitor.save(series, store);
  assert(monitor.load(store).months.length === 1, "the retained series round-trips through localStorage");
  monitor.clear(store);
  assert(store.getItem(monitor.KEY) === null && monitor.load(store) === null,
    "deletion removes the complete monitoring record immediately");
});

run("Schema handling and re-analysis after deletion", () => {
  const store = memoryStore();
  store.setItem(monitor.KEY, "{not json");
  const corrupt = monitor.load(store);
  assert(corrupt.schema === monitor.SCHEMA && corrupt.months.length === 0 && corrupt.bills.length === 0,
    "corrupt stored JSON is replaced with a fresh current-schema series");

  store.setItem(monitor.KEY, JSON.stringify({ schema: monitor.SCHEMA + 1, months: [] }));
  const foreign = monitor.load(store);
  assert(foreign.schema === monitor.SCHEMA && foreign.months.length === 0,
    "a record from a newer schema version is rejected without being rendered");

  store.setItem(monitor.KEY, JSON.stringify({ schema: monitor.SCHEMA, months: "not an array" }));
  const malformed = monitor.load(store);
  assert(malformed.schema === monitor.SCHEMA && malformed.months.length === 0,
    "a record with a malformed month list starts fresh");

  store.setItem(monitor.KEY, JSON.stringify({
    schema: monitor.SCHEMA,
    months: [month("2026-02", 250, 150)],
    profile: { territory: "nyc", currentPlan: "standard", meter: "smart", token: "ignore me" }
  }));
  const compatible = monitor.load(store);
  assert(compatible.months.length === 1 && compatible.months[0].ym === "2026-02" &&
         !JSON.stringify(compatible).includes("ignore me"),
    "the current schema remains loadable while unknown profile fields are stripped");

  let stored = monitor.ingest(monitor.blank(), {
    source: "file", importedAt: 10000, plan: "standard",
    profile: { territory: "nyc", currentPlan: "standard", meter: "smart" },
    months: [month("2025-12", 500, 350)],
    bills: [bill(20251201, 20251231, 175, "old retained bill")]
  });
  const oldAnalysis = calc.analyze(monitor.restoreParsed(stored), { profile: stored.profile });
  stored.recheck = monitor.recheck(stored, oldAnalysis, { trigger: "usage", now: 10001 }).state;
  monitor.save(stored, store);
  monitor.clear(store);
  assert(store.getItem(monitor.KEY) === null && monitor.load(store) === null,
    "deletion removes months, bills, profile, timeline, and recheck state at once");

  stored = monitor.ingest(monitor.load(store) || monitor.blank(), {
    source: "file", importedAt: 11000, plan: "standard",
    profile: { territory: "nyc", currentPlan: "standard", meter: "smart" },
    months: [month("2026-01", 100, 50)],
    bills: [bill(20260101, 20260131, 35, "new bill")]
  });
  const newAnalysis = calc.analyze(monitor.restoreParsed(stored), { profile: stored.profile });
  const freshRecheck = monitor.recheck(stored, newAnalysis, { trigger: "usage", now: 11001 });
  assert(stored.months.length === 1 && stored.months[0].ym === "2026-01" &&
         !stored.bills.some((b) => b.label === "old retained bill") &&
         newAnalysis.months.length === 1 && newAnalysis.months[0].ym === "2026-01" &&
         freshRecheck.initialized === true && freshRecheck.previous === null,
    "a post-deletion import is analyzed from a blank series without old data or a stale baseline");
});

run("Sample exclusion, raw-data exclusion, and no-network guarantee", () => {
  const appSource = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  const sampleStart = appSource.indexOf('$("sample-btn").addEventListener("click"');
  const sampleEnd = appSource.indexOf("\n  });\n  if (evToggle", sampleStart);
  const sampleHandler = sampleStart >= 0 && sampleEnd > sampleStart
    ? appSource.slice(sampleStart, sampleEnd) : "";
  assert(sampleHandler.includes("window.CONED_SAMPLE") && !sampleHandler.includes("ingestAndRender") &&
         !sampleHandler.includes("M.ingest"),
    "the built-in sample path analyzes in place and never enters monitoring ingestion");

  const secret = "DO_NOT_RETAIN_INTERVAL_OR_TOKEN";
  const raw = { timestamp: "2026-01-15T12:00:00Z", usage: 4.2, marker: secret };
  const series = monitor.ingest(monitor.blank(), {
    source: "gbc", importedAt: 9000, plan: "standard", months: [month("2026-01", 300, 200)],
    hours: [raw], intervals: [raw], rawIntervals: [raw], accountId: secret,
    usagePointId: secret, accessToken: secret, authorizationCode: secret,
    sampleData: secret,
    profile: { territory: "nyc", currentPlan: "standard", meter: "smart", solar: false,
      esco: false, heatPump: false, accountId: secret, token: secret }
  });
  assert(!JSON.stringify(series).includes(secret) && monitor.restoreParsed(series).hours.length === 0,
    "raw intervals, account identifiers, credentials, and sample payloads are excluded");
  const store = memoryStore();
  monitor.save(series, store);
  assert(!store.getItem(monitor.KEY).includes(secret),
    "the serialized localStorage value carries no raw connector data");

  const monitorSource = fs.readFileSync(path.join(__dirname, "../public/monitor.js"), "utf8");
  assert(!/\b(?:fetch|XMLHttpRequest|sendBeacon)\b/.test(monitorSource),
    "monitor.js has no network API path");
  const oldFetch = global.fetch;
  const oldXHR = global.XMLHttpRequest;
  const hadLocalStorage = Object.prototype.hasOwnProperty.call(global, "localStorage");
  const oldLocalStorage = global.localStorage;
  let networkCalls = 0;
  global.fetch = () => { networkCalls++; throw new Error("unexpected monitoring network call"); };
  global.XMLHttpRequest = function () { networkCalls++; throw new Error("unexpected monitoring network call"); };
  global.localStorage = store;
  try {
    monitor.save(series);
    monitor.load();
    monitor.clear();
  } finally {
    if (oldFetch === undefined) delete global.fetch; else global.fetch = oldFetch;
    if (oldXHR === undefined) delete global.XMLHttpRequest; else global.XMLHttpRequest = oldXHR;
    if (hadLocalStorage) global.localStorage = oldLocalStorage; else delete global.localStorage;
  }
  assert(networkCalls === 0, "default localStorage save/load/delete performs no network I/O");
});

console.log(`Monitoring tests: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
