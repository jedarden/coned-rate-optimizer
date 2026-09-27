# coned-rate-optimizer — Plan

## Overview

Single-page, 100% client-side ConEd (Con Edison) residential rate-plan
optimizer. Users upload their Green Button usage export (CSV, XML/ESPI, or a
raw `.zip`); `public/calc.js` parses it entirely in-browser and prices their
actual usage under Standard (SC1), Time-of-Use, Steady Use, and Smart Energy
plans, then gives an honest verdict on whether switching would lower their
bill. No server, no upload, no account — `public/app.js` is DOM glue over the
pure calc core, which also runs under Node via `verify.js`.

Deployed at **https://coned.jedarden.com** (Cloudflare Pages). Structure,
rate model, and caveats are documented in `README.md`; deploy mechanics in
`DEPLOY.md` and `deploy/k8s/README.md`.

This file was created 2026-07-20 as part of a fleet-wide deployed-artifact
improvement review — the repo shipped v1.0.0 through v1.4.0 without one.
It is not a retroactive reconstruction of the full history; it exists from
this point forward to record architectural decisions (ADRs) as the project
evolves.

## ADR-001: 2026-07-20 — Formalize the deploy pipeline; stop relying on manual `wrangler` runs

### Context

`coned.jedarden.com` is live and, as of this review, in sync with `main`:
the live `public/calc.js` (`meta.version: "1.4.0"`) is byte-identical to the
repo's HEAD copy. So the site works. The problem is *how* it got there.

`DEPLOY.md` and `deploy/k8s/README.md` both describe a documented, idempotent
GitOps-style deploy path:

- **Phase 1** — a one-shot Deployment (`coned-bootstrap-deployment.yml` +
  `coned-bootstrap-configmap.yml`), applied via `declarative-config`, that
  idempotently creates the Cloudflare Pages project and attaches the
  `coned.jedarden.com` domain.
- **Phase 2** — push-to-deploy, either by adding `coned` to the
  `website-build` Argo Events sensor, or (documented as the interim/manual
  step) submitting `deploy/k8s/coned-deploy-workflow.yml` by hand with
  `kubectl create -f`.
  Phase 3 — delete the bootstrap runner once proven.

Checking the actual live infrastructure against that plan (2026-07-20):

- `declarative-config` (local checkout) contains **no**
  `coned-bootstrap-configmap.yml`, **no** `coned-bootstrap-deployment.yml`,
  and **no** `coned-deploy-workflow.yml` anywhere under `k8s/` — the only
  `coned`-related file present is `k8s/iad-ci/utilities/coned-dnsendpoint.yml`.
- The `iad-ci` cluster has **zero** Argo Workflows that have ever had `coned`
  in the name (checked the full workflow list).
- The `website-build` Argo Events sensor was never extended to include this
  repo.

Conclusion: all four shipped releases (v1.1.0 → v1.4.0) reached production
exclusively via `DEPLOY.md`'s "Step 2 — Direct wrangler" path — someone
sourced the Cloudflare API token from OpenBao by hand and ran
`wrangler pages deploy public --project-name=coned --branch=main` from a
terminal. That path is not committed anywhere, is not triggered by git, and
leaves no audit trail beyond the Cloudflare Pages deployment log itself. It
depends entirely on a person remembering to re-run it after every merge.

This is the single biggest risk to the project's "shipped and working"
status: every other jedarden.com property deploys via commit → Argo
Workflows → done; this one silently depends on human memory. Every
improvement filed alongside this ADR (rates.json/calc.js drift check, FAQ
schema, analytics, etc.) will suffer the same fate — merged to `main`,
invisible on the live site — until this is fixed.

### Decision

Wire real push-to-deploy for `coned-rate-optimizer` through the existing
`website-build` WorkflowTemplate + Argo Events sensor — the same mechanism
every other jedarden.com property already uses — instead of continuing with
manual `wrangler` invocations. Concretely (tracked as a bead, not performed
live in this session — cluster/deploy-pipeline changes go through
`declarative-config` + ArgoCD, never a direct mutation):

1. Copy `deploy/k8s/coned-bootstrap-configmap.yml` and
   `coned-bootstrap-deployment.yml` into
   `declarative-config/k8s/iad-ci/argo-workflows/`, commit, push. (Idempotent
   per its own design — confirms the CF Pages project + domain already exist
   rather than recreating them.)
