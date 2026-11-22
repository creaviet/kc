#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  echo "ERROR: vps/.env missing. Copy .env.example and fill real secrets." >&2
  exit 1
fi

if [[ ! -d certs ]]; then
  echo "ERROR: vps/certs/ missing. Install real TLS certificates first (see README)." >&2
  exit 1
fi

docker compose config >/dev/null
docker compose pull
docker compose up -d --build

echo "Waiting for Keycloak public discovery endpoint..."
for i in $(seq 1 60); do
  if curl -fsS --max-time 5 https://kc.gateway-vw.de:8443/realms/master/.well-known/openid-configuration >/dev/null; then
    echo "Keycloak is serving real TLS traffic."
    exit 0
  fi
  sleep 2
done

echo "ERROR: Keycloak did not become healthy. Check: docker compose logs keycloak nginx" >&2
exit 1
