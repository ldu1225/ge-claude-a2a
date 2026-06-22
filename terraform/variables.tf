variable "project_id" {
  description = "GCP project ID. Pass via -var or terraform.tfvars."
  type        = string
}

variable "workstation_region" {
  description = "Region for Cloud Workstations cluster"
  type        = string
  default     = "asia-northeast3"
}

variable "cloud_run_region" {
  description = "Region for Cloud Run router deployment"
  type        = string
  default     = "us-central1"
}

variable "vertex_ai_region" {
  description = "Region for Vertex AI (Claude Code)"
  type        = string
  default     = "us-east5"
}

variable "network" {
  description = "VPC network name for the workstation cluster. Every GCP project ships with a 'default' VPC; override if you use a custom one."
  type        = string
  default     = "default"
}

variable "subnetwork" {
  description = "Subnetwork name for the workstation cluster (created by this module)."
  type        = string
  default     = "a2a-ws-subnet"
}

variable "subnetwork_cidr" {
  description = "CIDR for the workstation subnet (must not overlap with existing subnets in the VPC)."
  type        = string
  default     = "10.20.0.0/24"
}

variable "workstation_machine_type" {
  description = "Machine type for workstation instances"
  type        = string
  default     = "e2-standard-4"
}

variable "workstation_idle_timeout_seconds" {
  description = "Idle timeout (no SSH/HTTP activity) in seconds before workstation is stopped. Aggressive default to control cost."
  type        = number
  default     = 600 # 10 minutes
}

variable "workstation_running_timeout_seconds" {
  description = "Maximum running time in seconds before workstation is force-stopped (regardless of activity)."
  type        = number
  default     = 7200 # 2 hours
}

variable "router_image" {
  description = "Cloud Run image URI (managed by deploy.sh; leave empty for placeholder)."
  type        = string
  default     = ""
}

variable "workstation_image" {
  description = "Custom Cloud Workstations image URI (managed by build.sh; leave empty for the upstream code-oss base)."
  type        = string
  default     = ""
}

variable "cloud_run_base_url" {
  description = "Public Cloud Run URL the A2A agent advertises in its agent card."
  type        = string
  default     = "" # auto-computed by deploy.sh; set via -var if pinning
}

variable "agent_forward_mode" {
  description = "Where Claude turns run: 'local' (in Cloud Run) or 'workstation' (per-user Cloud Workstation)."
  type        = string
  default     = "workstation"
}
