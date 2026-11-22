# Architecture: Keycloak IdP broker + passkey bootstrap for 9 portals

**Project:** `keycloak-passkey-3`
**Date:** 2026-11-22
**Implementation folder:** [`impl-passkey-prod/`](./impl-passkey-prod/README.md)
**Stack:** React (Vite, TypeScript) · AWS Lambda Node.js 24 (BFF) · API Gateway · DynamoDB · Secrets Manager · Keycloak 26.8 + nginx + PostgreSQL on IONOS VPS · Verimi as temporary upstream OIDC IdP

---

## 0. Evaluation: is this task reasonable?

**Yes — with two honest corrections to the expectation.**

### 0.1 Why it is technically sound

Keycloak already implements both capabilities you need. No Java code and no Verimi code changes are required:

| Requirement | Keycloak / standards feature | What you must change at Verimi |
|---|---|---|
| "Keycloak acts as IdP broker" | OIDC identity brokering (`identityProviders` of type `oidc`) | Register one redirect URI per realm: `https://kc.gateway-vw.de:8443/realms/<realm>/broker/verimi/endpoint` |
| "Create passkey after login" | Application-Initiated Action (AIA): `kc_action=webauthn-register-passwordless` | Nothing |
| "Login with passkey later" | WebAuthn passwordless / passkeys policy, RP ID `gateway-vw.de` | Nothing (Verimi is bypassed) |
| "After 2026-12-31 keep working" | Delete the Verimi IdP from each realm; keep the passkey policy | Nothing (service ends) |

This is confirmed by the Keycloak 26.8 documentation:

- AIA: `kc_action=webauthn-register-passwordless` (and `webauthn-register-passwordless:skip_if_exists`) triggers passkey registration inside an already authenticated SSO session.
- The docs explicitly warn that `kc_action_status` is **not proof** that the credential exists. Therefore this design never trusts that parameter for a security decision — it asks the Keycloak Account REST API with the user's own access token.
- Passkeys are enabled via the WebAuthn Passwordless policy (`webAuthnPolicyPasswordlessPasskeysEnabled`), not via Java extensions.

### 0.2 Correction 1 — "invisible Keycloak" is only half possible

OIDC and WebAuthn are **browser redirect protocols**. The browser must perform a real, top-level navigation to:

```text
https://kc.gateway-vw.de:8443/realms/<realm>/protocol/openid-connect/auth
```

You cannot hide that with an iframe:

- Keycloak sends anti-framing headers (`X-Frame-Options: DENY`, CSP `frame-ancestors 'none'`),
- third-party cookies are blocked by browsers,
- WebAuthn requires the correct origin and user presence in a top-level context,
- OIDC state/nonce binding breaks in embedded contexts.

**What we hide:** all protocol parameters, all tokens, the client secret, Keycloak error text, and the Keycloak branding (white-label `vw` theme, German text).
**What remains visible for a second:** the hostname `kc.gateway-vw.de:8443` in the address bar. That is the correct and secure target — do not fight it.

### 0.3 Correction 2 — one browser, two sessions

A common misunderstanding: "the user is logged in to the portal, so Keycloak knows that".

```text
Portal session cookie  (set by Lambda on api.<portal>)   → portal says "logged in"
Keycloak SSO cookie    (set by Keycloak on kc.gateway-vw.de:8443) → Keycloak says "logged in"
```

They are **different cookies on different domains**. Step 9 works because the *same browser* still carries the Keycloak SSO cookie from steps 2–7. If that SSO cookie has expired, Keycloak will ask for login again — and the AIA is still preserved in the authentication session, so the passkey screen appears after successful re-authentication. This is safe; there is no shortcut that skips authentication (that would be a critical vulnerability).

### 0.4 Verdict

Build it. Use the BFF pattern, encrypted `__Host-` cookies, `openid-client` for OIDC, `jose` for cookie encryption, AWS SDK v3 for DynamoDB/Secrets Manager, and Keycloak's built-in WebAuthn policy. No hand-rolled crypto, no mocks, no emulators.

---

## 1. What kind of system is this — DDD domains

