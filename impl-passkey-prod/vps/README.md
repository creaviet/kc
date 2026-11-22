# IONOS VPS: nginx + Keycloak 26.8 + PostgreSQL

This folder is the **real** deployment configuration. There is no emulator and no mock IdP.

## 1. One-time setup

1. Install real TLS certificates for both hostnames:
   - `kc.gateway-vw.de` → `certs/kc.gateway-vw.de.fullchain.pem` + `.key.pem`
   - `kc-admin.gateway-vw.de` → `certs/kc-admin.gateway-vw.de.fullchain.pem` + `.key.pem`

   With Let's Encrypt/certbot (ports 80 for HTTP-01 must be reachable):

   ```bash
   sudo certbot certonly --standalone -d kc.gateway-vw.de -d kc-admin.gateway-vw.de
   CERTBOT_BASE=/etc/letsencrypt/live bash scripts/install-certs.sh
   ```
   Adjust the script if you use a company CA. **Never ship self-signed certificates.**

2. Restrict the admin plane. Edit `nginx/admin-allow.conf` and add **only** your own IPs:

   ```nginx
   allow 203.0.113.10;
   allow 198.51.100.0/24;
   deny all;
   ```

   Default is `deny all` (fail closed). Verify from a non-allowlisted network that
   `https://kc-admin.gateway-vw.de:8444/admin/` returns 403.

3. Copy `.env.example` to `.env` and replace every placeholder with high-entropy values:

   ```bash
   openssl rand -base64 48   # use for DB and bootstrap admin passwords
   ```

4. Determine the Docker nginx CIDR and put it in `KC_PROXY_TRUSTED_ADDRESSES`
   (e.g. `docker network inspect bridge | grep Subnet`). Keycloak rejects proxy
   headers from untrusted addresses.

5. Fill `verimi.json` from `verimi.example.json` with Verimi's **real** OIDC
   endpoints, issuer, client ID and secret. Confirm with Verimi that they accept
   `https://kc.gateway-vw.de:8443/realms/<realm>/broker/verimi/endpoint` as the
   post-login redirect for all 9 realms.

6. Start the stack:

   ```bash
   bash scripts/deploy.sh
   ```

## 2. Provision the 9 realms (no Java, no UI clicking)

From a machine that is allowed to reach the admin hostname:

```bash
export KC_ADMIN_URL=https://kc-admin.gateway-vw.de:8444
export KC_ADMIN_USERNAME=<bootstrap-admin>
export KC_ADMIN_PASSWORD=<bootstrap-admin-password>
export VPS_PORTALS_FILE=../backend/ops/portals.json
export VPS_VERIMI_FILE=./verimi.json
node ops/generate-realms.js
```

What it does, exactly:

1. `POST /realms/master/protocol/openid-connect/token` (password or client-credentials grant).
2. Generates a 32-byte client secret per realm and writes it into `keycloak/vault/<realm>-portal-secret` (mode 0600).
3. Fills `realm-template.json` placeholders (realm, display name, API host, portal host, real Verimi URLs).
4. `GET /admin/realms/<realm>` → `POST /admin/realms` or `PUT /admin/realms/<realm>`.
5. Writes the same realm JSON to `keycloak/generated/` so a fresh container can `--import-realm`.
6. Writes `generated/portal-secrets.json` for import into AWS Secrets Manager.

**Warning:** `PUT` with a full realm representation replaces the realm configuration.
Use this script as the single source of truth; do not hand-edit realms in the UI after running it.

## 3. Verify

```bash
bash scripts/verify.sh
```

This calls the real discovery endpoints of all realms and reports the admin-plane status.

## 4. WebAuthn / passkey settings (already in the realm template)

```text
RP ID                      gateway-vw.de        (registrable parent of kc.gateway-vw.de — valid)
Origin                     https://kc.gateway-vw.de:8443
Policy                     webAuthnPolicyPasswordless*
Passkeys enabled           true
User verification          required
Resident key               required
Algorithms                 ES256, RS256
AIA for registration       kc_action=webauthn-register-passwordless:skip_if_exists
```

Private keys never reach the server. PostgreSQL stores public keys only.

## 5. Operations

- Backups: dump PostgreSQL (`pg_dump`) at least daily; keep `keycloak/vault/` in a secret manager too.
- Logs: nginx access/error logs + Keycloak `jboss-logging` events (`LOGIN`, `FIRST_BROKER_LOGIN`, `CREDENTIAL_REGISTER`).
- After 2026-12-31: set `verimiEnabled:false` in the portal manifest, re-run `generate-realms.js` (it empties `identityProviders`), rebuild/restart Keycloak. Passkey login is unaffected.
- Known SPOF: one VPS. Upgrade path is a second Keycloak node + managed Postgres; no BFF change needed.
