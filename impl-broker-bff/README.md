# `impl-broker-bff` — Keycloak IdP broker + passkey bootstrap

Production-shaped implementation of the design in
[`../architecture_11-20-2026.md`](../architecture_11-20-2026.md).

**No Java. No Verimi code changes. No Keycloak Admin API in the user journey.**

| Piece | Stack |
|---|---|
| Frontend | React 18 + TypeScript + Vite |
| Backend | AWS Lambda, **Node.js 24**, ESM |
| IdP | Keycloak **26.8**, one realm per portal |
| Broker | Verimi as upstream OIDC Identity Provider |
| Credential store | Keycloak + Postgres (WebAuthn public keys) |
| Portal state | DynamoDB: user cache + revocable sessions |
| OIDC protocol | `openid-client` 6.9.1 (discovery, authorize, code grant, ID token/JWS validation) |
| Crypto | `jose` (encrypted cookies), Node `crypto`, `cookie`, `zod` |
| Secrets | AWS Secrets Manager dynamic references |
| Deployment | SAM/CloudFormation + API Gateway custom domains |

---

## 1. Is the task reasonable?

**Yes.** Keycloak does identity brokering and WebAuthn/passkeys natively. The
only change in Verimi's world is the `redirect_uri` registered for each realm.
One rule drives the whole design:

```text
A passkey can only be created in an already authenticated browser session.
⇒ Verimi must authenticate every user once.
⇒ After enrolment, Verimi is bypassed.
⇒ After 2026-12-31, the Verimi IdP is deleted.
```

---

## 2. Quickstart — unit tests and local API

```bash
cd backend
npm install
npm test            # 20 tests; no AWS, Keycloak, or network needed

cp ../ops/env.example .env
node ../ops/generate-keys.js   # paste the THREE keys into .env
# For local emulation also set:
#   KC_BASE_URL=http://localhost:8443
#   KC_PUBLIC_URL=http://localhost:8443
#   PORTALS_JSON={"vw-baev.de":{... "redirectUri":"http://localhost:5173/api/auth/callback"}}
#   STORE=memory
#   INSECURE_COOKIES=true
#   DEV_PORTAL_HOST=vw-baev.de
npm run start:emulated

cd ../frontend
npm install
npm run dev:emulated   # http://localhost:5173
```

Production frontend build is guarded:

```bash
npm run build:production
# refuses to build if the Keycloak origin is not https://kc.gateway-vw.de:8443
```

---

## 3. Full local emulation (recommended)

This simulates the real topology without Docker/Java:

```text
Portal SPA     :5173
BFF            :3001  (via Vite /api proxy)
public nginx   :8443  -> Keycloak mock :8080
admin  nginx   :8444  -> IP allow/deny -> Keycloak mock :8080
Verimi mock    :3443  (separate external origin)
Postgres mock  :55432 (JSON state store)
```

```bash
# Terminal 1
cd impl-broker-bff/mock-vps && npm run start:emulated

# Terminal 2
cd impl-broker-bff/backend && npm run start:emulated

# Terminal 3
cd impl-broker-bff/frontend && npm run dev:emulated
```

Open `http://localhost:5173`. Reset state with:

```bash
curl http://localhost:8443/mock/reset
```

Admin-plane test:

```bash
curl -i -H 'X-Mock-Remote-IP: 8.8.8.8' http://localhost:8444/admin      # 403
curl -i -H 'X-Mock-Remote-IP: 127.0.0.1' http://localhost:8444/admin    # 200
```

Details: [`mock-vps/emulated/EMULATED.md`](mock-vps/emulated/EMULATED.md).

---

## 4. Who calls whom — exact endpoints

### 4.1 Verimi bootstrap login (steps 1–7)

```text
1. Browser  → React       click "Mit Verimi anmelden"
2. React    → BFF         GET /api/auth/login?method=verimi
3. BFF      → Browser     200 {authorizationUrl} (built by openid-client after discovery)
                          Set-Cookie __Host-pk_tx=<JWE(state,nonce,verifier,flow)>
4. Browser  → Keycloak    GET /realms/vw-beav/protocol/openid-connect/auth
                            ?client_id=portal-spa
                            &redirect_uri=https://vw-baev.de/api/auth/callback
                            &response_type=code&scope=openid profile email roles
                            &state=...&nonce=...
                            &code_challenge=...&code_challenge_method=S256
                            &kc_idp_hint=verimi
5. Keycloak → Verimi      302 {authorizationUrl} (Verimi code unchanged)
6. Verimi   → Keycloak    302 /realms/vw-beav/broker/verimi/endpoint?code=...
7. Keycloak → BFF         302 https://vw-baev.de/api/auth/callback?code=...&state=...
8. BFF      → Keycloak    POST /realms/vw-beav/protocol/openid-connect/token (openid-client)
9. BFF      → Keycloak    discovery + JWKS via openid-client (cached; JWS signature checked)
10. BFF     → Keycloak    GET /realms/vw-beav/account/credentials?type=webauthn-passwordless
11. BFF     → DynamoDB    link sub ↔ verimi_sub, store enrolment flag, create session
12. BFF     → Browser     302 /?login=success + Set-Cookie __Host-pksid=<JWE>
```

The browser only sees the Verimi page. Keycloak's redirect happens in the
background because `kc_idp_hint=verimi` is set.

### 4.2 Passkey enrolment (steps 8–10)

