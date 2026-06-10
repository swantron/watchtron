# watchtron — system reference

The complete operator's guide to the watchtron fleet-observability platform:
architecture, every repo it touches, the GCP infrastructure, all CI/CD flows,
the secrets matrix, the one-time bootstrap, day-2 operations, and a
troubleshooting catalog of every failure mode hit so far.

`README.md` sells the concept. **This file runs the system.**

---

## 1. What it is

On every deploy, watchtron drives synthetic golden-signal traffic at the live
service and proves — via OpenTelemetry — that the deploy is actually serving real
requests within its deploy health gate. If the telemetry never lands in the
control plane, the deploy fails.

Three moving parts:

- **Prober** — generates tagged synthetic traffic with `undici`, scores the
  deploy health gate, exports its client spans as OTLP/HTTP JSON.
- **Control plane** — an always-on GCE `e2-micro` that receives OTLP, buffers
  spans in memory, runs `/verify`, and serves the dashboard + status badges.
- **`@swantron/otel-bootstrap`** — a drop-in white-box instrumentation package
  for the Express services we own, so the prober's client span correlates with a
  real server span (proves traffic reached the origin, not just an edge cache).

---

## 2. Architecture & data flow

```
 deploy (consumer repo CI)
        │
        ▼
 reusable verify.yml ── prober (undici) ──HTTP──▶ live service URL
        │                   │                         │ (white-box only)
        │                   │ OTLP client spans        ▼ server spans (OTLP)
        │                   ▼                         /v1/traces
        └─ poll /verify?runId ───────▶  CONTROL PLANE (watch.swantron.com)
                                         ├─ OTLP receiver  (:4318, loopback)
                                         ├─ ephemeral ring buffer (in-memory)
                                         ├─ /verify   (health gate + trace correlation)
                                         ├─ /badge/:service, /api/status
                                         └─ dashboard at /
```

**Correlation.** The prober mints a `runId` and a W3C `traceparent`, sends both
(`x-synthetic-run-id` header + `traceparent`) with every request. White-box
origins stamp `synthetic.run_id` + `watchtron.role=server` onto their active span
via the bootstrap middleware. `/verify?runId=…` queries the buffer by `runId`
only, so it can match the prober's client trace against the origin's server span.

**Verdict.** A run passes when, for that `runId`:

- availability ≥ `healthGate.availabilityPct`
- p95 latency ≤ `healthGate.p95LatencyMs`
- every `criticalRoutes` entry was probed
- (white-box) a correlated server span landed → `endToEnd: true`

This gate is scored over a small synthetic burst (`requests` × `criticalRoutes`)
fired right after deploy — a post-deploy **health gate**, deliberately not a
windowed production SLO.

**Reachability vs. failure.** If the control plane itself can't be reached (so
telemetry can neither be exported nor verified), that's a watchtron outage, not a
service failure — the prober warns and exits 0, so the deploy is **not** blocked.
Pass `strict: true` to `verify.yml` (or `WATCHTRON_STRICT=true`) to block on
outage instead. A reachable control plane returning a failing verdict still
blocks as normal.

The span buffer is **ephemeral by design** — a control-plane restart (deploy,
reboot) clears it, which is fine because verification is per-run and short-lived.
The **last verdict per service is persisted to disk**
(`control-plane/state/verdicts.json`, gitignored, override via
`WATCHTRON_STATE_FILE`), so badges and the dashboard survive restarts instead of
resetting to "unknown" on every `deploy-control-plane` run. `schedule.yml` still
re-probes the whole fleet every 30 min to catch drift and silent outages.

---

## 3. The fleet (registry)

Single source of truth: [`registry/services.yaml`](../registry/services.yaml).
The prober, control plane, and verify workflow all read it.

