#!/bin/sh
# ============================================================================
#  Import (or re-import) the realm into a running stack.
# ============================================================================
#  The compose stack imports keycloak/realm-export.json automatically on the
#  first start (empty database). Use this script when the realm already exists
#  and you changed the JSON.
#
#    ./scripts/import-realm.sh              # import only if the realm is missing
#    ./scripts/import-realm.sh --recreate   # DELETE realm "vw" and re-import
#
#  --recreate destroys all users, sessions and passkeys in the realm.
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

kcadm() {
  docker compose exec -T keycloak /opt/keycloak/bin/kcadm.sh "$@"
}

echo "==> waiting for Keycloak"
i=0
until docker compose exec -T keycloak /opt/keycloak/bin/kcadm.sh config credentials \
      --server http://localhost:8080 --realm master \
      --user "$ADMIN_USER" --password "$ADMIN_PASS" >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 60 ]; then
    echo "ERROR: Keycloak did not accept the admin credentials within 120s." >&2
    echo "       Check: docker compose logs keycloak" >&2
    exit 1
  fi
  sleep 2
done

if kcadm get "realms/$REALM" >/dev/null 2>&1; then
  if [ "${1:-}" != "--recreate" ]; then
    echo "Realm '$REALM' already exists - nothing to do."
    echo "Use --recreate to delete and re-import (destroys users/passkeys)."
    exit 0
  fi
  echo "==> deleting realm $REALM"
  kcadm delete "realms/$REALM"
fi

echo "==> importing /opt/keycloak/data/import/realm-export.json"
kcadm create realms -f /opt/keycloak/data/import/realm-export.json

echo "==> done. Realm '$REALM' is available at:"
echo "    ${KC_HOSTNAME:-https://kc.gateway-vw.de:8443}/realms/$REALM/.well-known/openid-configuration"
