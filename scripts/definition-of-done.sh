#!/bin/sh
# Definition of done for coned-rate-optimizer: the automated calc-core test
# suite plus the verify script (which applies rates.json on top of the calc.js
# defaults and cross-checks for rate drift).
#
# Flags such as --fast are accepted and ignored: the suite runs in well under
# a second, so there is no faster variant to select.
set -e
cd "$(dirname "$0")/.."
node test/test.js
node verify.js
