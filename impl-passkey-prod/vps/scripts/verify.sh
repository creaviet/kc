#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
PORTALS_FILE="${VPS_PORTALS_FILE:-../backend/ops/portals.json}"

if [[ ! -f "$PORTALS_FILE" ]]; then
  echo "ERROR: portal manifest not found: $PORTALS_FILE" >&2
  exit 1
fi

echo "== public Keycloak =="
curl -fsS https://kc.gateway-vw.de:8443/realms/master/.well-known/openid-configuration | head -c 200
echo

echo "== realms from manifest =="
node -e '
const fs = require("fs");
const portals = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).portals;
for (const p of portals) console.log(p.realm);
' "$PORTALS_FILE" | while read -r realm; do
  url="https://kc.gateway-vw.de:8443/realms/${realm}/.well-known/openid-configuration"
  if curl -fsS --max-time 10 "$url" >/dev/null; then
    echo "OK  $realm"
  else
    echo "FAIL $realm" >&2
    exit 1
  fi
done

echo "== admin plane =="
status=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 https://kc-admin.gateway-vw.de:8444/admin/ || true)
echo "admin HTTP status from this host: $status (200 expected only from allowlisted IPs, otherwise 403)"
