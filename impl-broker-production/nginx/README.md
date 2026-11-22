# nginx production topology

Two separate vhosts terminate TLS on the IONOS VPS:

| Public name | Port | Purpose | Exposure |
|---|---:|---|---|
| `kc.gateway-vw.de` | 8443 | Login, OIDC, WebAuthn, Account API | public |
| `kc-admin.gateway-vw.de` | 8444 | Admin console | allowlisted IPs only |

Keycloak itself listens only on internal `keycloak:8080`. It is never published
directly.

---

## 1. Files

```text
nginx/
├── nginx.conf
├── admin-allow.conf          # IP allowlist, must be filled by you
├── conf.d/
│   ├── 10-keycloak-public.conf
│   └── 20-keycloak-admin.conf
└── snippets/
    └── keycloak-proxy.conf
```

The public vhost has a catch-all `server_name _; return 444;` and blocks admin
paths. The admin vhost has:

```nginx
include /etc/nginx/admin-allow.conf;
deny all;
```

`backend/ops/preflight.js` fails if `deny all;` is missing.

Fill `nginx/admin-allow.conf` before exposing port 8444:

```nginx
allow 203.0.113.10/32;   # office IP
allow 10.8.0.0/24;       # VPN subnet
```

Also restrict port 8444 at the IONOS firewall/VPS host firewall. Defence in
depth is mandatory.

---

## 2. TLS certificates

The compose file mounts:

```text
./certs/server.crt
./certs/server.key
```

Use a real certificate covering both hostnames. The folder is gitignored.
Do not use self-signed certificates in production; `openid-client`, WebAuthn and
browsers all depend on trustworthy TLS.

---

## 3. Deploy

From this folder:

```bash
cd /home/think/Dev/ai/ideas/Projects/keycloak-passkey-3/impl-broker-production

docker compose down
docker compose up -d --build
```

---

## 4. Verify

```bash
# Must return Keycloak JSON, not nginx's static 404 page.
curl -fsS -D - https://kc.gateway-vw.de:8443/realms/vw-beav | head -20

# JWKS must return keys.
curl -fsS https://kc.gateway-vw.de:8443/realms/vw-beav/protocol/openid-connect/certs

# Admin must be blocked from untrusted IPs.
curl -sS -o /dev/null -w '%{http_code}\n' https://kc-admin.gateway-vw.de:8444/admin/
# Expected from an untrusted IP: 403/timeout/refused.
```

Inside the network, confirm Keycloak itself is healthy:

```bash
docker exec nginx curl -sS -o /dev/null -w '%{http_code}\n' http://keycloak:8080/realms/vw-beav
docker logs nginx --tail 50
```

---

## 5. Proxy headers and Keycloak hostnames

`snippets/keycloak-proxy.conf` sends `Forwarded`, `X-Forwarded-Proto`,
`X-Forwarded-Host` and `X-Forwarded-Port`. Together with:

```yaml
KC_HOSTNAME: https://kc.gateway-vw.de:8443
KC_HOSTNAME_ADMIN: https://kc-admin.gateway-vw.de:8444
KC_HOSTNAME_STRICT: "true"
KC_PROXY_HEADERS: forwarded
```

this ensures Keycloak emits `iss`, authorization, token and logout URLs with the
public `:8443` origin. Do not change the hostname after users enrol passkeys:
the WebAuthn RP binding and OIDC issuer are security-critical.
