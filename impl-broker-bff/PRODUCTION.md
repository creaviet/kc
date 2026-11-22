# Production runbook — Keycloak IdP broker + passkey bootstrap

This is the checklist that turns the prototype into a deployable system.
It is intentionally **fail-closed**: every placeholder must be replaced.
Nothing in this file invents your real Verimi endpoints, client IDs, domains,
IPs, certificates, or AWS ARNs.

> Architecture source of truth: [`../architecture_11-20-2026.md`](../architecture_11-20-2026.md)

---

## 0. Inputs you must provide before deployment

| # | Input | Where it is used | Example shape |
|---:|---|---|---|
| 1 | 9 real portal hostnames | `backend/ops/portals.json`, `portal-secrets.json`, API custom domains | `vw-baev.de`, `ltkv.de`, … |
| 2 | 9 realm names | Keycloak realm generation, `PORTALS_JSON` | `vw-beav`, `ltkv`, … |
| 3 | 9 display names | generated realm `displayName` | `VW BEAV Portal` |
| 4 | 9 BFF client secrets | Secrets Manager `vw/passkey-bff/portals` and Keycloak vault files | random secrets |
| 5 | Verimi authorization URL | Keycloak IdP config | `https://<host>/…/authorize` |
| 6 | Verimi token URL | Keycloak IdP config | `https://<host>/…/token` |
| 7 | Verimi userinfo URL | Keycloak IdP config | `https://<host>/…/userinfo` |
| 8 | Verimi JWKS URL | Keycloak signature validation | `https://<host>/…/jwks` |
| 9 | Verimi issuer | Keycloak IdP config | `https://<host>` |
| 10 | Verimi client ID | Keycloak IdP config | from Verimi |
| 11 | Verimi client secret **per realm** | `keycloak/vault/<realm>_verimi-client-secret` | from Verimi |
| 12 | Verimi logout URL, if it exists | Keycloak IdP config | optional |
| 13 | Trusted admin IPs/CIDRs | `nginx/admin-allow.conf` | office/VPN/bastion |
| 14 | ACM certificate ARN(s) | API Gateway custom domains | must cover portal hosts |
| 15 | KMS key ARN | DynamoDB SSE + Secrets Manager | customer-managed key |
| 16 | Optional WAFv2 WebACL ARN | HttpApi stage | optional |
| 17 | TLS certificate/key for IONOS nginx | `certs/server.crt`, `certs/server.key` | must cover both Keycloak hostnames |
| 18 | Docker network CIDR for nginx → Keycloak | `KC_PROXY_TRUSTED_ADDRESSES` | inspect with `docker network inspect` |
| 19 | Public Keycloak URL resolvable from Lambda and browsers | `KC_PUBLIC_URL`, CloudFormation `KcPublicUrl` | `https://kc.gateway-vw.de:8443` |

Stop here if any of these is still a placeholder.

### Protocol implementation note

The Lambda BFF uses **`openid-client` 6.9.1** for the complete OIDC protocol:
discovery, authorization URL, PKCE code exchange, state/nonce checks and ID-token
validation including JWS signature verification against the realm JWKS
(`enableNonRepudiationChecks`). The public discovery URL is built from
`KC_PUBLIC_URL`, so that hostname must be reachable from Lambda as well as from
browsers. `jose` remains only for encrypted BFF cookies. `zod` is pinned to
4.6.7 because earlier versions had a high-severity DoS advisory.

Do **not** set `ALLOW_INSECURE_OIDC` or `INSECURE_COOKIES` in AWS. The backend
fails closed at cold start if either local-only escape hatch is present.

---

## 1. Generate encryption keys

```bash
cd impl-broker-bff
node ops/generate-keys.js
```

You need three independent 32-byte base64url keys:

- `SESSION_ENC_KEY_B64U` — portal session cookie JWE
- `TX_ENC_KEY_B64U` — short-lived OIDC transaction cookie
- `ENROLLED_ENC_KEY_B64U` — encrypted enrolment hint cookie

On first deploy, set each `*_PREVIOUS_*` key to the same value as its current
key. This is not a weakness: it only allows zero-downtime rotation. During
rotation, set `PREVIOUS=old`, `CURRENT=new`, deploy, wait one cookie TTL, then
clean up.

---

## 2. Fill the portal manifests

### 2.1 Deployment inventory

```bash
cp backend/ops/portals.example.json backend/ops/portals.json
$EDITOR backend/ops/portals.json
```

It must contain exactly 9 entries, no `*.example.org`, no `REPLACE_*`, unique
hosts, unique realms.

