# Production implementation: Keycloak IdP broker + passkey bootstrap

**Date:** 2026-11-22
**Folder:** `impl-passkey-prod/`
**Architecture rationale:** [`../architecture_11-22-2026.md`](../architecture_11-22-2026.md) (also copied as [`architecture_11-22-2026.md`](./architecture_11-22-2026.md))

**Stack:** React + Vite (TypeScript) · AWS Lambda Node.js 24 BFF · API Gateway HTTP API · DynamoDB · Secrets Manager · Keycloak 26.8 + nginx + PostgreSQL on IONOS · Verimi as temporary upstream OIDC IdP

---

## 0. Evaluation: reasonable? Yes.

Keycloak already implements OIDC brokering and WebAuthn/passkeys. No Java, no Verimi code change, no hand-written crypto. The only Verimi-side action is registering the broker redirect URI:

```text
https://kc.gateway-vw.de:8443/realms/<realm>/broker/verimi/endpoint
```

Two honest limits (details in the architecture document):

1. The browser really navigates to `kc.gateway-vw.de:8443`. You can hide branding and parameters, not the hostname.
2. The Keycloak SSO cookie and the portal session cookie are different cookies on different domains. Enrolment works because the same browser holds both; if SSO expired, Keycloak re-authenticates and the requested passkey action still runs.

**No mocks, no emulators, no fake IdP, no self-signed certificates.** Every component talks to a real endpoint.

---

## 1. File map

```text
impl-passkey-prod/
├── README.md                         ← this file
├── architecture_11-22-2026.md        ← architecture (copy)
├── production-inputs/                ← real-value templates + validator (no mocks)
│   ├── README.md                     ← fill/copy checklist
│   └── validate-inputs.js            ← fail-closed local validation
├── frontend/                         ← React SPA
│   ├── src/api.ts / config.ts / types.ts / App.tsx / main.tsx / styles.css
│   ├── src/components/LoginPanel.tsx / PasskeyBanner.tsx / StatusMessage.tsx
│   ├── scripts/verify-env.js         ← production build guard
│   └── .env.example
├── backend/                          ← AWS Lambda BFF
│   ├── template.yaml                 ← SAM: Lambda, HTTP API, DynamoDB, IAM, WAF hook
│   ├── src/
│   │   ├── handler.js                ← Lambda entry (payload 2.0)
│   │   ├── router.js                 ← normalizes /api/... and base-path-mapped routes
│   │   ├── config.js                 ← zod fail-closed config for 9 portals
│   │   ├── http.js                   ← host allowlist, CORS, responses
│   │   ├── crypto.js                 ← jose JWE (A256GCM), CSPRNG, timing-safe compare
│   │   ├── cookies.js                ← __Host- cookies
│   │   ├── secrets.js                ← Secrets Manager with warm cache
│   │   ├── oidc.js                   ← openid-client v6: discovery, PKCE, code grant, JWKS
│   │   ├── session.js                ← encrypted tx/session cookies + revocation lookup
│   │   ├── store.js                  ← DynamoDB identity + sessions
│   │   └── handlers/                 ← login · callback · enroll · me · logout
│   ├── tests/production.test.js      ← real crypto/config/routing tests, no mocks
│   └── ops/                          ← portal manifest, secrets, preflight, domain generation
└── vps/                              ← IONOS Docker deployment
    ├── docker-compose.yml            ← nginx :8443/:8444, Keycloak, PostgreSQL
    ├── keycloak/realm-template.json  ← Verimi broker + WebAuthn/passkey policy
    ├── keycloak/docker/Dockerfile    ← Keycloak 26.8 + vault + `vw` theme
    ├── keycloak/theme/vw/            ← white-label German login theme
    ├── nginx/                        ← TLS, proxy headers, admin IP allowlist
    ├── ops/generate-realms.js        ← real Admin REST provisioning for all realms
    └── scripts/                      ← deploy, verify, install-certs
```

---

## 2. DDD domains