| Bounded context | Owner | Responsibility | Must NOT do |
|---|---|---|---|
| **Portal experience** | React SPA (`frontend/`) | Render login / passkey banner / logout; navigate to URLs returned by the BFF | Never see tokens, state, nonce, PKCE verifier, client secret |
| **Identity brokering & session** | Lambda BFF (`backend/`) | OIDC transactions, PKCE, state/nonce validation, token exchange, encrypted cookies, revocable portal sessions, enrolment gating | Never implement WebAuthn crypto itself; never trust `kc_action_status` |
| **Identity authority** | Keycloak 26.8 (`vps/keycloak/`) | Verimi brokering, user provisioning, SSO, WebAuthn credential storage and ceremony | Never be called with Admin API from the user journey |
| **Portal identity cache** | DynamoDB `identity` table | `realm:sub` ↔ portal identity, `passkeyEnrolled` flag, last login | Never be the source of truth for credentials |
| **Session/revocation** | DynamoDB `sessions` table | Revocable server-side session record behind the encrypted cookie | Never store tokens |
| **Secrets** | AWS Secrets Manager + Keycloak file vault | Portal client secrets (AWS), Verimi + client secrets (Keycloak) | Never put secrets in the repo or in the SPA bundle |
| **Platform / ingress** | nginx + Docker + IONOS VPS | TLS termination on 8443/8444, admin IP allowlist, proxy headers, Postgres | Never expose the admin plane publicly |

**The one rule that drives the whole design:**

> Keycloak owns credentials. The portal owns the application session. The SPA owns neither.

---

## 2. Robustness (failure isolation)

| Failure | Behaviour | Mechanism |
|---|---|---|
| Verimi down (before cutoff) | Passkey users still log in; Verimi button fails with a clear error | No `kc_idp_hint` for passkey login; button-level error state |
| Keycloak unreachable from Lambda | Login returns a safe 5xx, no partial session | `AbortSignal.timeout` on Account API; `openid-client` discovery timeout; fail-closed config |
| Keycloak reachable, Account API denies (403) | Enrolment is **not** marked complete; banner stays visible | `hasPasskey === null` → keep last known state; never guess |
| DynamoDB throttling | Request fails safe (no session = not logged in) | No cache that could grant access; CloudWatch alarms on 5xx/throttles |
| Lost/expired transaction cookie | OIDC transaction cannot be replayed | Short TTL (10 min) + single-use clear on callback + state binding |
| User reloads callback URL | Replay fails: tx cookie is gone / state mismatch | Clear `__Host-pk_tx` immediately after callback |
| nginx/Keycloak container restart | Sessions survive (DynamoDB + Postgres volumes) | `restart: unless-stopped`, healthchecks, named Postgres volume |
| Single VPS dies | **Known single point of failure** — see §6 | Backups + monitoring now; second node / managed DB later |
| Browser loses Keycloak SSO before enrolment | Login happens again, AIA still executes | `kc_action` stored in Keycloak auth session |

Idempotency:

- `/api/auth/login` and `/api/auth/enroll` create a fresh transaction each call (safe retry, old tx simply expires).
- `/api/auth/callback` is effectively single-use because the transaction cookie is cleared on first success.
- `setPasskeyStatus` is an idempotent `UpdateCommand`.
- Session creation uses a new CSPRNG `sid` per successful login.

---

## 3. Scalability (millions of users)

| Layer | Scale strategy |
|---|---|
| React SPA | Static files on CDN/S3+CloudFront; no server state |
| API Gateway HTTP API | Managed, scales automatically; WAF can be attached |
| Lambda BFF | Stateless; warm discovery/secret caches in module scope; concurrency scaling; no local disk state |
| DynamoDB | On-demand billing, PK-point-lookups only (`sid`, `realm:sub`), no scans, TTL cleanup |
| Secrets Manager | Cached for 5 min per Lambda container; `GetSecretValue` only on cold start/expiry |
| Keycloak | Horizontal: multiple `start` nodes behind nginx/ALB sharing Postgres; sticky sessions not required for OIDC code flow (auth sessions are in DB/Infinispan) |
| Postgres | Managed or replicated; connection pool sized to node count |
| 9 portals | 9 realms, 9 public config entries, 9 client secrets in one AWS secret — one Lambda serves all |

