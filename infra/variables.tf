variable "project_id" {
  description = "GCP project ID that hosts the watchtron control-plane VM"
  type        = string
}

variable "region" {
  description = "GCP region (must be us-central1, us-west1, or us-east1 for free-tier e2-micro)"
  type        = string
  default     = "us-central1"
}

variable "zone" {
  description = "GCP zone"
  type        = string
  default     = "us-central1-a"
}

variable "instance_name" {
  description = "Name for the control-plane GCE instance"
  type        = string
  default     = "watchtron"
}

variable "machine_type" {
  description = "GCP machine type (e2-micro is free-tier eligible in us-central1/us-west1/us-east1)"
  type        = string
  default     = "e2-micro"
}

variable "hostname" {
  description = "Public hostname Caddy terminates TLS for (point a DNS A record at the instance IP)"
  type        = string
  default     = "watch.swantron.com"
}

variable "repo_url" {
  description = "Git URL the VM clones to run the control plane"
  type        = string
  default     = "https://github.com/swantron/watchtron"
}

variable "watchtron_token" {
  description = "Bearer token the control plane requires on /v1/traces and /verify (openssl rand -hex 32)"
  type        = string
  sensitive   = true
}

variable "ssh_source_ranges" {
  description = "CIDR ranges allowed to SSH (port 22). Set to [] to disable inbound SSH (use gcloud/IAP instead)."
  type        = list(string)
  default     = []
}
