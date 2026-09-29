#!/bin/sh
# Definition of done for coned-rate-optimizer: the tariff data gate (which
# self-tests, then validates rates.json — schema, consistency, effective
# periods, freshness — see docs/tariff-update-workflow.md), the automated
# calc-core and focused monitoring retention/deletion test suites, the analytics privacy contract (event allowlist +
# no-payload regression checks — see docs/notes/analytics-privacy.md), the
# Green Button Connect sandbox Third-Party App authorization (mock OAuth +
# ESPI Data Custodian driving the real gbc.js and Pages Function), and the
# production-binding smoke-check contract (with fake responses, so no live
# credential or endpoint is needed), the provisioning script's shell syntax,
# strict rates.json/calc.js mirror check, and the verify script (which applies
# rates.json on top of the calc.js defaults and reports any rate drift).
#
# Flags such as --fast are accepted and ignored: the suite runs in well under
# a second, so there is no faster variant to select.
set -e
cd "$(dirname "$0")/.."
node scripts/validate-rates.js --self-test
node scripts/validate-rates.js
node scripts/check-rate-drift.js
node scripts/regenerate-reconstruction-tests.js --check
node test/tariff-refresh.js
node test/test.js
node test/monitoring-retention.js
node test/checkout.js
node test/backtest-harness.js
node test/certification-workflow.js
node test/analytics-privacy.js
node test/gbc-sandbox.js
bash -n scripts/provision-gbc-bindings.sh
node test/gbc-production-smoke.js
node verify.js
# Browser-level deploy check: exercise the shipped page through a local static
# server and require Agentation's root and toolbar to mount after load. The
# same check also proves normal visitors do not fetch the feedback payload.
node tools/verify-agentation-mount.js --local