**Decision confirmed 2026-11-22:** one realm per portal. Consequence: passkeys are portal-local and there is no cross-portal SSO. This was chosen for strict tenant isolation. If the business later wants one passkey for all portals, migrate to one realm with 9 confidential clients and adjust `realm` mapping accordingly.

Bottlenecks to watch:

1. Keycloak discovery on cold start (cached 10 min per realm/client).
2. Account API call on every callback (8 s timeout, non-blocking for the login decision).
3. DynamoDB consistent read on `/api/me` (use eventually consistent read for identity, consistent read only for session revocation).

---

## 4. Security

### 4.1 Trust boundaries and countermeasures

| Attack vector | Countermeasure |
|---|---|
| Stolen SPA bundle → client secret leak | Secret lives only in AWS Secrets Manager + Lambda env at runtime; SPA is a public asset with no secrets |
| XSS steals tokens | Tokens never enter browser JavaScript; browser has only opaque encrypted cookies |
| CSRF on login callback | `state` from encrypted, browser-bound cookie + `openid-client` state check + timing-safe compare |
| Authorization code injection | PKCE S256 verifier in encrypted cookie; `openid-client` validates |
| ID token forgery | JWKS signature validation, `iss`/`aud`/`exp`/`nonce` checks, `enableNonRepudiationChecks` |
| Replay of callback | Transaction cookie cleared after use; short TTL; single-use code at Keycloak |
| Enrol a passkey for a *different* user | Enrolment transaction stores expected `realm:sub`; callback aborts if the authenticated `sub` differs |
| Fake "passkey created" via `kc_action_status` | Ignored. Account REST API with user's access token is authoritative; `null` = keep last known state |
| Cross-portal login mix-up | Host allowlist (`x-forwarded-host`), per-portal realm/client/redirect URI, `apiHost`↔`redirectUri` check at config load |
| Open redirect via `authorizationUrl` | SPA validates URL origin against a hard allowlist (`https://kc.gateway-vw.de:8443`, path `/realms/…`) |
| Cookie theft / subdomain injection | `__Host-` prefix: `Secure`, `Path=/`, no `Domain`; `SameSite=Lax`; `HttpOnly`; short TTLs |
| Admin console exposed | Separate `kc-admin.gateway-vw.de:8444`, nginx `deny all` + explicit `allow <your IP>`, never proxied through public port |
| Brute force at Keycloak | `bruteForceProtected`, `failureFactor=5`, increasing lockout |
| SSRF via issuer URL | Issuer is a fixed config value, never taken from request input |
| Logging secrets | Structured logs log request ID, status, realm — never cookies, tokens, secrets, or `sub` |
| Verimi shutdown | `verimiEnabled` per portal; passkey login has no broker dependency; documented removal step |

### 4.2 Why encrypted cookies *and* a session table?

```text
__Host-pksid = JWE(sid, sub, realm, exp)   ← integrity + confidentiality, browser cannot read
DynamoDB[sid] = { status, expiresAt }      ← instant revocation
```

A signed/encrypted cookie alone cannot be revoked before expiry. The DynamoDB row gives you a kill switch (logout, compromise, offboarding). The cookie gives you low-latency identity without a database write on every request. `/api/me` reads both: decrypt cookie, then verify the session row is active.

### 4.3 WebAuthn specifics

- RP ID: `gateway-vw.de` (registrable parent of `kc.gateway-vw.de` — valid for WebAuthn).
- Origin: `https://kc.gateway-vw.de:8443`.
- `userVerification: required`, `residentKey: required`, `signatureAlgorithms: ES256, RS256`.
- Passkeys enabled; conditional UI/mediation `optional`.
- Public keys only — Keycloak/Postgres never store private keys.

---

## 5. C4 diagrams (ASCII)

### 5.1 Level 1 — System context