| Service    | URL            | Host                      | Box       | Mode        | p95 gate |
| ---------- | -------------- | ------------------------- | --------- | ----------- | -------- |
| tronswan   | tronswan.com   | DigitalOcean App Platform | white-box | post-deploy | 1500 ms  |
| chomptron  | chomptron.com  | GCP Cloud Run             | white-box | post-deploy | 2500 ms  |
| swantron   | swantron.com   | GitHub Pages (Hugo)       | black-box | post-deploy | 1500 ms  |
| mt         | mt.services    | Firebase Hosting          | black-box | post-deploy | 1200 ms  |
| wrenchtron | wrenchtron.com | Firebase Hosting          | black-box | post-deploy | 1800 ms  |
| jswan.dev  | jswan.dev      | self-hosted atproto PDS   | black-box | schedule    | 2000 ms  |

- **white-box** = origin emits server spans (`@swantron/otel-bootstrap`); verify
  also asserts end-to-end correlation.
- **black-box** = prober client spans only (static sites / unmodifiable upstream).
- **post-deploy** = gated by the repo's CI after each deploy.
- **schedule** = no deploy pipeline, so probed on a cron from watchtron itself.

Per-service tuning also lives here (the registry is the single source of truth):
an optional `probe` block (`requestsPerRoute`, `timeoutMs`, `waitMs`) and a
`failClosed` flag. The prober resolves each as **explicit CLI flag > registry
value > global default**, so e.g. chomptron's Cloud-Run-friendly `requests: 10 /
wait: 25s` lives in `services.yaml`, not in chomptron's workflow.

---

## 4. Repository map

| Repo                | Role in the system                                                         | watchtron workflow it uses |
| ------------------- | -------------------------------------------------------------------------- | -------------------------- |
| **watchtron** (hub) | control plane, prober, registry, otel-bootstrap, infra, reusable workflows | —                          |
| tronswan            | white-box (Express ESM) on DO; post-deploy verify + DO env sync            | `verify.yml`               |
| chomptron           | white-box (Express CJS) on Cloud Run; post-deploy verify                   | `verify.yml`               |
| swantron            | black-box (Hugo on Pages); post-deploy verify                              | `verify.yml`               |
| mt                  | black-box (Firebase); post-deploy verify                                   | `verify.yml`               |
| wrenchtron          | black-box (Firebase/Next PWA); post-deploy verify                          | `verify.yml`               |
| jswan.dev           | black-box upstream PDS — **no repo changes**; probed on cron               | `schedule.yml`             |

`@swantron/otel-bootstrap` is published to public npm so tronswan + chomptron
install it like any dependency.

---

## 5. GCP infrastructure

All managed by Terraform in [`infra/`](../infra) (GCS-backed state). Project:
**`chomptron`** (project number `774854504205`).

| Resource                         | Identity / value                                           |
| -------------------------------- | ---------------------------------------------------------- |
| Compute instance                 | `watchtron`, `e2-micro`, `us-central1-a`, Debian 12, 30 GB |
| Static external IP               | `watchtron-ip`                                             |
| Firewall: web                    | `watchtron-web` — tcp 80/443 from `0.0.0.0/0`              |
| Firewall: IAP SSH                | `watchtron-iap-ssh` — tcp 22 from `35.235.240.0/20` (IAP)  |
| Public hostname                  | `watch.swantron.com` (Caddy auto-HTTPS → `127.0.0.1:4318`) |
| systemd unit / app dir / user    | `watchtron.service` / `/opt/watchtron` / `watchtron`       |
| CI / Terraform service account   | `watchtron-tf@chomptron.iam.gserviceaccount.com`           |
| Terraform state                  | `gs://buildkite-infra-490603-tfstate` prefix `watchtron`   |
| Secret Manager (Cloud Run token) | `watchtron-token` (chomptron)                              |
| Enabled APIs                     | compute, oslogin, iap, cloudresourcemanager                |