### 2.2 Lambda `PORTALS_JSON` secret

```bash
cp backend/ops/portal-secrets.example.json backend/ops/portal-secrets.json
$EDITOR backend/ops/portal-secrets.json
```

This file contains the real `clientSecret` for each portal BFF client. Do not
commit it. It is only an input to the Secrets Manager creation script.

---

## 3. Create AWS Secrets Manager secrets

The deployer identity needs `secretsmanager:GetSecretValue` and `kms:Decrypt`.

```bash
export AWS_REGION=eu-central-1
export KMS_KEY_ID='arn:aws:kms:...'                 # same customer-managed key
export SESSION_ENC_KEY_B64U='...'
export TX_ENC_KEY_B64U='...'
export ENROLLED_ENC_KEY_B64U='...'
export PORTALS_JSON_FILE="$PWD/backend/ops/portal-secrets.json"

bash backend/ops/create-secrets.example.sh
```

Created secrets:

```text
vw/passkey-bff/portals                       { "PORTALS_JSON": "<json>" }
vw/passkey-bff/session-enc-key               { "value": "<base64url>" }
vw/passkey-bff/session-enc-key-previous
vw/passkey-bff/tx-enc-key
vw/passkey-bff/tx-enc-key-previous
vw/passkey-bff/enrolled-enc-key
vw/passkey-bff/enrolled-enc-key-previous
```

The CloudFormation template resolves them with dynamic references, so plaintext
secrets never appear in your template, shell history, or source control.

---

## 4. Generate Keycloak realms and API domain commands

```bash
cd backend

export PORTALS_FILE="$PWD/ops/portals.json"
export VERIMI_AUTHORIZATION_URL='https://<real>/authorize'
export VERIMI_TOKEN_URL='https://<real>/token'
export VERIMI_USERINFO_URL='https://<real>/userinfo'
export VERIMI_JWKS_URL='https://<real>/jwks'
export VERIMI_ISSUER='https://<real>'
export VERIMI_CLIENT_ID='<real-client-id>'
export VERIMI_LOGOUT_URL='https://<real>/logout'   # omit if none

npm run ops:generate:realms
```

This writes `keycloak/generated/realm-*.json`. It also prints the vault file
names you must create.

```bash
export HTTP_API_ID='<from CloudFormation output after deploy>'
export INTEGRATION_ID='<from CloudFormation output after deploy>'
export ACM_CERTIFICATE_ARN='arn:aws:acm:...'
export API_STAGE_NAME='$default'
export HOSTED_ZONE_ID=''   # or your Route53 zone ID

npm run ops:generate:domains
```

This writes `backend/ops/generated/api-domains/deploy.sh` and
`verimi-redirect-uris.txt`.

---

## 5. Create Keycloak vault files

On the IONOS VPS, create the mounted vault directory from
`docker-compose.yml`:

```bash
mkdir -p keycloak/vault
chmod 700 keycloak/vault

# One file per realm, mode 600, content = secret only (no trailing commentary):
printf '%s' '<portal-spa client secret>' > keycloak/vault/vw-beav_portal-spa-secret
printf '%s' '<Verimi client secret>'     > keycloak/vault/vw-beav_verimi-client-secret
chmod 600 keycloak/vault/*
```

Repeat for all 9 realms. The generated realm JSON contains only
`${vault.<realm>_<name>}` references — never plaintext secrets.

---

## 6. Deploy the AWS BFF

```bash
cd backend
sam build
sam deploy --guided \
  --parameter-overrides \
    Phase=B \
    KcBaseUrl=https://kc.gateway-vw.de:8443 \
    KcPublicUrl=https://kc.gateway-vw.de:8443 \
    ExpectedPortalCount=9 \
    KmsKeyArn='arn:aws:kms:...' \
    WebAclArn='' \
    LogRetentionDays=30
```

If you do not use SAM, deploy `backend/template.yaml` directly with
CloudFormation.

Both `KcBaseUrl` and `KcPublicUrl` must be HTTPS in AWS. They are equal in the
current design. `KcPublicUrl` is used by `openid-client` discovery and therefore
must be DNS-resolvable from the Lambda VPC/network; `KcBaseUrl` is used for the
server-side Account API credential check.

Then apply the generated custom-domain mappings:

```bash
bash backend/ops/generated/api-domains/deploy.sh
```

Each portal must have:

```text
https://<portal-host>/api/*  -> HttpApi -> Lambda BFF
https://<portal-host>/*      -> React SPA static hosting
```

