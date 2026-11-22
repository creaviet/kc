# Production implementation: Keycloak IdP broker + passkey bootstrap

**Date:** 2026-11-21  
**Folder:** `impl-broker-production`  
**Runtime:** React frontend, AWS Lambda Node.js 24 BFF, Keycloak 26.8 on IONOS VPS, PostgreSQL, DynamoDB

---

## 0. Evaluation: is the task reasonable?

Yes — technically and architecturally this is a sound migration path.

Keycloak already provides the two capabilities you need:

1. **OIDC identity brokering** toward Verimi. Keycloak is the OIDC Relying Party
   toward Verimi; Verimi is the upstream IdP. No Verimi code change is needed.
2. **WebAuthn/passkey passwordless authentication** on the Keycloak origin. No
   Java extension is needed: realm import + theme + standard WebAuthn policy is
   enough.

The right application pattern is a **Backend-for-Frontend (BFF)**:

```text
React SPA  →  same-origin /api/*  →  API Gateway  →  Lambda BFF  →  Keycloak
```

The SPA never sees tokens, `client_secret`, `state`, `nonce`, or the PKCE
verifier. Those live in encrypted `HttpOnly` cookies and Lambda memory.

### One honest limitation

You asked that the user “shouldn't notice Keycloak”. That is possible only at
the **branding/UX** level, not at the **protocol/network** level.

OIDC and WebAuthn require real top-level browser redirects to:

```text
https://kc.gateway-vw.de:8443
```

You cannot put this in an iframe because:

- third-party cookies are blocked,
- WebAuthn requires the correct origin and user presence,
- Keycloak sends anti-framing headers,
- OIDC `redirect_uri` validation requires real top-level navigation.

Therefore this implementation uses a white-label Keycloak theme (`vw`) so the
redirect looks like your portal. The redirects themselves remain real.

---

## 1. What is implemented

```text
impl-broker-production/
├── README.md                         # this file
├── architecture_11-21-2026.md        # architecture + C4 + design rationale
├── docker-compose.yml                # nginx + Keycloak + PostgreSQL
├── certs/                            # TLS material (gitignored)
├── keycloak/
│   ├── README.md                     # realm import, vault, passkeys, Phase C
│   ├── realm-template.json           # Verimi broker + passkey policy
│   ├── docker/Dockerfile             # Keycloak with file vault enabled
│   ├── generated/                    # generated realms (gitignored)
│   ├── vault/                        # realm secrets (gitignored)
│   └── theme/vw/login/               # white-label login theme
├── nginx/
│   ├── README.md
│   ├── nginx.conf
│   ├── admin-allow.conf              # IP allowlist (fill before deploy)
│   ├── conf.d/
│   │   ├── 10-keycloak-public.conf
│   │   └── 20-keycloak-admin.conf
│   └── snippets/keycloak-proxy.conf
├── backend/
│   ├── template.yaml                 # SAM: Lambda, API Gateway, DynamoDB, WAF hook
│   ├── package.json
│   ├── src/
│   │   ├── handler.js                # Lambda entry point
│   │   ├── router.js                 # /auth/login, /auth/callback, /auth/enroll, /me, /auth/logout
│   │   ├── config.js                 # fail-closed production config
│   │   ├── cookies.js                # __Host- cookies via `cookie`
│   │   ├── crypto.js                 # JWE via `jose`, CSPRNG via node:crypto
│   │   ├── oidc.js                   # OIDC via `openid-client`
│   │   ├── http.js                   # host binding + callback URL reconstruction
│   │   ├── session.js                # encrypted cookie readers/writers
│   │   ├── store.js                  # DynamoDB identity cache + revocable sessions
│   │   └── handlers/
│   │       ├── login.js
│   │       ├── callback.js
│   │       ├── enroll.js
│   │       ├── me.js
│   │       └── logout.js
│   ├── tests/production.test.js      # no network, no mocks
│   └── ops/                          # portal manifests, generation, preflight, secrets
└── frontend/
    ├── index.html
    ├── vite.config.ts                # hard-pinned production Keycloak origin
    ├── src/
    │   ├── api.ts                    # fetch('/api/...', credentials: include)
    │   ├── config.ts                 # authorization URL origin allowlist
    │   ├── App.tsx                   # login/logout/passkey banner state
    │   └── components/
    │       ├── LoginPanel.tsx
    │       ├── PasskeyBanner.tsx
    │       └── StatusMessage.tsx
    └── dist/                         # build output (gitignored)
```