The VM is provisioned by [`infra/startup.sh.tftpl`](../infra/startup.sh.tftpl):
swapfile → Node 24 → Caddy → clone repo to `/opt/watchtron` → install runtime
deps → systemd unit (token injected) → Caddy reverse proxy. OS Login is enabled
so the CI SA can SSH in over IAP for control-plane CD.

Only Caddy (80/443) is exposed publicly; the Node process is loopback-only.

---

## 6. CI/CD workflows

### watchtron (hub)

| Workflow                   | Trigger                                                                 | Does                                                                                                                                                                                        |
| -------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ci.yml`                   | push/PR `main`                                                          | lint + format check + test; on `main` push, publish `@swantron/otel-bootstrap` (OIDC, idempotent)                                                                                           |
| `terraform.yml`            | push/PR on `infra/**`                                                   | PR → plan (commented); `main` → apply. Resolves `TF_VAR_ci_service_account` from the SA key                                                                                                 |
| `deploy-control-plane.yml` | push `main` on `registry/**`,`control-plane/**`,`packages/**`; dispatch | SSH via IAP, `git reset --hard origin/main`, reinstall deps, restart service, hit `/healthz`                                                                                                |
| `schedule.yml`             | cron `*/30 * * * *`; dispatch                                           | probe + verify the **whole fleet** every 30 min — catches drift and silent outages between deploys, and covers `schedule`-only services (jswan.dev)                                         |
| `verify.yml`               | `workflow_call` (reusable)                                              | run the prober with `--verify` against a service; no-ops if `WATCHTRON_OTLP_ENDPOINT` unset, and **fails open** (warns, exit 0) when the control plane is unreachable unless `strict: true` |
| `terraform-destroy.yml`    | manual dispatch                                                         | `terraform destroy` of the control-plane infra                                                                                                                                              |

### Consumer repos

| Repo       | Workflow            | Post-deploy gate                                                                                   |
| ---------- | ------------------- | -------------------------------------------------------------------------------------------------- |
| tronswan   | `cicd.yml`          | build/test → DO deploy poll + Playwright → `watchtron-verify` (service: tronswan)                  |
| tronswan   | `watchtron-env.yml` | manual: patch the DO app spec with `WATCHTRON_*` runtime env vars                                  |
| chomptron  | `ci.yml`            | Cloud Build image → Cloud Run deploy → `verify` (service: chomptron; probe tuning in the registry) |
| swantron   | `deploy.yml`        | Hugo build → Pages deploy → `watchtron-verify` (service: swantron)                                 |
| mt         | `deploy.yml`        | Firebase deploy → `watchtron-verify` (service: mt)                                                 |
| wrenchtron | `deploy.yml`        | test → Firebase deploy → `watchtron-verify` (service: wrenchtron)                                  |

The reusable `verify.yml` **skips gracefully** (exit 0) when the OTLP endpoint
secret is absent, so wiring it into a repo before its secrets exist is safe. It
likewise **fails open** when the control plane is unreachable — a watchtron
outage is not treated as a service failure, so it won't block your deploy. Pass
`strict: true` (or set `WATCHTRON_STRICT=true`) to block on outage instead. A
reachable control plane returning a failing verdict still fails the gate.

---

## 7. Secrets & runtime env

### GitHub Actions secrets

| Secret                                             | Where set                          | Used for                                            |
| -------------------------------------------------- | ---------------------------------- | --------------------------------------------------- |
| `WATCHTRON_OTLP_ENDPOINT`                          | every consumer repo + watchtron    | `https://watch.swantron.com` — prober export target |
| `WATCHTRON_TOKEN`                                  | every consumer repo + watchtron    | bearer token for `/v1/traces` and `/verify`         |
| `GOOGLE_CREDENTIALS`                               | watchtron                          | `watchtron-tf` SA key for Terraform + IAP SSH       |
| `DIGITALOCEAN_ACCESS_TOKEN`                        | tronswan                           | poll DO deploys + patch app spec env                |
| `FIREBASE_SERVICE_ACCOUNT` / `FIREBASE_PROJECT_ID` | mt, wrenchtron                     | Firebase Hosting deploys                            |
| (none — OIDC)                                      | watchtron `publish-otel-bootstrap` | npm Trusted Publishing, no `NPM_TOKEN`              |

