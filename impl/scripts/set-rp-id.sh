#!/bin/sh
# ============================================================================
#  Change the WebAuthn RP ID of the realm (production cut-over).
# ============================================================================
#  The RP ID is bound to the Keycloak origin and is IMMUTABLE for existing
#  credentials: after changing it every previously enrolled passkey stops
#  working. Do this before the first real enrolment, or announce a re-enrolment.
#
#    ./scripts/set-rp-id.sh --rp-id kc.gateway-vw.de --yes
#
#  What else must match the new domain (not done by this script):
#    - KC_HOSTNAME / KC_HOSTNAME_ADMIN in .env
#    - server_name in nginx/conf.d/*.conf
#    - client "portal-spa": redirectUris / webOrigins / post.logout.redirect.uris
#    - IdP "verimi": authorizationUrl / issuer / logoutUrl
#    - certificates: subjectAltName of certs/server.crt
#    - /etc/hosts (local demo)
# ============================================================================
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
cd "$PROJECT_DIR"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

REALM=${KEYCLOAK_REALM:-vw-beav}
ADMIN_USER=${KC_BOOTSTRAP_ADMIN_USERNAME:-admin}
ADMIN_PASS=${KC_BOOTSTRAP_ADMIN_PASSWORD:-admin}

RP_ID=""
CONFIRMED="no"

while [ $# -gt 0 ]; do
  case "$1" in
    --rp-id) RP_ID=${2:-}; shift 2 ;;
    --yes) CONFIRMED="yes"; shift ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$RP_ID" ]; then
  echo "ERROR: --rp-id is required (e.g. --rp-id kc.gateway-vw.de)" >&2
  exit 2
fi

case "$RP_ID" in
  *://*|*/*|*:*) echo "ERROR: RP ID must be a bare domain without scheme, port or path" >&2; exit 2 ;;
esac
if ! printf '%s' "$RP_ID" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$'; then
  echo "ERROR: '$RP_ID' is not a valid domain name" >&2
  exit 2
fi

if [ "$CONFIRMED" != "yes" ]; then
  cat <<EOS
About to set the realm WebAuthn RP ID to: $RP_ID

WARNING: all existing passkeys for realm '$REALM' will stop working.

Re-run with --yes to proceed.
EOS
  exit 1
fi

kcadm() {
  docker compose exec -T keycloak /opt/keycloak/bin/kcadm.sh "$@"
}

kcadm config credentials --server http://localhost:8080 --realm master \
  --user "$ADMIN_USER" --password "$ADMIN_PASS" >/dev/null

kcadm update "realms/$REALM" \
  -s "webAuthnPolicyRpId=$RP_ID" \
  -s "webAuthnPolicyPasswordlessRpId=$RP_ID"

echo "==> RP ID set to $RP_ID"
echo "    Remember to update KC_HOSTNAME, nginx server_name, client URLs, IdP URLs and the TLS SANs."
