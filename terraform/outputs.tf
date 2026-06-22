output "service_account_email" {
  description = "Email of the A2A agent service account"
  value       = google_service_account.a2a_agent.email
}

output "workstation_cluster_id" {
  description = "ID of the Cloud Workstations cluster"
  value       = google_workstations_workstation_cluster.cluster.workstation_cluster_id
}

output "workstation_config_id" {
  description = "ID of the Cloud Workstations config"
  value       = google_workstations_workstation_config.config.workstation_config_id
}

output "cloud_run_url" {
  description = "URL of the A2A router Cloud Run service"
  value       = google_cloud_run_v2_service.router.uri
}

output "artifact_registry_repo" {
  description = "Artifact Registry repository path"
  value       = "${google_artifact_registry_repository.images.location}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}"
}

output "agent_card_url" {
  description = "URL of the A2A agent card for GE registration"
  value       = "${google_cloud_run_v2_service.router.uri}/.well-known/agent-card.json"
}
