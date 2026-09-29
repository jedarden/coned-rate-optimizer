# Deploying to coned.jedarden.com (idempotent)

Everything needed already exists in `declarative-config`. The Cloudflare API token is **not** stored in the repo as plaintext (correct) — it lives in **OpenBao** and is surfaced two ways:

- **Terraform** (`terraform/cloudflare/`): provider uses `var.cloudflare_api_token`, supplied via uncommitted `terraform.tfvars` (see `terraform.tfvars.example`). The `jedarden.com` zone is already wired: `var.zone_id_jedarden_com`.
- **Argo Workflows** (`k8s/iad-ci/argo-workflows/`): `cloudflare-pages-externalsecret.yml` syncs the token from OpenBao (`rs-manager/iad-ci/cloudflare/pages`, property `CF_API`) into the `cloudflare-pages-secret` Secret, which the `website-build` WorkflowTemplate uses for `wrangler pages deploy`.

## Step 1 — create the Pages project + custom domain + DNS (idempotent, declarative)

Add to `declarative-config/terraform/cloudflare/pages.tf` (mirrors the `devimprint` pattern):

```hcl
resource "cloudflare_pages_project" "coned_jedarden_com" {
  account_id        = var.cloudflare_account_id
  name              = "coned"
  production_branch = "main"
  deployment_configs {
    production { compatibility_date = "2025-01-01" }
    preview    { compatibility_date = "2025-01-01" }
  }
}

resource "cloudflare_pages_domain" "coned_jedarden_com" {
  account_id   = var.cloudflare_account_id
  project_name = cloudflare_pages_project.coned_jedarden_com.name
  domain       = "coned.jedarden.com"
}
```

Add to `declarative-config/terraform/cloudflare/dns.tf`:

```hcl
resource "cloudflare_record" "coned_jedarden_com" {
  zone_id = var.zone_id_jedarden_com
  name    = "coned"
  type    = "CNAME"
  content = "coned.pages.dev"
  proxied = true
  ttl     = 1
}
```

Then (from `terraform/cloudflare/`, with `terraform.tfvars` populated from OpenBao):

```bash
git pull --rebase origin main      # declarative-config discipline
terraform apply                    # idempotent: creates project + domain + DNS, no-ops if present
git add pages.tf dns.tf && git commit -m "feat(cloudflare): coned.jedarden.com Pages project" && git push origin main
```

## Step 2 — deploy the site content

**Push-to-deploy** is wired via the `website-build` Argo WorkflowTemplate (see `docs/plan/plan.md` ADR-001). Every push to `main` auto-deploys to https://coned.jedarden.com. The pipeline runs the tariff data gate **as the deploy's build step**: the coned trigger in `declarative-config/k8s/iad-ci/argo-events/website-build-sensor.yml` sets `build-command: sh scripts/definition-of-done.sh`, and the template executes that under `set -e` **before** `wrangler pages deploy` — so a change that fails the gate (per [`docs/tariff-update-workflow.md`](docs/tariff-update-workflow.md)) fails the workflow and **does not deploy**. Running `scripts/definition-of-done.sh` locally before pushing is still worth it: it catches a red gate in seconds instead of in a failed CI run.

### Break-glass only: direct wrangler deploy

**This is a break-glass emergency escape hatch, not the normal deploy path.** Use this ONLY if push-to-deploy fails and you need to deploy outside the CI pipeline immediately.

Normal deployments happen automatically via push-to-deploy (see above).

**Hard rule — the gate applies here too.** A manual wrangler deploy bypasses the pipeline's build step, so it must supply the gate itself: run `scripts/definition-of-done.sh` **immediately before** any manual `wrangler pages deploy`, from the exact tree being deployed, and do not deploy while it is red (exit ≠ 0). A red gate means fix `rates.json`/`calc.js` first — the only exception is rolling back production to a known-good prior release, which by definition passed the gate when it shipped.

```bash
sh scripts/definition-of-done.sh   # must be green before anything below runs
CLOUDFLARE_API_TOKEN=<from OpenBao rs-manager/iad-ci/cloudflare/pages → CF_API> \
  wrangler pages deploy public --project-name=coned --branch=main
```

## Step 3 — provision the GBC Pages bindings out of band

Do this only after Con Edison has issued the third-party application
credentials and exact token endpoint. The browser remains disabled while
`public/gbc-config.json` says `configured: false`; provisioning these bindings
does not put a secret in the repository or enable the UI by itself.