2. Add `coned-rate-optimizer` to the `website-build` Argo Events sensor's
   repo list, so a push to `main` submits a `website-build` Workflow the same
   way it does for every other site, instead of leaving
   `coned-deploy-workflow.yml` as a doc a human has to `kubectl create -f` by
   hand.
3. Verify with a trivial no-op commit that push-to-deploy actually fires
   before deleting the bootstrap runner (Phase 3, already documented in
   `deploy/k8s/README.md`, now actually executed).
4. Update `DEPLOY.md`'s "Direct wrangler" section to explicitly say
   "break-glass only" so a future reader doesn't mistake it for the normal
   path.

### Alternatives Considered

1. **Cloudflare Pages' native Git integration** (connect the repo directly
   in the CF dashboard, build on every push). Rejected: bypasses the fleet's
   single CI system (Argo Workflows on `iad-ci`), needs its own
   secret/webhook management outside OpenBao, and would make this the only
   jedarden.com property with a second, inconsistent deploy mechanism to
   reason about.
2. **Leave it as-is** (manual `wrangler` on demand). Rejected: this is the
   status quo and is exactly the risk being flagged — it already produced an
   undocumented, unaudited deploy history for v1.1.0–v1.4.0, and there's no
   reason to expect future deploys to be any more disciplined.
3. **Scheduled Argo CronWorkflow** that redeploys `public/` on a timer (e.g.
   nightly) regardless of push events. Rejected: adds up to 24h of latency
   for what should be immediate, doesn't remove the "someone has to notice a
   merge landed" problem for anything time-sensitive, and burns a CF Pages
   deployment slot even when nothing changed.

### Consequences

- **Positive**: every future merge to `main` ships automatically, with the
  same audit trail (Argo Workflow run + logs) as every other repo in the
  fleet; removes single-person-memory as a deploy dependency; the
  already-written idempotent bootstrap steps in `deploy/k8s/README.md`
  finally get executed instead of sitting as unexecuted documentation.
- **Negative / cost**: one-time work to copy the bootstrap files into
  `declarative-config` and extend the sensor; brief risk during the
  bootstrap Deployment's first run if Cloudflare-side project/domain state
  has drifted from what the bootstrap script expects (mitigated by the
  script being additive and idempotent by design — it never deletes
  anything).
- **Follow-up**: once live, every bead filed in this same review pass (rate
  drift check, FAQ schema, analytics, EV modeling) will actually reach
  `coned.jedarden.com` on merge instead of requiring a manual deploy
  reminder.

## ADR-002: 2026-09-27 — Eligibility & lock-in rules as overridable data, applied by a pure engine in calc.js

### Context

The product strategy's customer journey begins with a "location/account
eligibility check" and its paid result promises "exact rate name and
eligibility notes" plus "switching timing and lock-in warning" (technical gap
#3: an eligibility engine). Until v1.7.0 the tool priced all four SC1 plans
unconditionally: every plan was `avail: true`, Standard was hardcoded as the
current plan, and ConEd's published enrollment terms (TOU's one-year
commitment and 18-month rejoin block, the demand plans' 18-month
re-enrollment block, their smart-meter requirement, ConEd's solar guidance)
appeared nowhere.

The rules were verified against the coned.com plan pages via Wayback Machine
snapshots (2026-06-17 TOU, 2026-07-03 Steady Use, 2026-05-20 Smart Energy) —
coned.com itself Akamai-blocks every fetch path from this environment.

### Decision

1. **The rules live as data on each plan** in `RATES` (`requires`,
   `lockIn`, `solar`, `smartChargeConflict`), mirrored in `rates.json` like
   every other plan attribute, so ConEd term changes are an edit + redeploy,
   not a code change. Notes quote/track ConEd's published wording so the UI
   never invents terms.
2. **A pure `checkEligibility(profile, ctx)` engine in calc.js** turns a
   declared profile (territory, service class, meter, current plan, solar,
   ESCO, heat pump — all optional with defaults matching the home the rate
   data assumes) into per-plan verdicts. It emits whole-analysis blockers
   (non-ConEd territory, non-SC1 account), global notes (Westchester pricing
   caveat, ESCO supply caveat), and per-plan notes (lock-in, seasonality,
   price guarantee, fit guidance).
3. **Excluded plans stay visible.** They keep their priced estimate and rank
   last in the comparison with a "not eligible" reason, but are never the
   switch target and never drive the verdict. Hiding them would hide the
   reason a cheaper-looking number doesn't apply; dropping them would hide
   that the plan exists.
