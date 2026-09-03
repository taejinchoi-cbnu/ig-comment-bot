#!/usr/bin/env bash
# Creates (or updates) the Secrets Manager entry the Lambdas read at runtime.
# infra/template.yaml deliberately does NOT declare it — the value would land in
# the CloudFormation template and stack state. This is that "out-of-band" step.
#
# MASTER_KEY must be byte-identical here and in ops/deploy.env: connect-account.ts
# encrypts tokens locally with the deploy.env copy, the Worker decrypts them with
# this one. Deriving both from the same file removes that whole class of bug.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

ENV_FILE="ops/deploy.env"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "error: $ENV_FILE not found." >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$ENV_FILE"

for var in AWS_PROFILE AWS_REGION DATABASE_URL MASTER_KEY; do
  if [[ -z "${!var:-}" ]]; then
    echo "error: $var is not set in $ENV_FILE" >&2
    exit 1
  fi
done

ENVIRONMENT="${ENVIRONMENT:-dev}"
SECRET_ID="ig-comment-bot/${ENVIRONMENT}/app"

# Both checks below only surface as a runtime failure inside Lambda otherwise.
key_bytes=$(printf '%s' "$MASTER_KEY" | base64 -d 2>/dev/null | wc -c)
if [[ "$key_bytes" != "32" ]]; then
  echo "error: MASTER_KEY must be base64 of 32 bytes (decoded: ${key_bytes})." >&2
  echo "       generate one with: openssl rand -base64 32" >&2
  exit 1
fi
if [[ "$DATABASE_URL" != *"-pooler"* ]]; then
  echo "error: DATABASE_URL must be the POOLED Neon URL (host contains '-pooler')." >&2
  echo "       the unpooled one belongs in DATABASE_URL_UNPOOLED, for migrations only." >&2
  exit 1
fi

# Secrets go through a 0600 file, never argv — argv is world-readable in /proc
# and lands in shell history.
PAYLOAD=$(mktemp)
chmod 600 "$PAYLOAD"
trap 'rm -f "$PAYLOAD"' EXIT
DATABASE_URL="$DATABASE_URL" MASTER_KEY="$MASTER_KEY" \
  node -e 'process.stdout.write(JSON.stringify({DATABASE_URL:process.env.DATABASE_URL,MASTER_KEY:process.env.MASTER_KEY}))' \
  > "$PAYLOAD"

AWS=(aws --profile "$AWS_PROFILE" --region "$AWS_REGION")

if "${AWS[@]}" secretsmanager describe-secret --secret-id "$SECRET_ID" >/dev/null 2>&1; then
  echo "==> Updating existing secret $SECRET_ID"
  "${AWS[@]}" secretsmanager put-secret-value \
    --secret-id "$SECRET_ID" \
    --secret-string "file://$PAYLOAD" \
    --query 'VersionId' --output text
else
  echo "==> Creating secret $SECRET_ID"
  "${AWS[@]}" secretsmanager create-secret \
    --name "$SECRET_ID" \
    --description "ig-comment-bot ${ENVIRONMENT}: DATABASE_URL + token master key" \
    --secret-string "file://$PAYLOAD" \
    --query 'ARN' --output text
fi

echo "==> Keys stored (values not printed)"
"${AWS[@]}" secretsmanager get-secret-value --secret-id "$SECRET_ID" \
  --query 'SecretString' --output text | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(Object.keys(JSON.parse(s)).join(", ")))'