| Context | Code | Rule |
|---|---|---|
| Portal experience | `frontend/` | No tokens, no secrets, no protocol logic |
| Identity brokering + session | `backend/` | Owns OIDC, cookies, revocation, enrolment gate |
| Identity authority | `vps/keycloak/` | Owns credentials, Verimi link, WebAuthn ceremony |
| Portal identity cache | DynamoDB `identity` | `realm:sub` → email, passkey flag |
| Session/revocation | DynamoDB `sessions` | Instant kill switch behind the encrypted cookie |
| Platform | nginx/AWS | TLS, IP allowlist, scaling |

---

## 3. Who calls whom (steps 1–11)

```text
[1]  User clicks "Mit Verimi anmelden" (or "Mit Passkey anmelden")
[2]  SPA → GET https://api.<portal>/api/auth/login?method=verimi
     Lambda → Set-Cookie __Host-pk_tx=JWE(state,nonce,PKCE verifier)
     Lambda → 200 { authorizationUrl }
[3]  SPA → window.location.assign(validated authorizationUrl) → Keycloak /authorize
[4]  Keycloak → 302 Verimi /authorize (because kc_idp_hint=verimi)
[5]  User authenticates at Verimi
[6]  Verimi → 302 Keycloak /broker/verimi/endpoint?code=...
[7]  Keycloak → 302 https://api.<portal>/api/auth/callback?code&state
     Lambda → POST /realms/<realm>/protocol/openid-connect/token (client_secret_basic + PKCE)
     Lambda → GET  /realms/<realm>/account/credentials (user's access token)
     Lambda → DynamoDB: record login + create session
     Lambda → 302 https://<portal>/?login=success + __Host-pksid
[8]  SPA → GET /api/me → { authenticated:true, passkeyEnrolled:false } → banner
[9]  User clicks "Passkey erstellen"
     SPA → GET /api/auth/enroll (requires valid session)
     Lambda → URL with kc_action=webauthn-register-passwordless:skip_if_exists, NO kc_idp_hint
     Lambda → tx cookie stores expectedId = realm:sub of the session
[10] Browser ↔ Keycloak WebAuthn ceremony (RP ID gateway-vw.de)
     Keycloak → 302 /api/auth/callback
     Lambda IGNORES kc_action_status, asks Account API, binds sub to expectedId,
     sets passkeyEnrolled=true, redirects /?passkey=created
[11] Next login with method=passkey → no kc_idp_hint → Verimi is never contacted.
```

**BFF endpoints (API Gateway custom domain maps `/api` → Lambda):**

| Route | Auth | Purpose |
|---|---|---|
| `GET /api/auth/login?method=verimi\|passkey\|auto` | none | Start OIDC transaction, returns authorize URL |
| `GET /api/auth/callback?code&state` | `__Host-pk_tx` | Validate + exchange + create session |
| `GET /api/auth/enroll` | `__Host-pksid` | Start passkey AIA for the current user |
| `GET /api/me` | `__Host-pksid` | `{authenticated, passkeyEnrolled, email}` |
| `GET /api/auth/logout` | `__Host-pksid` | Revoke session + Keycloak logout |
| `GET /health` | none | Liveness only |

---

## 4. Security design (short version)

- `openid-client` does discovery, PKCE S256, state/nonce, JWKS signature and claim validation.
- `jose` does cookie encryption (JWE `dir`+`A256GCM`); Node CSPRNG for all random values; `timingSafeEqual` for state.
- Tokens and client secret never enter the browser. Browser has only encrypted, `HttpOnly`, `Secure`, `SameSite=Lax`, `__Host-` cookies.
- Enrolment binds the expected `realm:sub`; callback aborts on mismatch.
- `kc_action_status` is **never** trusted. The Account REST API with the user's token is authoritative; an unavailable check keeps the last known state.
- Host allowlist ties each request to exactly one portal; redirect URI is verified at config load and in preflight.
- Admin console is on a separate hostname with `deny all` default IP filter.
- Full threat model in [`../architecture_11-22-2026.md`](../architecture_11-22-2026.md) §4.

