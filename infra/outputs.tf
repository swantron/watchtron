output "external_ip" {
  description = "Static external IP — point the hostname's DNS A record here"
  value       = google_compute_address.watchtron.address
}

output "dashboard_url" {
  description = "Fleet dashboard URL (after DNS + TLS settle)"
  value       = "https://${var.hostname}/"
}

output "healthz_url" {
  description = "Liveness endpoint"
  value       = "https://${var.hostname}/healthz"
}

output "ssh_command" {
  description = "SSH into the control-plane instance"
  value       = "gcloud compute ssh ${google_compute_instance.watchtron.name} --zone ${var.zone} --project ${var.project_id}"
}

output "startup_logs_command" {
  description = "Tail boot-time provisioning logs on the instance"
  value       = "gcloud compute ssh ${google_compute_instance.watchtron.name} --zone ${var.zone} --project ${var.project_id} -- 'sudo tail -f /var/log/watchtron-startup.log'"
}
