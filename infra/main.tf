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

# Optional SSH (off by default; prefer `gcloud compute ssh` / IAP).
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
