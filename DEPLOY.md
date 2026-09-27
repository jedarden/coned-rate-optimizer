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

## Notes / caveats

- The Cloudflare Terraform is applied **manually** (standalone state), not by ArgoCD — ArgoCD only syncs `k8s/`. So Step 1's `terraform apply` is a manual run wherever the token + network + tfstate live.
- This session may lack Tailscale/OpenBao/Cloudflare reachability, so the actual `apply`/`deploy` likely must run from an environment that has the token and network path.
- `wrangler pages deploy` is idempotent (each run publishes a new deployment); the project only needs creating once (Step 1).