There is **no** `mock-vps/`, no `.env.mock`, no `.env.emulated`, no local server,
no emulator, no dev proxy, and no prebuilt `dist` shipped in this folder.

---

## 2. Domains (DDD view)

| Bounded context | Owner | Responsibility |
|---|---|---|
| Portal experience | React app | Show login/passkey buttons; display status |
| Auth brokering | Lambda BFF | OIDC transactions, PKCE, callback validation, session cookies |
| Identity authority | Keycloak | Verimi brokering, users, SSO, WebAuthn credentials |
| Portal identity cache | DynamoDB | `kcSub` ↔ portal mapping, enrolment campaign flag |
| Session/revocation | DynamoDB + BFF | Revocable portal sessions |
| Infrastructure | AWS + IONOS VPS | API Gateway, Lambda, nginx, TLS, Postgres |

The important boundary:

```text
Keycloak owns credentials.
The portal owns the application session.
The SPA owns neither.
```

---

## 3. Exact click-to-callback flow

### Steps 1–7: Verimi login

```text
User clicks "Mit Verimi anmelden"
  │
  │ LoginPanel.tsx
  │ startLogin('verimi')
  ▼
GET https://vw-baev.de/api/auth/login?method=verimi
  │
  │ API Gateway custom domain, base path /api
  ▼
Lambda: src/handlers/login.js
  │
  │ createOidcTransaction()
  │   state   = randomBytes(32)
  │   nonce   = randomBytes(32)
  │   verifier= openid-client randomPKCECodeVerifier()
  │
  │ seal() → JWE → Set-Cookie __Host-pk_tx
  │ createAuthorizationUrl()
  │   kc_idp_hint=verimi
  │   code_challenge=S256(verifier)
  ▼
HTTP 200
{ "authorizationUrl": "https://kc.gateway-vw.de:8443/realms/vw-beav/protocol/openid-connect/auth?..." }
  │
  │ LoginPanel.tsx validates origin
  │ window.location.assign(authorizationUrl)
  ▼
Browser → Keycloak /protocol/openid-connect/auth
  │
  │ Keycloak sees kc_idp_hint=verimi
  ▼
302 → Verimi /authorize
  │
  │ User types credentials at Verimi
  ▼
302 → Keycloak /broker/verimi/endpoint
  │
  │ Keycloak provisions/links user, creates SSO session
  ▼
302 → https://vw-baev.de/api/auth/callback?code=...&state=...
```

### Steps 7–8: Lambda finishes login

```text
GET /api/auth/callback?code=...&state=...
  │
  ▼
Lambda: src/handlers/callback.js
  │
  ├─ read __Host-pk_tx
  ├─ safeEqual(tx.state, query.state)
  ├─ for enrol: require session.sub === tx.sub
  ├─ openid-client authorizationCodeGrant()
  │    - PKCE verifier
  │    - expected nonce
  │    - JWKS signature
  │    - iss/aud/exp/azp
  ├─ Keycloak Account API credential check
  ├─ DynamoDB linkUser() / setPasskeyVerified()
  ├─ createSession() → revocable session record
  └─ Set-Cookie:
       __Host-pksid=<encrypted session>
       __Host-pk_enrolled=<encrypted hint>   (only if passkey exists)
  │
  ▼
302 Location: /?login=success
```

### Steps 9–11: passkey enrolment

```text
React: GET /api/me
  → { authenticated: true, passkeyEnrolled: false }
  → shows PasskeyBanner

User clicks "Passkey jetzt erstellen"
  │
  │ startEnrolment()
  ▼
GET https://vw-baev.de/api/auth/enroll
  │
  │ Requires valid __Host-pksid session
  │ Creates new tx with flow='enroll', sub=session.sub
  ▼
{ "authorizationUrl": "...&kc_action=webauthn-register-passwordless:skip_if_exists" }
  │
  ▼
Browser → Keycloak
  │
  │ Keycloak SSO cookie already exists
  │ No Verimi contact
  │ Keycloak renders QR/USB/biometric WebAuthn UI on kc.gateway-vw.de:8443
  ▼
Browser → /api/auth/callback
  │
  ├─ BFF re-checks sub binding
  ├─ exchanges code
  └─ verifies credential via Account API
  ▼
302 /?login=success&passkey=created
```

