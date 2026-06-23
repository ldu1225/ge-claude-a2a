terraform {
  required_version = ">= 1.5"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 5.0"
    }
  }

  # Remote state bucket — pass at init time so the bucket name is not
  # tied to a single GCP project:
  #   terraform init -backend-config="bucket=YOUR_TF_STATE_BUCKET"
  backend "gcs" {
    prefix = "ge-claude-a2a"
  }
}

provider "google" {
  project = var.project_id
  region  = var.workstation_region
}

provider "google-beta" {
  project = var.project_id
  region  = var.workstation_region
}

# -------------------------------------------------------------------
# Service Account
# -------------------------------------------------------------------

resource "google_service_account" "a2a_agent" {
  account_id   = "a2a-agent"
  display_name = "A2A Agent Service Account"
  description  = "Service account for A2A agent workstations and Cloud Run router"
}

resource "google_project_iam_member" "vertex_ai_user" {
  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.a2a_agent.email}"
}

resource "google_project_iam_member" "workstation_op_viewer" {
  project = var.project_id
  role    = "roles/workstations.operationViewer"
  member  = "serviceAccount:${google_service_account.a2a_agent.email}"
}

# NOTE: roles/workstations.user is granted at the individual workstation
# level (or via the workstation config policy) by the runtime when each
# workstation is created. workstations.admin already covers what we need
# at the management plane (create/start/stop/generateAccessToken/list).

# -------------------------------------------------------------------
# Artifact Registry
# -------------------------------------------------------------------

resource "google_artifact_registry_repository" "images" {
  location      = var.workstation_region
  repository_id = "a2a-agent-images"
  format        = "DOCKER"
  description   = "Container images for A2A agent workstations and router"
}

# -------------------------------------------------------------------
# Networking (dedicated subnet for workstations)
# -------------------------------------------------------------------

resource "google_compute_subnetwork" "workstations" {
  name                     = var.subnetwork
  ip_cidr_range            = var.subnetwork_cidr
  region                   = var.workstation_region
  network                  = "projects/${var.project_id}/global/networks/${var.network}"
  private_ip_google_access = true
  description              = "Subnet for Cloud Workstations running A2A agents"
}

resource "google_compute_router" "router" {
  count   = var.create_nat ? 1 : 0
  name    = "a2a-ws-router"
  region  = var.workstation_region
  network = "projects/${var.project_id}/global/networks/${var.network}"
}

resource "google_compute_router_nat" "nat" {
  count                              = var.create_nat ? 1 : 0
  name                               = "a2a-ws-nat"
  router                             = google_compute_router.router[0].name
  region                             = var.workstation_region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "LIST_OF_SUBNETWORKS"
  subnetwork {
    name                    = google_compute_subnetwork.workstations.id
    source_ip_ranges_to_nat = ["ALL_IP_RANGES"]
  }
}


# -------------------------------------------------------------------
# Cloud Workstations
# -------------------------------------------------------------------

resource "google_workstations_workstation_cluster" "cluster" {
  provider               = google-beta
  workstation_cluster_id = "ai-agents-cluster"
  network                = "projects/${var.project_id}/global/networks/${var.network}"
  subnetwork             = google_compute_subnetwork.workstations.id
  location               = var.workstation_region

  labels = {
    purpose = "a2a-agents"
  }
}

