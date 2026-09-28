# Monitoring — data retention & deletion contract

Bead `conedrat-1e5e8967` · 2026-09-28

The month-over-month experience in [`docs/product-strategy.md`](../product-strategy.md)
("Month-over-month experience") is only a prototype behavior if it evaporates when
the tab closes: question 4 — *how much has the switch actually saved?* — needs
history, and question 3 — *am I still on the best eligible rate?* — needs to be
re-asked after rates move. So the page keeps a monitoring history. This document is
the contract that history runs by: what is kept, where it lives, what it can never
contain, when it goes away, and how it is deleted. It is the amendment to the
site's privacy copy — "never uploaded, never sent anywhere" stays true; "never
stored" is now qualified, precisely, below.

## The contract in one paragraph

Every real import (a dropped Green Button file or a Share My Data pull) merges
into one retained **series** and the analysis re-runs over the whole retained
window. The series lives in your browser's `localStorage` under the key
`coned-monitor-series-v1` (`public/monitor.js`, `KEY`) — on your device, inside
your browser profile, **sent nowhere**: no network request in this feature reads
or writes it. It holds three kinds of records — **monthly usage buckets**
(`YYYY-MM` totals, peak/off-peak split, observed day count), the **bill summaries**
you imported (period dates, cost, label — the accuracy gate's evidence), and the
**eligibility facts you declared** (territory, plan, meter, solar, ESCO, heat
pump), plus the plan-switch timeline the imports declared. The newest
**36 monthly buckets** are the window (`RETENTION_MONTHS`); older buckets age out
as newer imports arrive, are counted, and the bill summaries whose periods fall
outside the window go with them. Raw hourly interval data, account identifiers,
usage-point IDs, and credentials are **never retained** — the Share My Data
access token still lives only in the tab's `sessionStorage` and dies with the tab
([gbc-data-boundary.md](gbc-data-boundary.md) is unchanged). Deletion is one
click ("Delete stored data" in the Monitoring section, with a confirmation):
`clear()` removes the key, the page forgets everything immediately, and there is
no copy anywhere else to delete.

## Field by field

| Retained | Shape | Why |
|---|---|---|
| Monthly buckets | `{ ym, month, total, peak, off, summer, ndays, revisions }` per `YYYY-MM` | The units every counterfactual is priced from; `revisions` counts how many later imports re-measured the month (newest data wins — strategy: *preserve revisions*) |
| Bill summaries | `{ ymdStart, ymdEnd, days, cost, currency, label, revisions }` | The accuracy gate's actual-bill evidence; a re-pulled summary replaces its earlier self and counts the revision |
| Plan timeline | `{ from, plan, source, at }` per declared switch | Lets a recorded plan switch reprice each month's actual on the plan that was in effect, and price what the switch has saved so far |
| Declared profile | territory, current plan, meter, solar, ESCO, heat pump | What a revisit re-declares so the eligibility verdict runs without re-answering |
| Recheck baseline | last recommendation plus rate, usage, and profile fingerprints | Detects a decision-changing tariff refresh or import locally; contains no raw readings |
| Bookkeeping | `imports`, `lastImportedAt`, `trimmed`, `schema` | What the Monitoring status line reports; `schema` gates forward compatibility |

**Never retained:** hourly interval data (demand-plan counterfactuals over past
months are reported *unpriced* with the months named — never approximated from
monthly buckets), account/usage-point identifiers, the access token, the
authorization code, anything from the demo sample (analyzed, never stored).

The series also keeps a small **recheck baseline**: the last recommendation,
the published-rate fingerprint plus its version/review date, and fingerprints
of the retained usage and declared profile. It contains no additional raw
usage. On a later visit, after a tariff refresh, or after a new import, the
browser compares the new analysis with that baseline and persists the new
baseline after rendering it. An alert is rendered when the decision changes;
it names the old and new recommendation and says whether the trigger was
updated rates, new/revised usage, or changed eligibility facts. If an input
changed but the decision did not, the Monitoring section shows a non-alerting
"rechecked" notice with the reason and current recommendation. Persisting the
baseline makes that notice/alert a one-time explanation rather than repeating
it on every revisit.

## Retention window

- The series keeps the newest **36** monthly buckets. When an import pushes the
  count past 36, the oldest buckets are dropped and `trimmed` counts them; the
  Monitoring status line reports the total ("… older months aged out of the
  36-month window").
- Bill summaries whose period ends before the oldest retained bucket leave with
  the window — their periods are no longer part of the monitored history.
- Nothing expires on its own: retention is depth-triggered (new imports pushing
  old months out), never time-triggered. A series untouched for a year is still
  exactly where you left it.

## On revisit

Loading the page restores the series and re-runs the whole analysis over it at
the **current published rates** (strategy: *rerun the recommendation after rate
or load changes*) and re-checks the retained bill evidence through the accuracy
gate. If that recheck changes the decision, the Monitoring section explains
what moved and why; if the tariff release changed but the decision did not, it
names the release and says the recommendation remains unchanged. The stale-rate
banner is evaluated against the baked-in fallback before the network override
loads, so a failed `rates.json` fetch cannot hide stale results. A revisit is
the landing view — it renders without scrolling the page.

## Deletion

- **By the user:** "Delete stored data" (Monitoring section) → confirmation →
  `localStorage.removeItem` of the single key. Immediate and total: months,
  bill summaries, timeline, and profile all live in that one key; nothing
  survives in another store, and no server copy exists to delete. Disconnecting
  Share My Data is *not* deletion — it clears the tab's token only; deleting the
  stored history is a separate, explicit act.
- **By aging:** buckets older than the 36-month window fall out as described
  above.
- **By corruption:** a stored series that fails to parse, was written by another
  schema version, or has a malformed month list is discarded on load — the page
  starts fresh rather than crashing or rendering half a history.

## Enforced, not just stated

- `test/test.js` Test 21 pins the contract end-to-end: newest-wins merging with
  revision counts, backward extension (an older import extends the window rather
  than erasing it), the 36-bucket trim with bill fall-out, the plan timeline and
  per-segment repricing, unpriced demand counterfactuals, and the storage
  behaviors — round-trip, empty-store-means-nothing, corrupt/foreign-schema
  input starts fresh, deletion removes everything, and `save()` with no storage
  throws (the UI surfaces the failure; an import is never silently dropped).
- `tools/verify-gbc-browser.js` drives it live in Chromium: connect → pull →
  file import merges into the series → reload restores the retained history →
  "Delete stored data" clears `localStorage` and the page forgets.
- The no-network claim is structural: `monitor.js` performs no I/O beyond the
  `localStorage` calls its store parameter receives — the same store can be, and
  in the tests is, an in-memory `Map`.
- `test/test.js` Test 22 proves the recheck workflow: the first calculation
  establishes a baseline, unchanged recommendations stay quiet, and changed
  recommendations caused by new usage or changed rates alert with the cause.