Afterwards, choosing “Mit Passkey anmelden” starts a normal OIDC login **without**
`kc_idp_hint`. Keycloak's passkey login runs on its own origin.

---

## 4. Frontend code

### `frontend/src/api.ts`

```ts
async function get<T>(path: string): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: 'GET',
    credentials: 'include', // sends HttpOnly __Host- cookies
    headers: { accept: 'application/json' },
    cache: 'no-store',
  });
  return (await response.json()) as T;
}

export const startLogin = (method: LoginMethod = 'auto') =>
  get<AuthorizationUrlResponse>(`/auth/login?method=${encodeURIComponent(method)}`);

export const startEnrolment = () =>
  get<AuthorizationUrlResponse>('/auth/enroll');
```

The SPA calls only relative paths. Therefore:

```text
vw-baev.de       → https://vw-baev.de/api/...
ltkv.de          → https://ltkv.de/api/...
```

No CORS, no token in JavaScript, no client secret in the browser.

### `frontend/src/components/LoginPanel.tsx`

```ts
const { authorizationUrl } = await startLogin(method);
const target = toKeycloakAuthorizationUrl(authorizationUrl);
window.location.assign(target.toString());
```

`toKeycloakAuthorizationUrl()` rejects anything except:

```text
origin: https://kc.gateway-vw.de:8443
path:   contains /protocol/openid-connect/auth
```

This prevents a compromised backend response from redirecting the browser to a
fake login page.

### `frontend/src/components/PasskeyBanner.tsx`

The banner is only shown when:

```ts
me.authenticated === true && me.passkeyEnrolled === false
```

Clicking it calls `/api/auth/enroll`; the WebAuthn UI itself is Keycloak's.

---

## 5. Backend code

### Lambda entry point

`backend/src/handler.js`:

```js
export const handler = async (event, context) => route(event, context);
```

API Gateway invokes `src/handler.handler` with an HTTP API v2 event.

### Router

`backend/src/router.js`:

```text
GET /auth/login     → handlers/login.js
GET /auth/enroll    → handlers/enroll.js
GET /auth/callback  → handlers/callback.js
GET /auth/logout    → handlers/logout.js
GET /me             → handlers/me.js
```

It normalizes `/api/auth/login` and `/auth/login` to the same route.

### OIDC transaction

`backend/src/oidc.js`:

```js
export function createOidcTransaction(extra = {}) {
  return {
    state: randomToken(32),
    nonce: randomToken(32),
    verifier: client.randomPKCECodeVerifier(),
    ...extra,
  };
}
```

The values are sealed with `jose` into `__Host-pk_tx`:

```text
HttpOnly
Secure
SameSite=Lax
Path=/
no Domain
```

### Callback validation

`backend/src/handlers/callback.js` is the security choke point. It never trusts
`kc_action_status`; enrolment is proven by Keycloak Account API:

```http
GET /realms/{realm}/account/credentials?type=webauthn-passwordless
Authorization: Bearer <user access token>
```

### Callback URL subtlety

API Gateway strips the `/api` base path. `openid-client` uses the current URL as
`redirect_uri` in the token request. Therefore `backend/src/http.js` rebuilds:

```text
event rawPath: /auth/callback
public URL:    https://vw-baev.de/api/auth/callback
```

This must match the `redirectUris` in Keycloak exactly.

---

## 6. Security libraries

| Job | Library | Why |
|---|---|---|
| OIDC discovery, authorize URL, token exchange, PKCE, JWT verification | `openid-client` | Maintained server-side OIDC library; avoids hand-rolled protocol logic |
| Cookie encryption/authentication | `jose` (`EncryptJWT`, `jwtDecrypt`) | AES-GCM JWE, audited JOSE implementation |
| CSPRNG + constant-time compare | `node:crypto` | Platform CSPRNG and `timingSafeEqual` |
| Cookie serialization/parsing | `cookie` | Correct escaping and attributes |
| Config validation | `zod` | Fail-closed schema validation |
| AWS persistence | `@aws-sdk/*` | Official DynamoDB clients |
| React types/build | TypeScript + Vite | Compile-time safety and deterministic production build |

No custom cryptography and no hand-rolled OIDC.

---

## 7. Robustness and scalability