```text
1. SPA      → BFF         GET /api/me → passkeyEnrolled:false → banner
2. User clicks "Passkey jetzt erstellen"
3. SPA      → BFF         GET /api/auth/enroll (requires __Host-pksid)
4. BFF      → Browser     authorizationUrl with
                            kc_action=webauthn-register-passwordless:skip_if_exists
                            NO kc_idp_hint
5. Browser  ↔ Keycloak    WebAuthn ceremony on kc.gateway-vw.de origin
                            RP ID = gateway-vw.de
6. Keycloak → Postgres    stores public key
7. Keycloak → BFF         302 /api/auth/callback?code&state&kc_action_status=...
8. BFF ignores kc_action_status; asks Keycloak Account API for the real credential
9. BFF      → Browser     302 /?passkey=created + __Host-pk_enrolled=<JWE>
```

### 4.3 Passkey login (step 11)

```text
Browser → BFF  GET /api/auth/login?method=passkey
BFF     → Browser authorizationUrl WITHOUT kc_idp_hint and WITHOUT kc_action
Browser → Keycloak normal login form with passkeys enabled
Browser ↔ Authenticator WebAuthn get()
Keycloak → BFF callback → new session cookie
Verimi is never contacted.
```

---

## 5. File map

```text
backend/src/config.js            fail-closed zod env validation; 9 portals required
backend/src/crypto.js            jose JWE, CSPRNG, timing-safe compare
backend/src/cookies.js           __Host- cookies via `cookie`
backend/src/http.js              response helpers, requestContext.domainName allowlist
backend/src/oidc.js              openid-client OIDC protocol + Account API
backend/src/store.js             DynamoDB user cache + revocable sessions
backend/src/session.js           JWE session/tx/enrolled readers, revocation
backend/src/handlers/*.js        login / enroll / callback / me / logout
backend/src/router.js            API Gateway v2 router, /api normalization
backend/src/handler.js           Lambda entry
backend/src/local-server.js      local dev
backend/tests/flow.test.js       21 tests (incl. JWS/nonce rejection)
backend/template.yaml            production SAM/CloudFormation
backend/ops/portals.example.json portal inventory template
backend/ops/portals.json         real inventory (fill before deploy)
backend/ops/portal-secrets.example.json
backend/ops/create-secrets.example.sh
backend/ops/generate-realms.js
backend/ops/generate-api-domains.js
backend/ops/preflight.js
backend/ops/verify-keycloak.sh
frontend/...                     React SPA + CSP + production origin guard
keycloak/realm-template.json     generated realm source
keycloak/realm-vw-beav.json      example realm with Verimi placeholders
keycloak/docker/Dockerfile       Keycloak with file-vault provider
docker-compose.yml               prod nginx/Keycloak/Postgres topology
nginx/...                        public/admin vhosts, rate limits, allowlist
PRODUCTION.md                    full deployment runbook
```

---

## 6. Production deployment

Do not deploy from this README alone. Use
[`PRODUCTION.md`](PRODUCTION.md). Short version:

```bash
# 1. Fill real inputs and secrets
$EDITOR backend/ops/portals.json
$EDITOR backend/ops/portal-secrets.json
node ops/generate-keys.js
bash backend/ops/create-secrets.example.sh

# 2. Generate realms and API custom-domain commands
npm --prefix backend run ops:generate:realms
npm --prefix backend run ops:generate:domains

# 3. Deploy AWS
cd backend && sam build && sam deploy --guided

# 4. Deploy IONOS
cd ..
docker compose up -d --build

# 5. Verify
npm --prefix backend test
npm --prefix frontend run build:production
npm --prefix backend run ops:preflight
bash backend/ops/verify-keycloak.sh
```

CloudFormation uses dynamic references only:

```text
vw/passkey-bff/portals
vw/passkey-bff/session-enc-key
vw/passkey-bff/tx-enc-key
vw/passkey-bff/enrolled-enc-key
… and their -previous counterparts
```

`kc-admin.gateway-vw.de:8444` must stay restricted to trusted office/VPN/bastion
IPs. The nginx config fails closed with `deny all`; the allow file is
`nginx/admin-allow.conf`.

---

## 7. Security checklist

- [x] `state` from encrypted cookie, compared with `timingSafeEqual`
- [x] PKCE `S256` via `openid-client`; verifier never leaves the encrypted cookie
- [x] ID token validated by `openid-client`: state, nonce, `iss`, `aud`, `azp`, `exp`, JWS signature against JWKS
- [x] `KC_PUBLIC_URL` used for discovery, browser URLs and issuer; `KC_BASE_URL` only for Account API calls
- [x] `kc_action_status` not trusted — Account API is authoritative
- [x] Three independent JWE keys with rotation support
- [x] Cookies: `HttpOnly`, `Secure`, `SameSite=Lax`, `__Host-`, no `Domain`
- [x] `requestContext.domainName` is authoritative in AWS; no Host-header tricks
- [x] Revocable sessions in DynamoDB with TTL
- [x] No admin credentials, no impersonation, no Java
- [x] Secrets Manager dynamic references; no plaintext secrets in git/template
- [x] Nginx default servers return 444; admin vhost denies by default
- [x] Security headers, CSP, HSTS `includeSubDomains`
- [x] Fail closed at cold start on bad keys, wrong portal count, insecure cookies in AWS
- [x] Structured logs without tokens, codes, verifiers, or cookies

---

## 8. Open tasks

See [`../architecture_11-20-2026.md`](../architecture_11-20-2026.md) §7 and
[`PRODUCTION.md`](PRODUCTION.md) §0. Highest priority:

1. Replace all placeholders with your real Verimi metadata and 9 portal domains.
2. Enrolment coverage dashboard before 2026-12-31.
3. Test real WebAuthn on the production Keycloak origin.
4. Test recovery for users who never enrol.
5. Phase C runbook after cutoff.
