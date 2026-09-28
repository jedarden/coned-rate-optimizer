#!/usr/bin/env bash
# Provision the Green Button Connect Pages bindings without putting values in
# argv, files, repository history, or command output. Values must already be
# present in this process environment from the approved secret-management
# workflow; this script never prints them.
set -euo pipefail

PROJECT="${PAGES_PROJECT:-coned}"

fail() {
  printf '%s\n' "GBC provisioning failed: $1" >&2
  exit 1
}

for binding in GBC_CLIENT_ID GBC_CLIENT_SECRET GBC_TOKEN_URL; do
  [ -n "${!binding:-}" ] || fail "$binding is unset or empty"
done

case "${GBC_TOKEN_URL}" in
  https://*) ;;
  *) fail "GBC_TOKEN_URL must use https" ;;
esac

GBC_TOKEN_AUTH="${GBC_TOKEN_AUTH:-basic}"
case "$GBC_TOKEN_AUTH" in
  basic|body) ;;
  *) fail "GBC_TOKEN_AUTH must be basic or body" ;;
esac

if command -v wrangler >/dev/null 2>&1; then
  WRANGLER=(wrangler)
elif command -v npx >/dev/null 2>&1; then
  WRANGLER=(npx --yes wrangler)
else
  fail "wrangler or npx is required"
fi

put_binding() {
  local key="$1"
  # Keep the value on stdin. Both stdout and stderr are suppressed so a CLI
  # diagnostic can never accidentally echo a binding into an operator log.
  if ! printf '%s' "${!key}" | "${WRANGLER[@]}" pages secret put "$key" \
    --project-name "$PROJECT" >/dev/null 2>/dev/null; then
    fail "wrangler could not provision $key (CLI output suppressed)"
  fi
}

# Pages secret bindings are used for all four values, including the public-ish
# client id and auth mode. That keeps one audited, out-of-band path and avoids
# putting onboarding values in wrangler.toml or a checked-in env file.
put_binding GBC_CLIENT_ID
put_binding GBC_CLIENT_SECRET
put_binding GBC_TOKEN_URL
put_binding GBC_TOKEN_AUTH

printf '%s\n' "Provisioned Pages bindings for project '$PROJECT': GBC_CLIENT_ID, GBC_CLIENT_SECRET, GBC_TOKEN_URL, GBC_TOKEN_AUTH."