The Pages Function reads these bindings:

| Binding | Required | Value |
|---|---:|---|
| `GBC_CLIENT_ID` | yes | Con Edison's registered third-party client id |
| `GBC_CLIENT_SECRET` | yes | The client secret, never a browser/public config value |
| `GBC_TOKEN_URL` | yes | The exact HTTPS token endpoint issued during onboarding |
| `GBC_TOKEN_AUTH` | no | `basic` (default) or `body`, exactly as required by Con Edison |

Retrieve the onboarding values from the approved secret-management record into
the current shell environment. Do not put them in command arguments, a file,
`.env`, `wrangler.toml`, shell output, or a commit. The Cloudflare API token
used by Wrangler must likewise come from the existing OpenBao-backed Pages
credential path. The command below pipes each value to Wrangler's stdin and
suppresses Wrangler output:

```bash
# Populate these names from the approved secret manager; do not use inline
# `NAME=value command` assignments, which put values in shell history/process
# listings. GBC_TOKEN_AUTH may be omitted and defaults to basic.
export GBC_CLIENT_ID GBC_CLIENT_SECRET GBC_TOKEN_URL GBC_TOKEN_AUTH
PAGES_PROJECT=coned ./scripts/provision-gbc-bindings.sh
unset GBC_CLIENT_ID GBC_CLIENT_SECRET GBC_TOKEN_URL GBC_TOKEN_AUTH
```

The script rejects a non-HTTPS token URL and any auth mode other than `basic`
or `body`. It stores all four values as Pages secret bindings so there is one
out-of-band path and no onboarding value is added to `wrangler.toml` or the
repository. It is safe to rerun for rotation; rerun the smoke check after all
four updates have completed. If the secret put fails, the script reports only
the binding name and intentionally withholds CLI diagnostics.

If onboarding requires body authentication, set `GBC_TOKEN_AUTH=body` before
running the script. Otherwise leave it unset (the script provisions the
explicit `basic` default, preventing a stale prior mode from surviving a
rotation).

## Step 4 — verify production without a credential

Run the smoke check against the deployed Pages Function after provisioning:

```bash
node scripts/smoke-gbc-production.js
# Optional non-default endpoint:
GBC_SMOKE_URL=https://coned.jedarden.com/api/gbc/token \
  node scripts/smoke-gbc-production.js
```

The check first validates the deployed public configuration, including the
registered redirect URI (`https://coned.jedarden.com/`) and the relative
`/api/gbc/token` path. It then makes three safe token-endpoint requests and
never sends a client credential or logs either response body:

1. A foreign `Origin` must receive `403 origin_not_allowed`, proving the
   same-origin relay guard runs before the body is read or Con Edison is
   contacted.
2. A same-origin malformed body must receive `400 invalid_request`. A `503
   gbc_not_configured` result means at least one required binding is missing.
3. A newly generated, synthetic authorization code must receive Con Edison's
   normal `400 invalid_grant`. A `400`, `401`, or `403 invalid_client` result
   means the configured client authentication was rejected and the bindings
   must be checked or rotated. Network failures, `502 upstream_unreachable`,
   malformed success responses, and every other status fail the check.

The synthetic code is never a customer grant and cannot retrieve usage. The
smoke check is therefore suitable for production and can be rerun after a
secret rotation. The committed contract suite additionally drives an
authorization callback and the real client through direct interval and
billing-feed GETs, then asserts that the token endpoint saw only
`{code, redirectUri}` and never usage, billing, or token bytes:

```bash
node test/gbc-production-smoke.js
```

It does not replace the browser E2E sandbox or the normal deploy gate.

To revoke access, revoke the third-party app in Con Edison's developer/account
controls, then remove the Pages bindings through the Cloudflare dashboard or
the equivalent `wrangler pages secret delete` commands. Do not record deleted
values in a ticket or log. Re-enabling requires a fresh onboarding credential,
the four-binding provisioning step, and a passing smoke check.

## Notes / caveats

- The Cloudflare Terraform is applied **manually** (standalone state), not by ArgoCD — ArgoCD only syncs `k8s/`. So Step 1's `terraform apply` is a manual run wherever the token + network + tfstate live.
- This session may lack Tailscale/OpenBao/Cloudflare reachability, so the actual `apply`/`deploy` likely must run from an environment that has the token and network path.
- `wrangler pages deploy` is idempotent (each run publishes a new deployment); the project only needs creating once (Step 1).