4. **Solar is advisory, not exclusionary.** ConEd's own words are "likely not
   a good fit" / "do not recommend" — the engine surfaces that guidance as a
   note rather than pretending ConEd forbids it.
5. **`analyze()` generalizes the current plan** (it was hardcoded Standard):
   `cheapest` keeps its old meaning (cheapest available, including the
   current plan — the "Best plan" stat), and a new `switchTarget` is the best
   eligible plan you're not on. `savingsIfSwitch` is now measured from the
   declared current plan; with the default profile the numbers are unchanged.

### Alternatives Considered

1. **Hard-exclude solar homes from the demand plans.** Rejected: overstates
   ConEd's guidance and silently shrinks the comparison.
2. **Drop excluded plans from the output entirely.** Rejected: the customer
   can't tell "not worth it" from "not allowed", and the reason is the
   trust signal the strategy asks for.
3. **A wizard-style gate before upload** (ask territory/account before the
   file, like the strategy's funnel). Rejected for the prototype: the local
   upload flow has no account identity anyway; declared-profile gating after
   analysis delivers the same protection with zero funnel friction. The
   Phase-2 Green Button Connect flow is the right place for a hard front gate.

### Consequences

- **Positive**: the verdict can no longer recommend a plan the customer
  can't switch to; lock-in/timing costs are visible at decision time; rules
  update without code; the CLI (`verify.js`) and the browser share the same
  engine and notes.
- **Negative / cost**: seven more profile inputs to maintain and test; the
  engine's notes are English sentences assembled from data, so rewording a
  rule needs care (tests assert on key phrases).
- **Follow-up**: EVTOU — the archived TOU page steers residential EV owners
  to a dedicated EV rate while this repo's FAQ calls EVTOU commercial-only;
  reconcile when coned.com is reachable again. Agentation on this page is
  tracked separately (conedrat-341ced52).

## ADR-003: 2026-09-27 — Tariff updates as a gated workflow: `validate-rates.js` in the definition of done, `docs/tariff-update-workflow.md` as the authority

### Context

`rates.json` is the tool's whole tariff store, and until now updating it was
tribal knowledge scattered across comments: the README said "update the
constants in `public/calc.js` (`RATES`) when ConEd rates change" (which predates
the rates.json override path), the rates.json `_comment` said "edit + redeploy"
(which predates push-to-deploy, where a push *is* the redeploy), and the only
freshness mechanism was `app.js`'s 6-month UI banner — which tells the *user*
the data may be stale after it has already shipped. Nothing stood between a
tariff edit and production except the calc-core test suite, which asserts
behavior, not data quality: a plan dropped from rates.json, a cents-as-dollars
unit slip, a `standard.*` update without the matching `bill.periods` year, or a
rule tweak applied to one file but not its mirror would all ship green. The
failure modes are real for this repo specifically because the data has two
copies (rates.json + baked-in calc.js defaults) that must agree, and because
`standard` and `bill.periods` come from the same ConEd PDF and must move
together.

### Decision

1. **`docs/tariff-update-workflow.md` is the single authority** for tariff
   changes: sources (publication + Wayback snapshot date, since coned.com
   blocks direct fetches), the full rates.json schema, the four layers of
   effective-period handling (verification horizon / per-plan `ratesAsOf` /
   billing-year periods with the `projected` rule / seasonality split between
   engine config and data), the release process (both files in one commit,
   version bump, push-to-deploy, post-deploy fetch of the live rates.json,
   rollback by revert), and the quarterly re-verification cadence.
2. **`scripts/validate-rates.js` is the mechanical gate** — schema, units,
   cross-field consistency, effective-period coverage, `reviewedThrough`
   freshness (warn at 4 months, fail at 6, `--allow-stale` to ship knowingly),
   per-source re-verification cadence — each plan's `ratesAsOf` measured
   against its publication's window, parsed from the workflow doc's §2 source
   table so gate and doc cannot drift (95 days for the quarterly pages,
   13 months for the annual PDF; warn at ⅔ of each window) — and mirror
   discipline against the calc.js defaults. It ships with a 24-case
   `--self-test` that mutates a known-good copy and asserts each defect is
   caught, so the gate cannot silently rot.
3. **The gate joins the definition of done** (`scripts/definition-of-done.sh`),
   ahead of the test suite. That is the enforcement point workers, humans, and
   the NEEDLE close-verification all already run — no new CI surface needed for
   a repo whose deploy pipeline lives in `declarative-config`.

### Alternatives Considered

