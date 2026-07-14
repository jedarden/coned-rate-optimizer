/* Built-in example: an anonymized "sample NYC home" (~10,300 kWh/yr, peak-heavy).
   Monthly aggregates only — no raw interval data. Reproduces the worked example
   in the docs (Standard ≈ $3,716/yr, TOU ≈ $4,335/yr → switching costs ~$620). */
window.CONED_SAMPLE = {
  label: "Sample NYC home · ~10,300 kWh/yr",
  ndays: 366,
  months: [
    { ym: "2025-06", month: 6, total: 726,  off: 174, peak: 552, summer: true },
    { ym: "2025-07", month: 7, total: 1271, off: 284, peak: 987, summer: true },
    { ym: "2025-08", month: 8, total: 1050, off: 237, peak: 814, summer: true },
    { ym: "2025-09", month: 9, total: 893,  off: 221, peak: 672, summer: true },
    { ym: "2025-10", month: 10, total: 748, off: 210, peak: 539, summer: false },
    { ym: "2025-11", month: 11, total: 699, off: 195, peak: 504, summer: false },
    { ym: "2025-12", month: 12, total: 686, off: 203, peak: 483, summer: false },
    { ym: "2026-01", month: 1, total: 846,  off: 254, peak: 592, summer: false },
    { ym: "2026-02", month: 2, total: 785,  off: 233, peak: 552, summer: false },
    { ym: "2026-03", month: 3, total: 739,  off: 208, peak: 531, summer: false },
    { ym: "2026-04", month: 4, total: 716,  off: 203, peak: 513, summer: false },
    { ym: "2026-05", month: 5, total: 841,  off: 220, peak: 621, summer: false },
    { ym: "2026-06", month: 6, total: 355,  off: 82,  peak: 273, summer: true }
  ]
};
