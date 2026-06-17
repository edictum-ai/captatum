#!/usr/bin/env sh
# Build and push the smart-fetch image to ECR (ARM64 Fargate target).
# Mirrors personal-memory-gateway/ops/aws/build-and-push-gateway-image.sh.
#
# First-time: create the ECR repository before pushing:
#   aws ecr create-repository --repository-name smart-fetch \
#     --profile REDACTED_PROFILE --region REDACTED_REGION
set -eu

AWS_PROFILE="${AWS_PROFILE:-REDACTED_PROFILE}"
AWS_REGION="${AWS_REGION:-REDACTED_REGION}"
IMAGE_TAG="${1:-$(git rev-parse --short=12 HEAD)}"
REPOSITORY_URL="${REPOSITORY_URL:-REDACTED_ACCOUNT.dkr.ecr.REDACTED_REGION.amazonaws.com/smart-fetch}"

aws ecr get-login-password \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION" \
  | docker login \
    --username AWS \
    --password-stdin "${REPOSITORY_URL%/*}"

docker buildx build \
  --platform linux/arm64 \
  --tag "$REPOSITORY_URL:$IMAGE_TAG" \
  --push \
  .

printf '%s\n' "$IMAGE_TAG"
