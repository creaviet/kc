#!/usr/bin/env bash
# Read-only deployment verification. No secrets required.
#
# Required:
#   KC_PUBLIC_URL=https://kc.gateway-vw.de:8443
# Optional:
#   PORTALS_FILE=.../portals.json
#   ADMIN_URL=https://kc-admin.gateway-vw.de:8444/admin

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORTALS_FILE="${PORTALS_FILE:-$HERE/portals.json}"
ADMIN_URL="${ADMIN_URL:-https://kc-admin.gateway-vw.de:8444/admin}"

if [[ -z "${KC_PUBLIC_URL:-}" ]]; then
  echo 'KC_PUBLIC_URL is required' >&2
  exit 1
fi

REALMS="$(node -e 'const d=require(process.argv[1]);console.log(d.portals.map(p=>p.realm).join(" "))' "$PORTALS_FILE")"

failed=0
for realm in $REALMS; do
  discovery="${KC_PUBLIC_URL}/realms/${realm}"
  jwks="${discovery}/protocol/openid-connect/certs"

  code="$(curl -sS -o /tmp/opencode-kc-discovery.json -w '%{http_code}' --max-time 10 "$discovery" || true)"
  if [[ "$code" != "200" ]]; then
    echo "FAIL discovery $realm HTTP $code"
    failed=1
    continue
  fi

  actual="$(node -e 'const j=require("/tmp/opencode-kc-discovery.json");process.stdout.write(j.issuer||"")')"
  expected="${KC_PUBLIC_URL}/realms/${realm}"
  if [[ "$actual" != "$expected" ]]; then
    echo "FAIL issuer $realm: expected $expected, got $actual"
    failed=1
  fi

  code="$(curl -sS -o /tmp/opencode-kc-jwks.json -w '%{http_code}' --max-time 10 "$jwks" || true)"
  keys="$(node -e 'try{const j=require("/tmp/opencode-kc-jwks.json");console.log((j.keys||[]).length)}catch{console.log(0)}')"
  if [[ "$code" != "200" || "$keys" -lt 1 ]]; then
    echo "FAIL jwks $realm HTTP $code keys=$keys"
    failed=1
    continue
  fi

  echo "OK $realm issuer=$actual keys=$keys"
done

# The admin URL should NOT be reachable from this host if this is an untrusted IP.
admin_code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "$ADMIN_URL" || true)"
echo "INFO admin status from current IP: ${admin_code:-timeout}"

exit "$failed"
