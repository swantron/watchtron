terraform {
  required_version = ">= 1.5"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
  zone    = var.zone
}

# Reserve a static external IP so the instance can be replaced (e.g. on a
# startup-script change) without the DNS A record going stale.
resource "google_compute_address" "watchtron" {
  name   = "${var.instance_name}-ip"
  region = var.region
}

# Re-provision (replace the instance) whenever the rendered startup script
# changes, so edits to startup.sh.tftpl actually take effect on boot.
resource "terraform_data" "startup_hash" {
  input = sha256(templatefile("${path.module}/startup.sh.tftpl", {
    watchtron_token = var.watchtron_token
    hostname        = var.hostname
    repo_url        = var.repo_url
  }))
}

# Free tier: one e2-micro in us-central1/us-west1/us-east1, 30GB standard PD.
resource "google_compute_instance" "watchtron" {
  name         = var.instance_name
  machine_type = var.machine_type
  zone         = var.zone

  tags = ["http-server", "https-server"]

  labels = {
    managed-by = "terraform"
    purpose    = "watchtron-control-plane"
  }

  boot_disk {
    initialize_params {
      image = "debian-cloud/debian-12"
      size  = 30
      type  = "pd-standard"
    }
  }

  network_interface {
    network = "default"
    access_config {
      nat_ip = google_compute_address.watchtron.address
    }
  }

  metadata = {
    # OS Login lets the CI service account SSH in (via IAP) using IAM roles
    # instead of project-wide SSH keys — that's how control-plane CD ships code.
    enable-oslogin = "TRUE"

    startup-script = templatefile("${path.module}/startup.sh.tftpl", {
      watchtron_token = var.watchtron_token
      hostname        = var.hostname
      repo_url        = var.repo_url
    })
  }

  allow_stopping_for_update = true

  lifecycle {
    replace_triggered_by = [terraform_data.startup_hash]
  }
}

# Public web: Caddy terminates TLS on 80/443 and proxies to the loopback Node
# process. The Node port (4318) is never exposed externally.
resource "google_compute_firewall" "web" {
  name    = "${var.instance_name}-web"
  network = "default"

  allow {
    protocol = "tcp"
    ports    = ["80", "443"]
  }

  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["http-server", "https-server"]
}

# IAP-tunneled SSH (port 22 from Google's IAP range only). This is what the
# control-plane CD workflow uses to `gcloud compute ssh --tunnel-through-iap`
# and roll out registry/control-plane changes. No public SSH surface.
resource "google_compute_firewall" "iap_ssh" {
  name    = "${var.instance_name}-iap-ssh"
  network = "default"

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }

  # Google Identity-Aware Proxy TCP-forwarding source range.
  source_ranges = ["35.235.240.0/20"]
  target_tags   = ["http-server", "https-server"]
}

# IAM for the CI service account so it can SSH via IAP and `sudo` on the box.
# `ci_service_account` is resolved from the GOOGLE_CREDENTIALS key in CI; when
# unset (e.g. a local plan) these bindings are skipped to avoid spurious diffs.
resource "google_project_iam_member" "ci_iap_tunnel" {
  count   = var.ci_service_account != "" ? 1 : 0
  project = var.project_id
  role    = "roles/iap.tunnelResourceAccessor"
  member  = "serviceAccount:${var.ci_service_account}"
}

resource "google_project_iam_member" "ci_os_admin_login" {
  count   = var.ci_service_account != "" ? 1 : 0
  project = var.project_id
  role    = "roles/compute.osAdminLogin"
  member  = "serviceAccount:${var.ci_service_account}"
}

# Optional public SSH (off by default; prefer `gcloud compute ssh` / IAP).
resource "google_compute_firewall" "ssh" {
  count   = length(var.ssh_source_ranges) > 0 ? 1 : 0
  name    = "${var.instance_name}-ssh"
  network = "default"

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }

  source_ranges = var.ssh_source_ranges
  target_tags   = ["http-server", "https-server"]
}