### White-box runtime env (the actual app processes)

| Service   | Set where                                 | Vars                                                                                |
| --------- | ----------------------------------------- | ----------------------------------------------------------------------------------- |
| tronswan  | DO App Platform (via `watchtron-env.yml`) | `WATCHTRON_OTLP_ENDPOINT`, `WATCHTRON_TOKEN`, `WATCHTRON_SERVICE_NAME=tronswan-web` |
| chomptron | Cloud Run (via `deploy.sh`)               | same three; token from Secret Manager `watchtron-token`, name `chomptron-web`       |

`WATCHTRON_SERVICE_NAME` must equal the registry's `expectedServiceName`, or
end-to-end correlation won't match.

### Control-plane process env

| Var                    | Default                             | Purpose                                                                                                                                         |
| ---------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `WATCHTRON_PORT`       | `4318`                              | loopback port the Node process listens on (Caddy proxies to it)                                                                                 |
| `WATCHTRON_TOKEN`      | _(unset = open; dev only)_          | bearer token required on `/v1/traces` and `/verify`                                                                                             |
| `WATCHTRON_STATE_FILE` | `control-plane/state/verdicts.json` | where the last verdict per service is persisted so badges/dashboard survive restarts (gitignored; survives `git reset --hard`, not `git clean`) |

### Prober / verify env

| Var                | Default | Purpose                                                                                           |
| ------------------ | ------- | ------------------------------------------------------------------------------------------------- |
| `WATCHTRON_STRICT` | `false` | when `true`, an unreachable control plane fails the deploy instead of failing open with a warning |

---

## 8. One-time bootstrap (privileged; done by a project owner)

These can't be self-served by the CI SA — they grant the CI SA its powers.

1. **Enable APIs** (or let Terraform do it once the SA has `serviceUsageAdmin`):
   `compute`, `oslogin`, `iap`, `cloudresourcemanager`.
2. **Create the `watchtron-tf` SA + JSON key** → store as the `GOOGLE_CREDENTIALS`
   secret in watchtron. Grant it:
   - `roles/compute.admin` (instances + firewalls)
   - `roles/storage.objectAdmin` on the TF state bucket
   - `roles/serviceusage.serviceUsageAdmin` (enable APIs)
   - `roles/resourcemanager.projectIamAdmin` (manage the IAP/osLogin bindings)
3. **Create the TF state bucket** (`buildkite-infra-490603-tfstate`) if new.
4. **Generate the token**: `openssl rand -hex 32`. Put it in:
   - every repo's `WATCHTRON_TOKEN` secret, and
   - Secret Manager `watchtron-token` (chomptron, for Cloud Run).
5. **`terraform apply`** (via `terraform.yml`) → VM, IP, firewalls, IAP IAM.
6. **DNS**: point `watch.swantron.com` A record at the static IP (Squarespace).
7. **Per consumer repo**: set `WATCHTRON_OTLP_ENDPOINT` + `WATCHTRON_TOKEN`.
8. **White-box runtime env**: run tronswan `watchtron-env.yml`; chomptron is in
   `deploy.sh`.
9. **npm**: publish `@swantron/otel-bootstrap@0.1.0` once manually, then configure
   the package's Trusted Publisher (GitHub Actions → `swantron/watchtron`,
   `ci.yml`). All later publishes are automatic + tokenless.

---

## 9. Day-2 operations

**Add a new service**

1. Add an entry to `registry/services.yaml` (commit → `deploy-control-plane.yml`
   ships it to the VM automatically).
2. Add the `watchtron-verify` job to that repo's deploy workflow (copy from any
   consumer repo).