---

## 5. Deploy (real commands)

### 5.1 VPS first

```bash
cd vps
cp .env.example .env && editor .env
# install real TLS certs, edit nginx/admin-allow.conf
bash scripts/deploy.sh
cp ../backend/ops/portals.example.json ../backend/ops/portals.json   # fill all 9 REAL hosts
cp verimi.example.json verimi.json && editor verimi.json             # REAL Verimi values
KC_ADMIN_URL=https://kc-admin.gateway-vw.de:8444 \
VPS_PORTALS_FILE=../backend/ops/portals.json VPS_VERIMI_FILE=./verimi.json \
KC_ADMIN_USERNAME=<admin> KC_ADMIN_PASSWORD=<password> \
node ops/generate-realms.js
bash scripts/verify.sh
```

### 5.2 AWS secrets and custom domains

```bash
cd ../backend
cp ops/portals.example.json ops/portals.json && editor ops/portals.json
cp ops/domains.example.json ops/domains.json && editor ops/domains.json
# after realm provisioning:
bash ops/create-secrets.example.sh

# generate keys (real CSPRNG)
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"

sam deploy --guided --template-file template.yaml \
  --parameter-overrides \
    Stage=prod TableSuffix=prod \
    PortalConfigJson="$(cat ops/portals.json)" \
    SecretsSecretArn=<ARN from Secrets Manager> \
    EncryptionKeysJson='{"2026-11":"<32-byte-base64url-key>"}' \
    ActiveKeyId=2026-11 \
    KcPublicUrl=https://kc.gateway-vw.de:8443

# then deploy ops/generated/api-domains.yaml with the HttpApiId output
AWS_REGION=eu-central-1 node ops/generate-api-domains.js
aws cloudformation deploy --template-file ops/generated/api-domains.yaml \
  --stack-name vw-api-domains --parameter-overrides HttpApiId=<output>
```

### 5.3 Frontend

```bash
cd ../frontend
cp .env.example .env
# VITE_API_BASE=https://api.vw-baev.de/api per portal build (or /api if same origin)
npm ci
npm run build
# upload dist/ to the portal's static hosting / CDN
```

### 5.4 Verify locally without mocks

```bash
cd backend && npm ci && npm test        # 8 tests, no network/AWS
cd ../frontend && npm ci && npm run build
```

Real end-to-end verification means using the deployed Keycloak and Verimi tenants.
The preflight script calls the real discovery endpoints of all 9 realms:

```bash
cd backend
PORTALS_FILE=ops/portals.json KC_PUBLIC_URL=https://kc.gateway-vw.de:8443 \
  node ops/preflight.js --with-secrets --secret-id <SECRET_ID>
```

---

## 6. What you must supply (not mocks)

Use [`production-inputs/README.md`](./production-inputs/README.md). It contains copy/paste templates for:

1. The 9 real portal hostnames / API hostnames / realm names.
2. Verimi's real OIDC metadata, client ID and secret, plus the generated list of 9 broker redirect URIs to register at Verimi.
3. Real TLS certificates for both Keycloak hostnames.
4. Your admin IP allowlist.
5. Real AES-256 cookie key, table suffix, Secrets Manager ARN, ACM certificate ARNs and Route53 zone IDs.

Validate locally before deployment:

```bash
node production-inputs/validate-inputs.js
```

Until those files are filled, the validator and deployment scripts intentionally fail — by design, so nothing "works" against a fake endpoint.

---

## 7. After Verimi shuts down

1. Set `verimiEnabled:false` for all portals in `ops/portals.json`.
2. Set `VITE_VERIMI_AVAILABLE=false` in frontend builds (hides the Verimi button).
3. Re-run `vps/ops/generate-realms.js` (empties the broker in all realms).
4. Optionally delete the Verimi OIDC client at Verimi (their shutdown makes this moot).

Nothing in `backend/src/` changes; passkey login never used the broker.
