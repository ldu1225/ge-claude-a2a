#!/bin/bash
# Build and push the custom Cloud Workstations image via Cloud Build.
# Run from the repo root or from this directory.
#
# Usage:
#   ./workstation-image/build.sh                  # build & push :latest
#   TAG=v1 ./workstation-image/build.sh           # custom tag
#   PROJECT_ID=my-proj ./workstation-image/build.sh

set -euo pipefail

if [[ -z "${PROJECT_ID:-}" ]]; then
  echo "ERROR: PROJECT_ID is required. Run as: PROJECT_ID=my-proj $0" >&2
  exit 1
fi

REGION="${REGION:-asia-northeast3}"
REPO="${REPO:-a2a-agent-images}"
IMAGE_NAME="${IMAGE_NAME:-a2a-workstation}"
TAG="${TAG:-latest}"

FULL_IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/${IMAGE_NAME}:${TAG}"

# Resolve project root (parent of this script's dir)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo "Building workstation image via Cloud Build:"
echo "  source: ${ROOT_DIR}"
echo "  image:  ${FULL_IMAGE}"

# Use Cloud Build with the entire repo as context. .gcloudignore controls
# what gets uploaded.
gcloud builds submit "${ROOT_DIR}" \
  --project "${PROJECT_ID}" \
  --config "${SCRIPT_DIR}/cloudbuild.yaml" \
  --substitutions "_IMAGE=${FULL_IMAGE}"

echo "Pushed: ${FULL_IMAGE}"
echo
echo "Next: update the workstation config to use this image:"
cat <<EOF
  cd terraform
  terraform apply -var workstation_image=${FULL_IMAGE}
EOF
