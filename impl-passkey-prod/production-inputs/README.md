# Production input templates

These files are **templates only**. They contain placeholders on purpose.

The runtime code never reads this folder. Copy a template, rename it, fill it locally, validate it, then copy the filled file to the path shown below. Filled files are gitignored.

**Realm decision:** you chose **one realm per portal**. That means:

- passkeys are isolated per portal;
- there is no SSO between portals;
- each portal has its own Verimi broker redirect URI;
- the same person needs one passkey per portal.

This matches the current implementation in `backend/`, `frontend/` and `vps/`.

---

## 1. Fill these files

From `impl-passkey-prod/production-inputs/`:

| Template | Copy to | Contains | Secret? |
|---|---|---|---|
| `portals.template.json` | `portals.json` | 9 portal hosts, API hosts, realm names, URLs | No |
| `domains.template.json` | `domains.json` | ACM cert ARNs + Route53 zone IDs | No |
| `verimi.template.json` | `verimi.json` | Verimi OIDC metadata, client ID/secret | **Yes** |
| `verimi-redirect-uris.txt.template` | `verimi-redirect-uris.txt` | 9 broker redirect URIs for Verimi | No |
| `vps.env.template` | `vps.env` | DB/admin passwords, proxy CIDR | **Yes** |
| `admin-allow.template.conf` | `admin-allow.conf` | admin IP allowlist | No |
| `aws-deploy.template.env` | `aws-deploy.env` | AWS ARNs, region, cookie key id | Partly |
| `frontend.env.template` | `frontend.env` | frontend build variables | No |

`aws-deploy.template.env` contains a cookie encryption key placeholder. Generate the real key locally; do not paste it into chat.

---

## 2. Generate secrets locally

```bash
# AES-256-GCM key for encrypted __Host- cookies
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"

# PostgreSQL password
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"

# Keycloak bootstrap admin password
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Put those values into your local filled files only.

---

## 3. Validate before deploying

```bash
cd impl-passkey-prod
node production-inputs/validate-inputs.js
```

The validator fails if:

- any placeholder remains;
- there are not exactly 9 portals;
- hosts, realms or secret keys are duplicated;
- redirect URLs do not match the portal/API host;
- Verimi redirect URIs do not match the 9 realms;
- RSA/AWS/Keycloak URLs are not HTTPS;
- the admin allowlist is empty or still contains documentation IPs;
- the cookie key is not a 32-byte base64url value.

No secret values are printed.

---

## 4. Copy filled files to deployment paths

```bash
cd impl-passkey-prod

cp production-inputs/portals.json backend/ops/portals.json
cp production-inputs/domains.json backend/ops/domains.json
cp production-inputs/verimi.json vps/verimi.json
cp production-inputs/vps.env vps/.env
cp production-inputs/admin-allow.conf vps/nginx/admin-allow.conf

# For each portal, adjust VITE_API_BASE if needed, then:
cp production-inputs/frontend.env frontend/.env
```

---

## 5. Send this to Verimi

Send the contents of your filled `verimi-redirect-uris.txt` to Verimi and ask them to allow exactly those 9 redirect URIs.

Pattern:

```text
https://kc.gateway-vw.de:8443/realms/<realm>/broker/verimi/endpoint
```

Do **not** register the portal callback URLs at Verimi. Verimi redirects to Keycloak; Keycloak redirects to the BFF callback.