3. Set `WATCHTRON_OTLP_ENDPOINT` + `WATCHTRON_TOKEN` secrets in the repo.
4. (White-box only) install `@swantron/otel-bootstrap`, register it, add the
   middleware, set the three runtime env vars.
5. Add a status badge to the repo README.

**Change a health gate or registry field** — edit `registry/services.yaml`, push
to `main`. `deploy-control-plane.yml` pulls + restarts the control plane.

**Ship control-plane code** — push to `main`; the same workflow rolls it out.
Manual: `gh workflow run deploy-control-plane.yml -R swantron/watchtron`.

**Rotate the token** — regenerate, update Secret Manager + every repo secret +
the `WATCHTRON_TOKEN` used by Terraform, then `terraform apply` (re-injects into
the systemd unit) and redeploy white-box services.

**Tear down** — run `terraform-destroy.yml` (manual dispatch).

---

## 10. Troubleshooting catalog

| Symptom                                                       | Cause                                                                                 | Fix                                                                                                                                              |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Prober CI: control plane unreachable / `ECONNREFUSED …:4318`  | `WATCHTRON_OTLP_ENDPOINT` unset, or control plane down                                | deploy is **not** blocked (fail-open warning); fix the secret or the VM. Use `strict: true` / `WATCHTRON_STRICT=true` to block on outage instead |
| TF: `Error 403 … cloudresourcemanager … SERVICE_DISABLED`     | Cloud Resource Manager API off                                                        | enable the API (or grant SA `serviceUsageAdmin` so TF enables it)                                                                                |
| TF: `AUTH_PERMISSION_DENIED … Enable Project Service`         | CI SA lacks `serviceusage.services.enable`                                            | grant `roles/serviceusage.serviceUsageAdmin` to `watchtron-tf`                                                                                   |
| TF: `Create IAM Members … setIamPolicy` denied                | CI SA lacks project IAM admin                                                         | grant `roles/resourcemanager.projectIamAdmin` to `watchtron-tf`                                                                                  |
| Control-plane deploy: IAP `4033: 'not authorized'`            | missing `iap.tunnelResourceAccessor` and/or IAP API off                               | apply Terraform (creates the binding + firewall); ensure IAP API enabled                                                                         |
| `endToEnd: false` for chomptron despite instrumentation       | Cloud Run CPU throttling delays the OTel batch flush                                  | increase prober `--wait`/`--requests` (we use 25s/10); or `--no-cpu-throttling`                                                                  |
| Registry/gate change not reflected on the live dashboard      | control plane hadn't pulled the new code                                              | now automatic via `deploy-control-plane.yml`; or dispatch it manually                                                                            |
| Dashboard shows "never verified" for a service                | genuinely never probed (new service, or a fresh VM with no `state/verdicts.json` yet) | trigger a deploy or `gh workflow run schedule.yml`. Verdicts now persist to disk, so a normal restart no longer clears badges                    |
| Local `EADDRINUSE` on control-plane restart                   | a stale node process holds `:4318`                                                    | `pkill -f control-plane/src/server.js` then restart                                                                                              |
| `npm publish` → `E403 … Two-factor authentication … required` | 2FA on the npm account                                                                | use OIDC Trusted Publishing in CI; for the one-time publish use a granular write token                                                           |
| White-box service shows black-box / no `endToEnd`             | runtime env vars not set, or `WATCHTRON_SERVICE_NAME` ≠ registry name                 | set the three env vars; match `expectedServiceName`                                                                                              |

---

## 11. Cost

Designed to run at **$0**: the control plane is a free-tier `e2-micro`
(us-central1) with a 30 GB standard disk; Caddy handles TLS for free; the buffer
is in-memory (no DB); npm and GitHub Actions are free for this usage. The only
non-free pieces (Cloud Run, DO, Firebase, the PDS) are pre-existing service hosts,
not watchtron itself.