- Lambda is stateless; all state is in encrypted cookies or DynamoDB.
- OIDC discovery config is cached per realm/client for 10 minutes.
- Session records are in DynamoDB with TTL; sessions can be revoked.
- Portal state write failures do not block a valid Keycloak login.
- Account API unavailability does not guess enrolment; it keeps the last known state.
- API Gateway throttling and optional WAF association are in `template.yaml`.
- DynamoDB is on-demand; 9 realms and millions of users do not require a fixed capacity plan.
- One Lambda handles all portals; portal is selected by API Gateway `domainName`, never by a browser header.

---

## 8. Deployment checklist

```bash
cd /home/think/Dev/ai/ideas/Projects/keycloak-passkey-3/impl-broker-production

# 1. Fill manifests
cp backend/ops/portals.example.json backend/ops/portals.json
# edit all 9 real portal hosts/realms/display names

cp backend/ops/portal-secrets.example.json backend/ops/portal-secrets.json
# fill real client secrets

# 2. Generate three 256-bit keys
node -e "const c=require('node:crypto');for(const n of ['SESSION','TX','ENROLLED'])console.log(n+'_ENC_KEY_B64U='+c.randomBytes(32).toString('base64url'))"

# 3. Create Secrets Manager entries
SESSION_ENC_KEY_B64U=... TX_ENC_KEY_B64U=... ENROLLED_ENC_KEY_B64U=... \
PORTALS_JSON_FILE="$PWD/backend/ops/portal-secrets.json" \
bash backend/ops/create-secrets.example.sh

# 4. Deploy BFF
aws cloudformation deploy \
  --stack-name vw-passkey-bff \
  --template-file backend/template.yaml \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides KmsKeyArn=arn:aws:kms:... WebAclArn=optional

# 5. Generate API Gateway custom-domain commands
HTTP_API_ID=... INTEGRATION_ID=... ACM_CERTIFICATE_ARN=... \
npm --prefix backend run ops:generate:domains

# 6. Generate realms and vault files
PORTALS_FILE="$PWD/backend/ops/portals.json" \
VERIMI_AUTHORIZATION_URL=... VERIMI_TOKEN_URL=... VERIMI_USERINFO_URL=... \
VERIMI_JWKS_URL=... VERIMI_ISSUER=... VERIMI_CLIENT_ID=... \
npm --prefix backend run ops:generate:realms

# 7. Start Keycloak stack
docker compose up -d --build

# 8. Verify + preflight
PORTALS_FILE="$PWD/backend/ops/portals.json" \
SESSION_ENC_KEY_B64U=... TX_ENC_KEY_B64U=... ENROLLED_ENC_KEY_B64U=... \
npm --prefix backend run ops:preflight

KC_PUBLIC_URL=https://kc.gateway-vw.de:8443 \
PORTALS_FILE="$PWD/backend/ops/portals.json" \
npm --prefix backend run ops:verify:keycloak

# 9. Build frontend and deploy dist/ behind each portal domain
npm --prefix frontend ci
npm --prefix frontend run build
```

`backend/ops/portal-secrets.example.json` is not present in the copied code
assets only if omitted; if absent, create it with the same object shape as
`PORTALS_JSON` in `ops/env.example`.

---

## 9. Phase C after Verimi shutdown

1. Set `PHASE=C` in Lambda.
2. Remove the `verimi` IdP from all realms.
3. Delete Verimi secrets from vault and AWS.
4. Keep passkey login only.
5. Run support/recovery drills for users who never enrolled.

---

## 10. Suggested improvements / open tasks

1. **Recovery path.** Decide what happens if a user loses all passkeys before
   Verimi shutdown. Options: one-time recovery codes stored by Keycloak,
   verified support flow, or an additional IdP.
2. **Portal branding per realm.** The current `vw` theme is shared. If the 9
   portals need distinct branding, create one theme per realm or make the theme
   read a realm attribute.
3. **Observability.** Add OpenTelemetry traces from API Gateway → Lambda →
   Keycloak. Structured logs already have `request_id`.
4. **Account linking edge cases.** Decide policy when Verimi `sub` changes for
   the same email. Current code maps by Keycloak `sub` and stores `verimiSub`.
5. **Force enrolment campaign.** If you must require passkeys before 2026-12-31,
   change the required action from AIA to a default action only after a grace
   period and clear communications.
6. **Key rotation drill.** Test `*_PREVIOUS_B64U` rotation end-to-end.
7. **WAF rules.** Enable the optional `WebAclArn` and add rate limiting for
   `/api/auth/login` and `/api/auth/enroll`.
