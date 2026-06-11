# Control plane — GCE e2-micro bring-up

The control plane runs on a Google Compute Engine `e2-micro` (always-free tier in
`us-central1`, `us-west1`, or `us-east1`). It stays always-on, so the in-memory
span buffer remains warm and we never lose telemetry to a cold start.

## 1. Create the always-free VM

```bash
gcloud compute instances create watchtron \
  --machine-type=e2-micro \
  --zone=us-central1-a \
  --image-family=debian-12 \
  --image-project=debian-cloud \
  --boot-disk-size=30GB \
  --tags=http-server,https-server
```

> The `--tags` must match the firewall rule's `--target-tags` below, or 80/443 stays closed.

Reserve/note its external IP and point a DNS A record at it (e.g. `watch.swantron.com`).

## 2. Open the firewall (HTTP/HTTPS only)

```bash
gcloud compute firewall-rules create watchtron-web \
  --allow=tcp:80,tcp:443 \
  --target-tags=http-server,https-server
```

The Node process listens on loopback `:4318`; only Caddy (80/443) is exposed.

## 3. Provision on the VM

```bash
sudo useradd --system --create-home --home-dir /opt/watchtron watchtron
# install Node 24 (nodesource) + caddy, then:
sudo git clone https://github.com/swantron/watchtron /opt/watchtron
cd /opt/watchtron && sudo -u watchtron npm install --omit=dev --workspaces --include-workspace-root

# token
export TOKEN=$(openssl rand -hex 32)   # store this in each repo's WATCHTRON_TOKEN secret
sudo sed -i "s/REPLACE_ME/$TOKEN/" control-plane/deploy/watchtron.service

sudo cp control-plane/deploy/watchtron.service /etc/systemd/system/
sudo systemctl enable --now watchtron

sudo cp control-plane/deploy/Caddyfile /etc/caddy/Caddyfile   # edit the hostname first
sudo systemctl reload caddy
```

## 4. Wire the fleet

Set these as repo/org secrets in each consumer repo:

- `WATCHTRON_OTLP_ENDPOINT` = `https://watch.swantron.com`
- `WATCHTRON_TOKEN` = the token generated above

White-box services (tronswan, chomptron) also set the same two env vars in their
runtime (DigitalOcean / Cloud Run) plus `WATCHTRON_SERVICE_NAME` matching the
registry's `expectedServiceName`.

## State & persistence

The span buffer is in-memory and ephemeral (a restart clears it, which is fine —
verification is per-run). Two things _are_ persisted under `control-plane/state/`
(in `/opt/watchtron`, gitignored): the **last verdict per service**
(`verdicts.json`) so the dashboard and `/badge` endpoints survive restarts
instead of resetting to grey "unknown", and the **rolling p95 history**
(`baselines.json`) backing regression detection. Both survive the
`git reset --hard` that `deploy-control-plane.yml` runs; only a `git clean -fdx`
or a brand-new VM starts them empty. Override the paths with
`WATCHTRON_STATE_FILE` / `WATCHTRON_BASELINE_FILE`.

## Health

```bash
curl https://watch.swantron.com/healthz
```
