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