resource "google_workstations_workstation_config" "config" {
  provider               = google-beta
  workstation_config_id  = "a2a-agent-config"
  workstation_cluster_id = google_workstations_workstation_cluster.cluster.workstation_cluster_id
  location               = var.workstation_region

  # Aggressive cost control: stop workstation after short inactivity period
  # idle_timeout: triggered when no SSH/HTTP activity is detected (default 10 min)
  # running_timeout: hard cap on session duration regardless of activity (default 2 h)
  # Estimated cost (e2-standard-4): ~$0.30/hour active, $0/hour stopped (PD only ~$0.10/GB/month)
  idle_timeout    = "${var.workstation_idle_timeout_seconds}s"
  running_timeout = "${var.workstation_running_timeout_seconds}s"

  host {
    gce_instance {
      machine_type    = var.workstation_machine_type
      service_account = google_service_account.a2a_agent.email
      # Without explicit scopes the SA token bound to the VM has no scope
      # at all, which makes Artifact Registry image pulls fail with 403
      # even when the SA has roles/artifactregistry.reader. Use the
      # canonical 'cloud-platform' scope so the SA's IAM roles take effect.
      service_account_scopes = [
        "https://www.googleapis.com/auth/cloud-platform",
      ]
      boot_disk_size_gb = 50
      # Required by the org policy `constraints/compute.requireShieldedVm`.
      shielded_instance_config {
        enable_secure_boot          = true
        enable_vtpm                 = true
        enable_integrity_monitoring = true
      }
      # Required by `constraints/compute.vmExternalIpAccess`. Workstations
      # without public IPs need a Cloud NAT in the configured VPC so they
      # can still reach the internet (Vertex AI, Artifact Registry, etc.).
      disable_public_ip_addresses = true
    }
  }

  container {
    # Image is built and pushed out-of-band by workstation-image/build.sh.
    # Use a stable Cloud Workstations base image as placeholder so the
    # config can be created before our custom image exists.
    image = var.workstation_image == "" ? "us-central1-docker.pkg.dev/cloud-workstations-images/predefined/code-oss:latest" : var.workstation_image

    env = {
      CLAUDE_CODE_USE_VERTEX = "1"
      # PROJECT_ID is read by the a2a-router code (workstation-client.ts /
      # executor.ts). Set it on the workstation as well as the Cloud Run
      # service so the same image works in either deployment target.
      PROJECT_ID                  = var.project_id
      ANTHROPIC_VERTEX_PROJECT_ID = var.project_id
      # 'global' lets Vertex AI route the request to the lowest-latency
      # regional backend, and — importantly — quotas are tracked at the
      # global pool, which is much larger than e.g. us-east5's per-model
      # token-per-minute limit. Override per workspace in
      # ~/.claude/settings.json if a specific region is needed.
      CLOUD_ML_REGION           = "global"
      GOOGLE_GENAI_USE_VERTEXAI = "true"
      GOOGLE_CLOUD_PROJECT      = var.project_id
      GOOGLE_CLOUD_LOCATION     = "global"
    }
  }

  # Mount /home as a Persistent Disk so workspace files, Claude SDK
  # transcripts (~/.claude/projects/*.jsonl), the contextId→sessionId
  # map (~/.a2a-sessions), CLAUDE.md, settings.json — everything under
  # /home/user — SURVIVES workstation stops, image refreshes, and even
  # workstation deletion (the PD persists separately).
  #
  # WITHOUT this block the boot disk is recreated on every start and
  # all per-user state is wiped. That's why 'claude --resume' showed
  # 'No conversations found' even though the SDK had been writing
  # transcripts on the previous run.
  persistent_directories {
    mount_path = "/home"
    gce_pd {
      size_gb        = 50
      fs_type        = "ext4"
      disk_type      = "pd-balanced"
      reclaim_policy = "RETAIN"
    }
  }

  labels = {
    purpose = "a2a-agents"
  }

  lifecycle {
    ignore_changes = [container[0].image]
  }
}

# -------------------------------------------------------------------
# Cloud Run - A2A Router
# -------------------------------------------------------------------

resource "google_cloud_run_v2_service" "router" {
  name     = "a2a-router"
  location = var.cloud_run_region

  template {
    service_account = google_service_account.a2a_agent.email

    scaling {
      min_instance_count = 1
      max_instance_count = 10
    }

    containers {
      # Image is managed out-of-band by the deploy.sh script (which builds and
      # pushes the latest tag). Terraform sets a placeholder on first apply
      # to satisfy Cloud Run's image-must-exist requirement, and ignores image
      # changes thereafter so re-applying terraform does not roll back to it.
      image = var.router_image == "" ? "us-docker.pkg.dev/cloudrun/container/hello" : var.router_image

      ports {
        container_port = 8080
      }

      env {
        name  = "PROJECT_ID"
        value = var.project_id
      }
      env {
        name  = "WORKSTATION_REGION"
        value = var.workstation_region
      }
      env {
        name  = "CLUSTER_ID"
        value = google_workstations_workstation_cluster.cluster.workstation_cluster_id
      }
      env {
        name  = "CONFIG_ID"
        value = google_workstations_workstation_config.config.workstation_config_id
      }
      env {
        name  = "BASE_URL"
        value = var.cloud_run_base_url
      }
      env {
        name  = "AGENT_FORWARD_MODE"
        value = var.agent_forward_mode
      }
      env {
        name  = "ANTHROPIC_VERTEX_PROJECT_ID"
        value = var.project_id
      }
      env {
        name  = "CLOUD_ML_REGION"
        value = var.vertex_ai_region
      }

      resources {
        limits = {
          cpu    = "2"
          memory = "2Gi"
        }
      }
    }

    timeout = "900s"
  }

  labels = {
    purpose = "a2a-agents"
  }

  lifecycle {
    # deploy.sh manages the image tag; terraform should not revert it.
    ignore_changes = [template[0].containers[0].image]
  }
}

resource "google_cloud_run_v2_service_iam_member" "public" {
  name     = google_cloud_run_v2_service.router.name
  location = google_cloud_run_v2_service.router.location
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# -------------------------------------------------------------------
# IAM: Cloud Run SA can manage workstations
# -------------------------------------------------------------------

# The workstation VM service account needs to pull the custom image from
# Artifact Registry on every workstation start.
resource "google_project_iam_member" "artifactregistry_reader" {
  project = var.project_id
  role    = "roles/artifactregistry.reader"
  member  = "serviceAccount:${google_service_account.a2a_agent.email}"
}

# When service_account_scopes is set on the workstation host, the workstation
# runtime impersonates the SA and needs serviceAccounts.actAs on it. Grant
# the SA the right to act as itself.
resource "google_service_account_iam_member" "agent_self_actor" {
  service_account_id = google_service_account.a2a_agent.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.a2a_agent.email}"
}

resource "google_project_iam_member" "workstation_admin" {
  project = var.project_id
  role    = "roles/workstations.admin"
  member  = "serviceAccount:${google_service_account.a2a_agent.email}"
}
