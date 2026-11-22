# Fixing the nginx 404 on `kc.gateway-vw.de:8443`

## What we observed

```
kc.gateway-vw.de → 31.70.137.198 (your IONOS VPS)
GET /realms/vw-beav  → 404, 146-byte nginx static error page
kc-admin.gateway-vw.de:8444 → connection refused
```

The response has `Server: nginx` and nginx's own HTML body. Keycloak was
**never reached**. If Keycloak had been reached with a missing realm, you would
see Keycloak's error page, not nginx's.

## Admin port policy (important)

`kc-admin.gateway-vw.de:8444` should be **unreachable from the public internet**.
A separate hostname and port reduce noise, but the real control is network
restriction:

The production vhost now uses a separate mounted allow file:

```nginx
# nginx/conf.d/20-keycloak-admin.conf
include /etc/nginx/admin-allow.conf;
deny all;                # safe default for everyone else
```

Fill it like this:

```nginx
# nginx/admin-allow.conf
allow 203.0.113.10/32;   # office IP — replace with yours
allow 10.8.0.0/24;       # VPN subnet — replace with yours
```

Add the same rule at the VPS firewall/Security Group as defence in depth. Test
from an allowed IP — only there should `https://kc-admin.gateway-vw.de:8444/`
return the Keycloak admin login. From any other IP, timeout/refused/403 is the
expected and desired result. Do not expose admin to `0.0.0.0/0`.

## 1. Diagnose on the VPS (run these first)

```bash
# Are the containers actually up?
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'

# What config is nginx really using?
docker exec nginx nginx -T | grep -nE 'server_name|listen|proxy_pass|root|try_files'

# Which files are mounted?
docker exec nginx ls -l /etc/nginx/conf.d/

# Does Keycloak answer internally?
docker exec nginx curl -s -i http://keycloak:8080/realms/vw-beav | head -20

# nginx error log
docker logs nginx --tail 50
```

Typical findings:
- `10-keycloak-public.conf` is **not** in `/etc/nginx/conf.d/` → nginx falls back
  to a static `root` and returns its own 404 for every path.
- nginx publishes 80/443 while its config listens on 8443/8444 (this is exactly
  what the old `impl/docker-compose.yml` did) → the port mapping doesn't match.
- Keycloak container is down → admin port 8444 unreachable.

## 2. Deploy the corrected config

From the new folder on the VPS:

```bash
cd impl-broker-bff

# TLS certs (reuse the existing ones, or generate new ones)
mkdir -p certs
cp ../impl/certs/server.crt ../impl/certs/server.key certs/ 2>/dev/null || \
  CERT_DIR=$PWD/certs ../impl/scripts/gen-certs.sh

docker compose down
docker compose up -d --build
```

The corrected `docker-compose.yml` in this folder:
- publishes **8443 and 8444 on nginx** (matching its `listen` directives),
- runs Keycloak on internal **8080 only** with `KC_HTTP_ENABLED=true`,
- forwards `X-Forwarded-Proto`, `-Host`, `-Port` so Keycloak generates URLs with
  `:8443` instead of `:8080`.

## 3. Verify before touching the frontend

```bash
# This must now return Keycloak's JSON, NOT nginx's 404 HTML:
curl -k -i https://kc.gateway-vw.de:8443/realms/vw-beav | head -20
# Expect: HTTP/2 200 and {"realm":"vw-beav", ...}

curl -k -s -o /dev/null -w '%{http_code}\n' \
  https://kc.gateway-vw.de:8443/realms/vw-beav/protocol/openid-connect/certs
# Expect: 200 (JWKS)
```

Once that works, click **Anmelden** again. The next possible error would be
`invalid_request` from Keycloak if the realm's Verimi placeholders are still
unset — that is expected and documented in `keycloak/README.md`.

> **Cannot get shell access to the VPS?** Paste the output of the four diagnose
> commands above and I'll tell you the exact line to change.
