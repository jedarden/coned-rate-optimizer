# Accuracy and payment certification enablement

This is the release gate for turning the paid-report path from an integrated
but unavailable feature into a chargeable feature. It is intentionally
separate from the free calculation: a visitor must continue to receive the
current-plan verdict, savings range, confidence warnings, and no-savings
answer when either certification is missing or checkout is unavailable.

## Durable certification artifact

The durable record is a redacted JSON artifact produced outside the participant
data directory and reviewed into the release record. Store it in the private
release evidence store, or in a repository path agreed by the release owner;
never commit `audit-corpus/`, usage exports, bills, account numbers, names,
tokens, or payment credentials. The artifact contains only opaque account ids,
categorical cohort counts, modeled/actual totals for misses, and review
references. `tools/validate-certification.js` is the schema and gate check.

The artifact has `artifactVersion: 1` and these sections:

| Section | Required evidence |
| --- | --- |
| `model` | full Git commit, policy version, rate-data date, and the exact backtest tool |
| `accuracy` | at least 20 account rows; supported-period and within-2% counts; aggregate share; each account's complete miss list |
| `diversity` | categorical counts across at least two dimensions with at least two buckets each, plus reviewer attestation |
| `provider` | provider id, tested commit, test timestamp, and every deterministic provider check with command and evidence reference |
| `review` | separate accuracy and provider decisions, reviewer identities, timestamps, and decision references |
| `enablement` | both flags, free-result assertion, two-person change approval, and a tested rollback reference |

Each miss is an object, not a footnote: period, modeled total, actual total,
delta, percentage error, pass/warn/fail band, modeled component breakdown,
largest modeled component, cause, disposition, owner, and resolution are
required. A passing aggregate never removes or hides a miss. A supported
period is counted only when interval coverage meets the production
`reconcileBills` coverage rule; unsupported or incomplete periods are named
and excluded rather than priced on invented usage.

The artifact's `eligible` result is derived, never hand-edited. It is eligible
only when all of these are true:

1. At least 20 consented, usable, anonymized accounts are present and the
   diversity review covers two or more categorical dimensions.
2. At least 95% of all complete, supported periods are within 2% of the real
   bill, using the same rates and commit shipped by the candidate release.
3. Every period outside 2% has an investigation record and disposition.
4. The payment-provider checks pass at that same commit and a separate
   provider reviewer approves them.
5. The free-result invariant is true and the enablement change has two
   distinct approvers plus a rollback procedure.

Run the structural check without participant data:

```sh
node tools/validate-certification.js --artifact /secure/release-evidence/certification.json
```

Exit 0 means the artifact is valid and eligible to arm both gates. Exit 2
means it is structurally valid evidence but still not eligible. Exit 1 means
the evidence is malformed or violates the contract. The validator prints no
participant payloads.

## Accuracy review workflow

1. Obtain written consent and create one corpus directory per account. Each
   directory contains `consent.json`, one usage export, `bills.json`, and a
   categorical `cohort.json`; the corpus remains outside Git.
2. Run the exact candidate commit against the corpus:

   ```sh
   node tools/backtest-accounts.js --corpus "$CORPUS" --out "$OUT"
   ```

   The runner accepts one account directory per opaque lowercase id. Each
   bundle must contain only `consent.json`, categorical `cohort.json`,
   `bills.json`, and exactly one CSV/TSV/XML/ZIP usage export; stray files and
   unconsented bundles are refused. `--min-accounts` can require more than 20
   accounts for a stricter run, but never lowers the strategy's mandatory
   20-account floor. Bill labels are regenerated from dates in the report so
   handwritten participant text cannot enter the anonymized artifact.

   Exit 0 is the only accuracy result that can be proposed for certification.
   Exit 1 is a failed/refused audit and exit 2 is incomplete; neither may arm
   a flag. The generated JSON records the commit, rate provenance, account
   outcomes, aggregate counts, diversity counts, unsupported periods, and
   every miss. The Markdown summary is a human review aid, not the source of
   truth.
3. Two reviewers compare the artifact to the source run, confirm account
   diversity without seeing or copying identifying data, and assign a cause,
   owner, disposition, and resolution to every miss. A warn-band miss is still
   outside the 2% certification gate and must be documented.
4. Re-run the validator and attach the exact output, source commit, and
   reviewer decision references to the release record. Do not change a
   threshold to make a miss disappear; fix the model/rates or record why the
   account is unsupported and rerun the audit.

## Payment-provider certification

Stripe Checkout is integrated as the current provider, but integration is not
certification. At the candidate commit, run `node test/checkout.js` and record
the result in the provider section. The provider evidence must cover:

- fixed $29 USD product, policy version, and quantity;
- only `{ product, policyVersion }` leaving the browser;
- no usage, bills, account identifiers, or caller-supplied pricing reaching
  the provider;
- origin checks and unavailable-provider behavior;
- session verification of mode, product, policy, amount, currency, payment
  status, and completion before unlocking the report;
- cancellation, pending, provider failure, and bounded retry behavior; and
- no payment credential or secret in logs, artifacts, source, or test output.

The provider reviewer must be independent of the accuracy reviewer. A
provider can be wired and fully tested while `providerCertified` remains
false.

## Controlled flag enablement and rollback

The client-side policy flags in `public/rates.json` and the server-side Pages
bindings are two independent fail-closed controls:

| Layer | Flag | Safe shipping value | Enablement requirement |
| --- | --- | --- | --- |
| browser policy | `pricing.chargingCertified` | `false` | approved accuracy artifact and release change |
| browser policy | `pricing.providerCertified` | `false` | approved provider artifact and release change |
| Pages environment | `REPORT_CHARGING_CERTIFIED` | absent/false | same approved accuracy artifact |
| Pages environment | `PAYMENT_PROVIDER_CERTIFIED` | absent/false | same approved provider artifact plus provider secret configured out-of-band |

The release owner performs the following controlled change:

1. Freeze the artifact's model commit, policy version, and reviewer decisions.
2. Run the repository definition of done and `node test/checkout.js` from a
   clean extraction of the candidate commit. Confirm the artifact validator
   is exit 0 and that both flags are still false before the change.
3. Commit the reviewed policy-flag change to `main`, with the artifact id and
   evidence references in the change description. Never put the provider
   secret in Git or in a command argument.
4. Deploy the client change while the server bindings remain false; this is a
   safe intermediate state because the server refuses checkout. Verify the
   free result and the unavailable-checkout path in production.
5. Set both server bindings through the deployment secret/configuration
   workflow, then run a synthetic $29 checkout and session-verification probe.
   The server must not accept a partially enabled or mismatched pair.
6. Record the deployment revision, operator, timestamps, and probe result in
   the artifact. If any probe or monitoring check fails, immediately set the
   server bindings false first, then revert the client policy flags and record
   the rollback reference.

`paidConversion()` may show a qualifying offer before collection is enabled,
but `collectible` stays false until both client certifications, the provider
descriptor, and both server bindings agree. The free result is rendered before
and independently of this state machine; cancellation, provider failure, and
an unavailable deployment return to that free result rather than hiding it.
