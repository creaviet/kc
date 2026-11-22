#!/usr/bin/env bash
set -euo pipefail

# Real AWS CLI command. Run from a trusted admin machine with permission to
# write the secret. The input file is produced by vps/ops/generate-realms.js.

SECRET_ID="${SECRET_ID:-vw-portal-client-secrets}"
SECRET_FILE="${SECRET_FILE:-../../vps/generated/portal-secrets.json}"
REGION="${AWS_REGION:-eu-central-1}"

if [[ ! -f "$SECRET_FILE" ]]; then
  echo "ERROR: $SECRET_FILE missing — run vps/ops/generate-realms.js first" >&2
  exit 1
fi

if aws secretsmanager describe-secret --secret-id "$SECRET_ID" --region "$REGION" >/dev/null 2>&1; then
  aws secretsmanager put-secret-value \
    --secret-id "$SECRET_ID" \
    --secret-string "file://${SECRET_FILE}" \
    --region "$REGION"
else
  aws secretsmanager create-secret \
    --name "$SECRET_ID" \
    --secret-string "file://${SECRET_FILE}" \
    --region "$REGION"
fi

echo "Secret $SECRET_ID updated. Copy its ARN into template.yaml parameter SecretsSecretArn."
