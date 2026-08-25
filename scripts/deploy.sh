#!/usr/bin/env bash
# Deploys infra/template.yaml. No SAM CLI — CloudFormation handles the SAM
# transform server-side via CAPABILITY_AUTO_EXPAND.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

ENV_FILE="ops/deploy.env"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "error: $ENV_FILE not found." >&2
  echo "Copy ops.example/deploy.env.example to $ENV_FILE and fill in your values." >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$ENV_FILE"

for var in AWS_PROFILE AWS_REGION STACK_NAME ARTIFACT_BUCKET; do
  if [[ -z "${!var:-}" ]]; then
    echo "error: $var is not set in $ENV_FILE" >&2
    exit 1
  fi
done

AWS=(aws --profile "$AWS_PROFILE" --region "$AWS_REGION")

echo "==> Building @ig/api"
pnpm -F @ig/api build

echo "==> Packaging (uploading Lambda code to s3://$ARTIFACT_BUCKET)"
"${AWS[@]}" cloudformation package \
  --template-file infra/template.yaml \
  --s3-bucket "$ARTIFACT_BUCKET" \
  --output-template-file packaged.yaml

echo "==> Deploying stack $STACK_NAME"
"${AWS[@]}" cloudformation deploy \
  --template-file packaged.yaml \
  --stack-name "$STACK_NAME" \
  --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND \
  --parameter-overrides Environment=dev

echo "==> Outputs"
"${AWS[@]}" cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --query 'Stacks[0].Outputs' \
  --output table
