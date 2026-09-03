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

# Defaults to dev. Set ENVIRONMENT=prod in ops/deploy.env for a prod stack —
# this must track STACK_NAME, or the deploy silently points a "prod" stack
# at dev's Secrets Manager entry (APP_SECRET_ID uses ${Environment}).
ENVIRONMENT="${ENVIRONMENT:-dev}"
if [[ "$ENVIRONMENT" != "dev" && "$ENVIRONMENT" != "prod" ]]; then
  echo "error: ENVIRONMENT must be 'dev' or 'prod', got '$ENVIRONMENT'" >&2
  exit 1
fi

AWS=(aws --profile "$AWS_PROFILE" --region "$AWS_REGION")

echo "==> Bundling Lambda functions (esbuild, environment: $ENVIRONMENT)"
pnpm -F @ig/api build:lambda

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
  --parameter-overrides "Environment=${ENVIRONMENT}"

echo "==> Outputs"
"${AWS[@]}" cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --query 'Stacks[0].Outputs' \
  --output table

# A green CloudFormation deploy says nothing about whether the function can boot.
# The first deploy came up CREATE_COMPLETE and returned 502 on every request
# (Runtime.CallbackHandlerDeprecated — a handler arity the bundler can't catch).
# One curl closes that gap for every init-time failure, not just that one.
echo "==> Smoke test"
FUNCTION_URL=$("${AWS[@]}" cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --query 'Stacks[0].Outputs[?OutputKey==`ApiFunctionUrl`].OutputValue' \
  --output text)
STATUS=$(curl -s -o /dev/null -w '%{http_code}' "${FUNCTION_URL%/}/health")
if [[ "$STATUS" != "200" ]]; then
  echo "error: GET ${FUNCTION_URL%/}/health returned $STATUS (expected 200)." >&2
  echo "       ${AWS[*]} logs tail /aws/lambda/ig-comment-bot-${ENVIRONMENT}-Api --since 5m" >&2
  exit 1
fi
echo "GET ${FUNCTION_URL%/}/health -> 200"
