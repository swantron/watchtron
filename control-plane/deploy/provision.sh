#!/usr/bin/env bash
# watchtron control-plane provisioning for a Debian 12 GCE e2-micro.
# Idempotent: safe to re-run. Expects WT_TOKEN in the environment.
set -euo pipefail

: "${WT_TOKEN:?WT_TOKEN must be set}"

echo "==> [1/7] swapfile (insurance for 1GB RAM)"
if ! sudo swapon --show | grep -q /swapfile; then
  sudo fallocate -l 1G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
fi

echo "==> [2/7] base packages + Node 24"
sudo apt-get update -y
sudo apt-get install -y curl git debian-keyring debian-archive-keyring apt-transport-https
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node --version

echo "==> [3/7] Caddy"
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | sudo gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -y
  sudo apt-get install -y caddy
fi

echo "==> [4/7] watchtron user + repo clone"
sudo useradd --system --home-dir /opt/watchtron --shell /usr/sbin/nologin watchtron 2>/dev/null || true
if [ ! -d /opt/watchtron/.git ]; then
  sudo rm -rf /opt/watchtron
  sudo git clone --depth 1 https://github.com/swantron/watchtron /opt/watchtron
else
  sudo git -C /opt/watchtron pull --ff-only
fi
sudo chown -R watchtron:watchtron /opt/watchtron

echo "==> [5/7] install runtime deps (control-plane + registry only)"
sudo -u watchtron env HOME=/opt/watchtron npm install --omit=dev \
  --prefix /opt/watchtron \
  -w control-plane -w packages/registry --include-workspace-root

echo "==> [6/7] systemd unit (with token)"
sudo sed "s|REPLACE_ME|${WT_TOKEN}|" /opt/watchtron/control-plane/deploy/watchtron.service \
  | sudo tee /etc/systemd/system/watchtron.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now watchtron
sleep 2
sudo systemctl restart watchtron

echo "==> [7/7] Caddy reverse proxy (auto-HTTPS for watch.swantron.com)"
sudo cp /opt/watchtron/control-plane/deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy || sudo systemctl restart caddy

echo "==> health check (loopback)"
sleep 2
curl -fsS http://127.0.0.1:4318/healthz && echo
echo "==> provisioning complete"
