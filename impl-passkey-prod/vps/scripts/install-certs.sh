#!/usr/bin/env bash
set -euo pipefail

# Copies real certificates issued by Let's Encrypt (certbot) into ./certs.
# Adjust CERTBOT_BASE if your certbot layout differs. No self-signed certs.

CERTBOT_BASE="${CERTBOT_BASE:-/etc/letsencrypt/live}"
PUBLIC_DOMAIN="${PUBLIC_DOMAIN:-kc.gateway-vw.de}"
ADMIN_DOMAIN="${ADMIN_DOMAIN:-kc-admin.gateway-vw.de}"

cd "$(dirname "$0")/.."
mkdir -p certs

for spec in "${PUBLIC_DOMAIN}:kc.gateway-vw.de" "${ADMIN_DOMAIN}:kc-admin.gateway-vw.de"; do
  source_dir="${CERTBOT_BASE}/${spec%%:*}"
  target_prefix="certs/${spec##*:}"
  install -m 0644 "${source_dir}/fullchain.pem" "${target_prefix}.fullchain.pem"
  install -m 0600 "${source_dir}/privkey.pem" "${target_prefix}.key.pem"
  echo "Installed certificate for ${spec%%:*}"
done

docker compose exec nginx nginx -t && docker compose exec nginx nginx -s reload
echo "Certificates installed and nginx reloaded."