```text
                    ┌──────────────────────────────────────────┐
                    │  End user (browser + passkey device)      │
                    └───────┬──────────────────────────┬────────┘
                            │ HTTPS                    │ HTTPS (WebAuthn)
                            ▼                          ▼
┌───────────────────────────────────────┐   ┌──────────────────────────────────────┐
│ 9 portals + Identity BFF              │   │ IONOS VPS                            │
│ React SPA + AWS Lambda/API Gateway    │   │ nginx 8443/8444, Keycloak 26.8, PG   │
│ (api.vw-baev.de, api.ltkv.de, ...)    │◄──┤ kc.gateway-vw.de:8443                │
└───────────────┬───────────────────────┘   └───────────┬──────────────────────────┘
                │                                       │ OIDC broker
                ▼                                       ▼
┌───────────────────────────────────────┐   ┌──────────────────────────────────────┐
│ AWS DynamoDB + Secrets Manager        │   │ Verimi OIDC IdP (until 2026-12-31)   │
│ sessions, identity cache, secrets     │   │ then: deleted from all realms        │
└───────────────────────────────────────┘   └──────────────────────────────────────┘
```

### 5.2 Level 2 — Containers

```text
  Browser (vw-baev.de)
  ┌──────────────────────────────┐
  │ React SPA                    │
  │ - /me, /auth/login           │
  │ - /auth/enroll, /auth/logout │
  └──────────────┬───────────────┘
                 │ fetch(credentials:'include')  (same-site, CORS locked)
                 ▼
  ┌──────────────────────────────┐        ┌──────────────────────────────┐
  │ API Gateway HTTP API         │        │ Secrets Manager              │
  │ custom domains /api/*        │        │ portal client secrets        │
  └──────────────┬───────────────┘        └──────────────┬───────────────┘
                 ▼                                       │ GetSecretValue (cached)
  ┌──────────────────────────────┐                        │
  │ Lambda BFF (Node 24)         │◄───────────────────────┘
  │ openid-client · jose         │
  │ DynamoDB · zod               │
  └───┬──────────────────────┬───┘
      │ discovery/token/JWKS │ sessions/identity
      ▼                      ▼
  ┌──────────────────────┐  ┌──────────────────────────┐
  │ nginx :8443 / :8444  │  │ DynamoDB                 │
  │ (TLS + IP allowlist) │  │ sessions + identity      │
  └──────────┬───────────┘  └──────────────────────────┘
             ▼
  ┌──────────────────────┐  ┌──────────────────────────┐
  │ Keycloak 26.8        │─►│ PostgreSQL (users, keys) │
  │ 9 realms · WebAuthn  │  └──────────────────────────┘
  └──────────┬───────────┘
             ▼
  ┌──────────────────────┐
  │ Verimi (OIDC IdP)    │
  └──────────────────────┘
```

### 5.3 Level 3 — BFF components

```text
Lambda handler.js
   │
   ├── http.js        host allowlist, response shapes, CORS
   ├── router.js      /auth/login | /auth/callback | /auth/enroll | /me | /auth/logout
   ├── config.js      zod fail-closed config, 9 portals
   ├── secrets.js     Secrets Manager cache
   ├── crypto.js      jose JWE seal/open, CSPRNG, timing-safe compare
   ├── cookies.js     __Host- cookie serialization
   ├── session.js     tx + session JWE helpers
   ├── oidc.js        discovery, authorize URL, code grant, validation (openid-client)
   ├── account.js     Keycloak Account REST credential check
   ├── store.js       DynamoDB identity + sessions
   └── handlers/      login · callback · enroll · me · logout
```

### 5.4 Dynamic view — steps 1 to 11 (who calls whom, with endpoints)

