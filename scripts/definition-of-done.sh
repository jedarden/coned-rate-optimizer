#!/bin/sh
# Definition of done for coned-rate-optimizer: the tariff data gate (which
# self-tests, then validates rates.json — schema, consistency, effective
# periods, freshness — see docs/tariff-update-workflow.md), the automated
# calc-core test suite, the Green Button Connect sandbox Third-Party App
# authorization (mock OAuth + ESPI Data Custodian driving the real gbc.js and
# Pages Function), and the verify script (which applies rates.json on top of
# the calc.js defaults and cross-checks for rate drift).
#
# Flags such as --fast are accepted and ignored: the suite runs in well under
# a second, so there is no faster variant to select.
set -e
cd "$(dirname "$0")/.."
node scripts/validate-rates.js --self-test
node scripts/validate-rates.js
node test/test.js
node test/gbc-sandbox.js
node verify.js