This same-origin `/api` mapping is required for the `__Host-` cookies.

---

## 7. Deploy Keycloak on IONOS

```bash
cd impl-broker-bff

# TLS cert must cover kc.gateway-vw.de and kc-admin.gateway-vw.de.
mkdir -p certs
cp /path/to/server.crt certs/server.crt
cp /path/to/server.key certs/server.key
chmod 600 certs/server.key

# Find the nginx→Keycloak Docker subnet, then set it in .env:
docker network inspect <project>_default \
  | grep -E '"Subnet"|"Gateway"'

cat > .env <<'EOF'
KC_DB_DATABASE=keycloak
KC_DB_USERNAME=keycloak
KC_DB_PASSWORD=<strong-random-password>
KC_BOOTSTRAP_ADMIN_USERNAME=<admin-user>
KC_BOOTSTRAP_ADMIN_PASSWORD=<strong-random-password>
KC_PROXY_TRUSTED_ADDRESSES=<docker-subnet-cidr>
KC_LOG_LEVEL=info
EOF
chmod 600 .env

# Add trusted networks only. Keep deny all as the default.
$EDITOR nginx/admin-allow.conf

docker compose down
docker compose up -d --build
```

The admin console is intentionally not public. From an untrusted IP,
`https://kc-admin.gateway-vw.de:8444/` must fail/403. This is correct.

---

## 8. Register the Verimi redirect URIs

For every realm, register this exact URI at Verimi:

```text
https://kc.gateway-vw.de:8443/realms/<realm>/broker/verimi/endpoint
```

The generated list is in:

```text
backend/ops/generated/api-domains/verimi-redirect-uris.txt
```

Do not use the portal callback URL here. Verimi talks to Keycloak, not to the
portal BFF.

---

## 9. Verification commands

### 9.1 Local checks

```bash
cd backend && npm test                 # 20 tests
cd ../frontend && npm run build:production
cd .. && SESSION_ENC_KEY_B64U=... TX_ENC_KEY_B64U=... ENROLLED_ENC_KEY_B64U=... \
  npm --prefix backend run ops:preflight
```

### 9.2 Keycloak public origin

```bash
curl -fsS https://kc.gateway-vw.de:8443/realms/vw-beav \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.realm,j.enabled)})'

curl -fsS https://kc.gateway-vw.de:8443/realms/vw-beav/protocol/openid-connect/certs \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log("keys",j.keys.length)})'
```

Expected: `vw-beav true` and at least one key.

### 9.3 Account API mapper

After a normal test login, the BFF log must not contain:

```text
account_api_denied
```

If it does, the access token lacks the `account` audience or `view-profile`
role. Fix Keycloak client scope/role mapping from `keycloak/README.md`.

### 9.4 Admin plane

```bash
curl -i --max-time 5 https://kc-admin.gateway-vw.de:8444/admin
```

From untrusted networks: 403/timeout/refused. From an allowlisted IP: admin
login page.

### 9.5 Full browser smoke test

1. `Mit Verimi anmelden` → Verimi page visible, Keycloak invisible.
2. `/api/me` → `passkeyEnrolled:false`.
3. `Passkey jetzt erstellen` → Keycloak WebAuthn page, QR/USB/biometric allowed.
4. After callback → `/api/me` → `passkeyEnrolled:true`.
5. `Mit Passkey anmelden` → no Verimi contact.
6. Logout → `/api/me` → `authenticated:false`.

---

## 10. Rotation and rollback

### Key rotation

1. Generate a new current key.
2. Set the matching `*_PREVIOUS_*` secret to the old value.
3. Update the current secret to the new value.
4. Redeploy the Lambda. Cookies sealed with the old key remain readable until
   their TTL expires.
5. After the TTL, keep or remove the previous value according to policy.

### Bad realm import

```bash
docker compose down
# restore the previous keycloak/generated and vault files
docker compose up -d --build
```

Realm state lives in Postgres; keep PITR/backups enabled on the VPS.

### Bad AWS deploy

CloudFormation rolls back the stack. Secrets Manager values are not deleted, so
redeploying with the previous stack configuration is safe.

---

## 11. Phase C — remove Verimi

Only after all users are enrolled and recovery is tested:

1. Set `Phase=C` in the CloudFormation parameter.
2. Redeploy the BFF. `method=verimi` now returns `403 verimi_disabled`.
3. Delete the `verimi` IdP and its mappers from all 9 realms.
4. Delete/rotate Verimi secrets and vault files.
5. Keep the account-audience mapper — the BFF still uses the Account API.
