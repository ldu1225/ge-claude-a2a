#!/bin/bash
# Build (via Cloud Build) and deploy the A2A router to Cloud Run.
# Run from the repo root or this directory.
#
# Usage:
#   ./a2a-router/deploy.sh
#   PROJECT_ID=my-proj REGION=us-central1 ./a2a-router/deploy.sh
#   TAG=v1 ./a2a-router/deploy.sh

set -euo pipefail

if [[ -z "${PROJECT_ID:-}" ]]; then
  echo "ERROR: PROJECT_ID is required. Run as: PROJECT_ID=my-proj $0" >&2
  exit 1
fi

REGION="${REGION:-us-central1}"
ARTIFACT_REGION="${ARTIFACT_REGION:-asia-northeast3}"
REPO="${REPO:-a2a-agent-images}"
SERVICE_NAME="${SERVICE_NAME:-a2a-router}"
TAG="${TAG:-latest}"

WORKSTATION_REGION="${WORKSTATION_REGION:-asia-northeast3}"
CLUSTER_ID="${CLUSTER_ID:-ai-agents-cluster}"
CONFIG_ID="${CONFIG_ID:-a2a-agent-config}"

FULL_IMAGE="${ARTIFACT_REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/${SERVICE_NAME}:${TAG}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Building router image via Cloud Build:"
echo "  source: ${SCRIPT_DIR}"
echo "  image:  ${FULL_IMAGE}"

gcloud builds submit "${SCRIPT_DIR}" \
  --project "${PROJECT_ID}" \
  --tag "${FULL_IMAGE}"

echo
echo "Deploying to Cloud Run..."
# Note: --set-env-vars REPLACES the env block, so we have to know the
# Cloud Run URL up front to set BASE_URL. We can't, so we deploy first
# without BASE_URL, then patch it via --update-env-vars below.
gcloud run deploy "${SERVICE_NAME}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --image "${FULL_IMAGE}" \
  --platform managed \
  --allow-unauthenticated \
  --set-env-vars "PROJECT_ID=${PROJECT_ID},WORKSTATION_REGION=${WORKSTATION_REGION},CLUSTER_ID=${CLUSTER_ID},CONFIG_ID=${CONFIG_ID},AGENT_FORWARD_MODE=workstation" \
  --memory 1Gi \
  --cpu 1 \
  --min-instances 1 \
  --max-instances 10 \
  --timeout 300

ROUTER_URL=$(gcloud run services describe "${SERVICE_NAME}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --format "value(status.url)")

echo
echo "Patching BASE_URL=${ROUTER_URL} on the service..."
gcloud run services update "${SERVICE_NAME}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --update-env-vars "BASE_URL=${ROUTER_URL}"

echo
echo "Deployed. Service URL: ${ROUTER_URL}"
echo "Agent card:           ${ROUTER_URL}/.well-known/agent-card.json"
