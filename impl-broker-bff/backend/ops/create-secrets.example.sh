#!/usr/bin/env bash
# Create/update the Secrets Manager values referenced by backend/template.yaml.
#
# Required environment:
#   SESSION_ENC_KEY_B64U TX_ENC_KEY_B64U ENROLLED_ENC_KEY_B64U
#   PORTALS_JSON_FILE    path to the real portal-secrets.json (not the example)
#
# Optional:
#   SESSION_ENC_KEY_PREVIOUS_B64U TX_ENC_KEY_PREVIOUS_B64U ENROLLED_ENC_KEY_PREVIOUS_B64U
#   AWS_REGION KMS_KEY_ID
#
# On first deploy the PREVIOUS values default to CURRENT. During rotation set
# them explicitly to the old values before deploying the new current keys.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORTALS_JSON_FILE="${PORTALS_JSON_FILE:-$HERE/portal-secrets.json}"
AWS_REGION="${AWS_REGION:-eu-central-1}"
export AWS_REGION

TMP_FILES=()
cleanup() {
  if ((${#TMP_FILES[@]})); then rm -f "${TMP_FILES[@]}"; fi
}
trap cleanup EXIT

require() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "missing required env: $name" >&2
    exit 1
  fi
}

require SESSION_ENC_KEY_B64U
require TX_ENC_KEY_B64U
require ENROLLED_ENC_KEY_B64U

SESSION_ENC_KEY_PREVIOUS_B64U="${SESSION_ENC_KEY_PREVIOUS_B64U:-$SESSION_ENC_KEY_B64U}"
TX_ENC_KEY_PREVIOUS_B64U="${TX_ENC_KEY_PREVIOUS_B64U:-$TX_ENC_KEY_B64U}"
ENROLLED_ENC_KEY_PREVIOUS_B64U="${ENROLLED_ENC_KEY_PREVIOUS_B64U:-$ENROLLED_ENC_KEY_B64U}"

if [[ ! -f "$PORTALS_JSON_FILE" ]]; then
  echo "PORTALS_JSON_FILE not found: $PORTALS_JSON_FILE" >&2
  exit 1
fi

# Fail closed on placeholders and malformed keys before talking to AWS.
node - "$PORTALS_JSON_FILE" \
  "$SESSION_ENC_KEY_B64U" "$SESSION_ENC_KEY_PREVIOUS_B64U" \
  "$TX_ENC_KEY_B64U" "$TX_ENC_KEY_PREVIOUS_B64U" \
  "$ENROLLED_ENC_KEY_B64U" "$ENROLLED_ENC_KEY_PREVIOUS_B64U" <<'NODE'
const fs = require('node:fs');
const [file, ...keys] = process.argv.slice(2);
const raw = fs.readFileSync(file, 'utf8');
if (/REPLACE_/i.test(raw)) throw new Error('portal secrets file still contains REPLACE_*');
const portals = JSON.parse(raw);
if (Object.keys(portals).length !== 9) throw new Error('expected exactly 9 portals');
for (const [host, p] of Object.entries(portals)) {
  if (!p.realm || !p.clientId || !p.clientSecret || !p.redirectUri) {
    throw new Error(`incomplete portal config: ${host}`);
  }
  if (!p.redirectUri.startsWith('https://') || !p.redirectUri.endsWith('/api/auth/callback')) {
    throw new Error(`invalid redirectUri: ${host}`);
  }
}
for (const value of keys) {
  const buf = Buffer.from(value, 'base64url');
  if (buf.length !== 32 || buf.toString('base64url') !== value) {
    throw new Error('every encryption key must be 32-byte base64url');
  }
}
NODE

PORTALS_JSON="$(node -e 'process.stdout.write(JSON.stringify(require("node:fs").readFileSync(process.argv[1], "utf8").trim()))' "$PORTALS_JSON_FILE")"

write_secret_file() {
  local payload="$1"
  local tmp
  tmp="$(mktemp)"
  chmod 600 "$tmp"
  printf '%s' "$payload" > "$tmp"
  TMP_FILES+=("$tmp")
  printf '%s' "$tmp"
}

put_secret() {
  local name="$1"
  local payload="$2"
  local file
  file="$(write_secret_file "$payload")"
  local kms_args=()
  if [[ -n "${KMS_KEY_ID:-}" ]]; then
    kms_args=(--kms-key-id "$KMS_KEY_ID")
  fi

  if aws secretsmanager describe-secret --secret-id "$name" >/dev/null 2>&1; then
    echo "Updating $name"
    aws secretsmanager put-secret-value \
      --secret-id "$name" \
      --secret-string "file://$file" \
      >/dev/null
  else
    echo "Creating $name"
    aws secretsmanager create-secret \
      --name "$name" \
      --secret-string "file://$file" \
      "${kms_args[@]}" \
      >/dev/null
  fi
}

json_value() {
  node -e 'process.stdout.write(JSON.stringify({ value: process.argv[1] }))' "$1"
}

put_secret 'vw/passkey-bff/portals' "{\"PORTALS_JSON\":$PORTALS_JSON}"
put_secret 'vw/passkey-bff/session-enc-key' "$(json_value "$SESSION_ENC_KEY_B64U")"
put_secret 'vw/passkey-bff/session-enc-key-previous' "$(json_value "$SESSION_ENC_KEY_PREVIOUS_B64U")"
put_secret 'vw/passkey-bff/tx-enc-key' "$(json_value "$TX_ENC_KEY_B64U")"
put_secret 'vw/passkey-bff/tx-enc-key-previous' "$(json_value "$TX_ENC_KEY_PREVIOUS_B64U")"
put_secret 'vw/passkey-bff/enrolled-enc-key' "$(json_value "$ENROLLED_ENC_KEY_B64U")"
put_secret 'vw/passkey-bff/enrolled-enc-key-previous' "$(json_value "$ENROLLED_ENC_KEY_PREVIOUS_B64U")"

echo 'Secrets ready.'
