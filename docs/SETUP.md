# End-to-End Setup Guide

This guide walks you through deploying the Gemini Enterprise x Claude Code A2A architecture in your own Google Cloud project.

## Prerequisites

- A GCP project with billing enabled
- `gcloud` CLI authenticated with project Owner/Editor permissions
- Terraform >= 1.5
- Node.js >= 20 (only needed if you want to run / develop the router locally)

Before starting, export your project ID:
```bash
export PROJECT_ID="YOUR_PROJECT_ID_HERE"
gcloud config set project $PROJECT_ID
```

## Step 1: Enable Required APIs

```bash
gcloud services enable \
  workstations.googleapis.com \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  aiplatform.googleapis.com \
  cloudbuild.googleapis.com
```

## Step 2: Provision Infrastructure (Terraform)

The Terraform configuration creates the Service Account, Artifact Registry, Cloud Workstations cluster, and the Cloud Run service.

First, create a GCS bucket for Terraform remote state (one-time, choose any unique name):

```bash
export TF_STATE_BUCKET="${PROJECT_ID}-terraform-state"
gcloud storage buckets create "gs://${TF_STATE_BUCKET}" \
  --project "$PROJECT_ID" --location asia-northeast1 --uniform-bucket-level-access
```

Then initialize and apply Terraform:

```bash
cd terraform

# Initialize the gcs backend with your state bucket
terraform init -backend-config="bucket=${TF_STATE_BUCKET}"

# Apply (project_id is required — no default)
terraform apply -var="project_id=${PROJECT_ID}"
```

The defaults provision into the project's `default` VPC and create a new subnet for the workstation cluster. If you use a custom VPC, override:

```bash
terraform apply \
  -var="project_id=${PROJECT_ID}" \
  -var="network=my-vpc" \
  -var="subnetwork=my-ws-subnet"
```

For repeatable runs, put your variables in `terraform/terraform.tfvars` (gitignored) instead of passing `-var` every time.

**Note the outputs:** You will need the `artifact_registry_repo` and `cloud_run_url` later.

## Step 3: Build and Push the Workstation Custom Image

The custom image installs Node.js, Claude Code CLI, Gemini CLI, and the A2A routing server (which starts on boot). The build runs in Cloud Build, so you don't need a local Docker daemon.

```bash
cd ../workstation-image

# Build and push the image to your Artifact Registry (uses Cloud Build).
PROJECT_ID=$PROJECT_ID ./build.sh
```

When the build finishes, it prints the image URI. Re-apply Terraform to point the workstation config at this image:

```bash
cd ../terraform
WS_IMAGE="asia-northeast1-docker.pkg.dev/${PROJECT_ID}/a2a-agent-images/a2a-workstation:latest"
terraform apply \
  -var="project_id=${PROJECT_ID}" \
  -var="workstation_image=${WS_IMAGE}"
```

## Step 4: Build and Deploy the A2A Router (Cloud Run)

The router handles OAuth validation from Gemini Enterprise and forwards requests to the correct user's Cloud Workstation. Like the workstation image, it builds via Cloud Build.

```bash
cd ../a2a-router

# Build, deploy, and patch BASE_URL on the service.
PROJECT_ID=$PROJECT_ID ./deploy.sh
```

## Step 5: Verify Deployment

Check that the router is serving the A2A agent card correctly:

```bash
ROUTER_URL=$(gcloud run services describe a2a-router \
  --project $PROJECT_ID \
  --region us-central1 \
  --format "value(status.url)")

curl "${ROUTER_URL}/.well-known/agent-card.json" | jq .
```

## Step 6: Register with Gemini Enterprise

1. Go to your Google Workspace Admin Console > **Gemini Enterprise** > **Agent Platform**
2. Add a new Custom Agent using the Agent Card URL:
   `https://[YOUR_ROUTER_URL]/.well-known/agent-card.json`
3. GE will automatically discover the agent name, icon, and capabilities.
4. **OAuth Configuration**: Ensure the OAuth client used by GE has access to request the `email` scope, as the router requires this to map requests to individual workstations.

## Troubleshooting

- **Workstation doesn't start:** Check quota limits for `e2-standard-4` in your selected region.
- **Claude returns Vertex AI errors:** Ensure your project has access to Anthropic models in Vertex AI Model Garden.
- **Logs:** 
  - Cloud Run Router: `gcloud run services logs read a2a-router`
  - Workstation internal logs (SSH in via Console): the Cloud Workstations console "Logs" tab