```text
 [1] User clicks "Login"
 [2] SPA ──GET https://api.vw-baev.de/api/auth/login?method=verimi──► Lambda
     Lambda ──Set-Cookie __Host-pk_tx=JWE(state,nonce,PKCE)──────────► Browser
     Lambda ──200 {authorizationUrl}────────────────────────────────► SPA
 [3] SPA ──window.location.assign(authorizationUrl)────────────────► Browser
     Browser ──GET kc.gateway-vw.de:8443/realms/vw-beav/protocol/openid-connect/auth
                 ?kc_idp_hint=verimi&code_challenge=...&state=...────► Keycloak
 [4] Keycloak ──302────────────────────────────────────────────────► Verimi /authorize
 [5] User types credentials at Verimi; Verimi authenticates
 [6] Verimi ──302 /realms/vw-beav/broker/verimi/endpoint?code=...───► Keycloak
 [7] Keycloak ──302 https://api.vw-baev.de/api/auth/callback?code&state► Lambda
     Lambda ──POST /realms/vw-beav/protocol/openid-connect/token─────► Keycloak
     Lambda ──GET  /realms/vw-beav/account/credentials───────────────► Keycloak
     Lambda ──DynamoDB upsert identity + create session──────────────► DynamoDB
     Lambda ──302 /?login=success + __Host-pksid────────────────────► Browser
 [8] SPA ──GET /api/me──► {authenticated:true, passkeyEnrolled:false}──► Banner shown
 [9] User clicks "Passkey erstellen"
     SPA ──GET /api/auth/enroll──────────────────────────────────────► Lambda
     Lambda validates session, binds expectedSub, builds URL:
        ?kc_action=webauthn-register-passwordless:skip_if_exists (NO kc_idp_hint)
     Browser ──GET Keycloak /auth?kc_action=...──────────────────────► Keycloak
 [10] Browser ↔ Keycloak WebAuthn ceremony (RP ID gateway-vw.de)
          Keycloak ──writes public key──────────────────────────────► Postgres
          Keycloak ──302 /api/auth/callback?code&state──────────────► Lambda
          Lambda ignores kc_action_status; asks Account API; sets flag
          Lambda ──302 /?passkey=created────────────────────────────► Browser
 [11] Next login: SPA ──GET /api/auth/login?method=passkey──────────► Lambda
          URL has NO kc_idp_hint → Keycloak passkey login → callback → session
          Verimi is never contacted.
```

---

## 6. Suggestions for improvements / open tasks

**You must supply before go-live (not mocks — real values):**

1. The 9 real portal hostnames + API hostnames + realm names.
2. Verimi's real authorization/token/userinfo/JWKS endpoints, issuer, client ID, client secret, and the redirect URI they allow. Verimi must register `https://kc.gateway-vw.de:8443/realms/<realm>/broker/verimi/endpoint` for all 9 realms.
3. TLS certificates for `kc.gateway-vw.de` and `kc-admin.gateway-vw.de` (Let's Encrypt or company CA — no self-signed certs in production).
4. Your admin IP ranges for `nginx/admin-allow.conf`.
5. Three high-entropy keys/values: DynamoDB table names suffix, AES-256 key for cookie encryption (32 bytes base64url), and Secrets Manager secret ARN.

**Architectural improvements (priority order):**

1. **Remove the single point of failure.** Second VPS node with Keycloak `start`, shared/managed Postgres, nginx/ALB health-based failover. Config change only (`KC_PUBLIC_URL` stays).
2. **Enrolment dashboard.** Stream Keycloak events (`LOGIN`, `FIRST_BROKER_LOGIN`, `CREDENTIAL_REGISTER`) to CloudWatch/SIEM; track "users without passkey" weekly until 2026-12-31.
3. **Cutover runbook for 2026-12-31.** Set `verimiEnabled:false` in all portal configs, then delete `identityProviders[verimi]` from all realms. Passkey login is unaffected.
4. **Recovery path.** Passkey loss needs a documented support process (identity verification via existing portal data, then Admin API credential reset by an operator — deliberately not in the user journey).
5. **Optional popup UX.** `window.open()` for login if branding matters more than popup blockers; never iframe.
6. **WAF + rate limiting** on API Gateway; alarm on `/auth/callback` error rate and Account API denials.
7. **Client secret rotation** via Secrets Manager rotation + warm-cache TTL of 5 min (new secret picked up automatically).

---

## 7. Litmus test (from the architecture principles)

| Question | Answer |
|---|---|
| Does it increase or decrease coupling? | Decreases: SPA depends only on BFF JSON; Keycloak details stay behind Lambda |
| Easy to change without touching unrelated parts? | Yes: realms are per portal; secrets externalized; frontend has no protocol logic |
| If one component fails, does the rest survive? | Mostly: Verimi loss does not kill passkey login; VPS loss is the one accepted SPOF, with a documented upgrade path |
