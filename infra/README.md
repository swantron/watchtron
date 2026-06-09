# watchtron infra (Terraform)

Infrastructure-as-code for the watchtron control plane: a free-tier GCE
`e2-micro` that runs the OTLP receiver + verify API + dashboard behind Caddy
(auto-HTTPS). Mirrors the `buildkite-gcp-agent` module conventions (GCS backend,
`google-github-actions/auth`, plan-on-PR / apply-on-main).

## What it manages

- `google_compute_address.watchtron` — static external IP (DNS A record target; survives instance replacement).
- `google_compute_instance.watchtron` — `e2-micro` Debian 12; provisions Node 24 + Caddy + the service via `startup.sh.tftpl`.
- `google_compute_firewall.web` — ingress 80/443 (Node's `:4318` stays loopback-only).
- `google_compute_firewall.ssh` — optional; only created when `ssh_source_ranges` is non-empty.

`startup.sh.tftpl` is the source of truth for provisioning. Editing it changes
the rendered script hash, which (via `replace_triggered_by`) replaces the
instance on the next apply — re-provisioning cleanly. The static IP means DNS
keeps pointing at the right place across replacements.

## Prerequisites (one-time)

1. **GCP service-account key** stored as the `GOOGLE_CREDENTIALS` repo secret
   (same SA pattern as `buildkite-gcp-agent`). The SA needs, in project
   `chomptron`:
   - `roles/compute.admin`
   - `roles/iam.serviceAccountUser` (to attach the default compute SA to the VM)

   …and on the Terraform state bucket's project (`buildkite-infra-490603`):
   - `roles/storage.objectAdmin` on `gs://buildkite-infra-490603-tfstate`

2. **`WATCHTRON_TOKEN` repo secret** — already set; reused as `TF_VAR_watchtron_token`.
3. DNS A record `watch.swantron.com` → the static IP (see adoption below).

## Local usage

```bash
cd infra
cp terraform.tfvars.example terraform.tfvars   # fill in watchtron_token
terraform init
terraform plan
terraform apply
```

## Adopting the existing (manually-created) control plane

The first control plane was stood up imperatively with `gcloud` (see
`../control-plane/deploy/`). The static IP was reserved as `watchtron-ip`
(promoted from the instance's in-use ephemeral IP):

```bash
gcloud compute addresses create watchtron-ip \
  --addresses 34.72.83.176 --region us-central1 --project chomptron
```

Adoption then happens **in CI, not locally** — the `terraform.yml` workflow has
an idempotent "Adopt pre-existing resources" step that runs on `main`:

```
terraform state show <addr> >/dev/null 2>&1 || terraform import <addr> <id>
```

So the **first push** of `infra/**` to `main` imports the existing IP, instance,
and firewall into the GCS state before `apply`, then converges them. The
`state show` guard makes it a no-op on every subsequent run, and the step is
safe to delete once the control plane has applied cleanly once.

Expect the first apply to make **in-place** changes (add `labels` + the
`startup-script` metadata). If it instead **replaces** the instance (from the
startup-script hash trigger), that's still safe: the static IP is retained, so
`watch.swantron.com` keeps resolving and Caddy re-issues the cert on boot.

> PR plans before that first apply will show "3 to add" because imports only run
> on `main`. That's expected; it resolves after the first apply.

The manual artifacts in `../control-plane/deploy/` (`provision.sh`,
`watchtron.service`, `Caddyfile`) remain as documentation/fallback, but the VM's
lifecycle is owned by Terraform + CI.

### Local import (optional alternative)

If you'd rather adopt from your machine instead of CI, authenticate ADC
(`gcloud auth application-default login`, consenting to the Cloud Platform
scope) and run the same three `terraform import` commands by hand, then
`terraform plan` / `apply`.

## CI

- `.github/workflows/terraform.yml` — `plan` on PRs (posted as a comment),
  `apply` on merge to `main`. Triggers only on `infra/**` changes.
- `.github/workflows/terraform-destroy.yml` — manual `workflow_dispatch`,
  requires typing `destroy` to confirm.

## Free-tier notes

- `e2-micro` is always-free only in `us-central1`, `us-west1`, `us-east1`.
- One always-free `e2-micro` per billing account per month; a second instance
  starts incurring charges.
- A static IP is free **while attached to a running instance** (a reserved-but-
  unused static IP is billed), so don't stop the VM long-term without releasing it.