1. **Documentation only** (write the workflow down, no code). Rejected: the
   drift-check lesson from ADR-001 applies — a documented checklist that
   nothing enforces is exactly how the manual-wrangler deploys happened.
2. **Enforce in the `website-build` workflow template** (run the gate in CI
   before `wrangler pages deploy`). Rejected for now: the template lives in
   `declarative-config` and is shared by every jedarden.com property, so
   per-repo gate logic there couples repos; the definition of done already runs
   on every path to `main` for this repo. Revisit only if pushes start
   bypassing it.
3. **Scheduled CronWorkflow re-verifying rates against coned.com**. Rejected:
   coned.com Akamai-blocks this environment (ADR-002), so automated
   verification would be a scrape that never works or, worse, half-works;
   quarterly human/agent re-verification against archived snapshots is
   honest about what is checkable.

### Consequences

- **Positive**: the data-quality failure modes above (missing plan, unit slip,
  standard/bill-history divergence, one-sided mirror edit, stale
  `reviewedThrough`) now fail loudly before deploy; freshness policy is one
  field (`reviewedThrough`) read identically by the gate, the UI banner, and
  this doc; the validator tests itself, so the gate's own regressions are
  caught by the same definition of done.
- **Negative / cost**: one more script to keep in sync with the schema when
  rates.json legitimately grows (new plan, new field) — the self-test makes
  that change explicit rather than accidental; the 6-month staleness gate can
  block an unrelated merge if the quarterly re-verification lapses, which is
  by design (it should be loud).
- **Follow-up**: when Phase 2 introduces versioned effective-date tariff
  storage (`docs/product-strategy.md`, technical gap #1), this gate becomes the
  ingestion validation for that store rather than going away.


## ADR-004: 2026-09-27 — Bill replay gates the verdict's confidence; product claims scoped to the accuracy gate

### Context

The README claimed the tool shows "precisely, for your real usage, whether
switching ConEd rate plans would lower your bill," while the strategy document
calls the same prototype "not yet a chargeable rate audit" built on "partly
simplified and outdated assumptions" (technical gaps #4–#6: bill
reconstruction, historical backtest, confidence system) and sets a hard
accuracy gate — ≥95% of complete, supported billing periods within 2% — that
must pass on ≥20 diverse real accounts before a chargeable product may exist.
Both statements were true; the README's word "precisely" was the lie in the
middle.

### Decision

1. **The strategy's accuracy gate is implemented as code, not prose.**
   `RATES.accuracy` (passPct 2, warnPct 5, gateFraction 0.95) is data,
   mirrored in `rates.json` and validated by the tariff gate. The pipeline:
   `parseBillingESPI` (the Green Button Connect UsageSummary feed → bill
   records) → `reconcileBills` (each bill replayed component-by-component at
   its own year's published rates, compared with what was actually paid; only
   bills with ≥80% interval coverage count — "complete, supported") →
   `accuracyGate` (the 95%-within-2% call, misses listed, never averaged) →
   `assessConfidence` (high = gate passed; medium = unverified, with each
   reason named; low = the model disagrees with the bills it could check).
2. **Confidence rides on the analysis result and renders above the verdict.**
   A savings number is never shown without its label. Downgrades are
   per-condition and named (no bills, missing months, bill-chain gaps,
   unusable summaries, monthly-only data, short window, Westchester pricing,
   non-Standard basis); they do not compound — "medium" is the floor for every
   unverified condition, and only a failed gate means "low", because only a
   failed gate means the model actively disagrees with reality.
3. **The README claim is narrowed to what the gate supports** ("Verified"
   means the reconstruction reproduces your bills; counterfactuals keep the
   estimate caveats) and states plainly that the paid-product bar — 20
   backtested accounts — is not met, so the site's numbers are a labeled
   estimate, not an audit.

### Consequences

- **The honest "no bills" case is the loud default.** File-only uploads (the
  current production path, until ConEd's third-party onboarding lands) show
  "Confidence: medium — no actual bills imported" instead of an unqualified
  verdict. That is the point.
- **Known model gaps surface as data, not silence:** a bill the reconstruction
  misses renders in the fail band with its worst component named, which is
  exactly the evidence the Stage-1 calculation audit (strategy doc) needs to
  decide kill-or-continue.
- **Follow-up:** the 20-account backtest itself is offline work (recruiting +
  manual bill comparison per the strategy's experiment plan); nothing in this
  repo can close it. Until then the gate exists, is tested, and the claims
  stay scoped beneath it.
