# Architecture: Keycloak as IdP broker + passkey bootstrap

**Date:** 2026-11-21  
**Project:** keycloak-passkey-3  
**Implementation:** `impl-broker-production`  
**Guiding principles:** `~/dev/ai/ideas/software-architecture-principles.md`

---

## 0. Executive evaluation

The requested system is reasonable and implementable without Java and without
changing Verimi.

| Requirement | Verdict | Mechanism |
|---|---|---|
| Brok Verimi until shutdown | Reasonable | Keycloak OIDC identity provider `verimi` + `kc_idp_hint=verimi` from the BFF |
| Hide Keycloak visually | Partially reasonable | White-label Keycloak theme; real redirects are unavoidable |
| Add passkeys while Verimi alive | Reasonable | Keycloak WebAuthn passwordless + AIA (`kc_action=webauthn-register-passwordless:skip_if_exists`) |
| Later passkey-only login | Reasonable | `PHASE=C` stops Verimi hint; remove IdP after shutdown |
| No Java extension | Reasonable | Realm JSON import, built-in WebAuthn, theme only |
| No Verimi changes | Reasonable | Standard OIDC IdP configuration in Keycloak |
| SPA must not hold tokens/secrets | Necessary | BFF pattern with encrypted HttpOnly cookies |
| Production-ready and secure | Reasonable | Dedicated libraries: `openid-client`, `jose`, `cookie`, `zod`, AWS SDK |

The only architectural myth to correct is the phrase “redirect happens in the
background”. OAuth/OIDC and WebAuthn are browser protocols. The browser must
visit Keycloak and Verimi. What can be hidden is the branding, not the
round-trip.

---

## 1. Understand the system and split it into domains

### 1.1 System type

This is an **identity migration platform** with:

- 9 portal frontends on different domains,
- a shared stateless BFF on AWS,
- Keycloak as identity broker and WebAuthn authority,
- Verimi as a temporary upstream IdP,
- DynamoDB for portal-owned state and revocable sessions,
- PostgreSQL for Keycloak persistence,
- nginx as TLS entry point on the IONOS VPS.

### 1.2 Domain-Driven Design boundaries

| Bounded context | Language | Owns | Does not own |
|---|---|---|---|
| Portal UI | session status, login method, enrolment banner | rendering, calling `/api` | OIDC protocol, tokens |
| Auth brokering | transaction, state, nonce, PKCE, callback | browser-bound login transaction | credentials |
| Identity authority | realm, user, broker link, SSO, WebAuthn credential | authentication facts | portal application session |
| Portal identity cache | `kcSub`, `verimiSub`, `passkeyEnrolled` | campaign flag, linkage cache | WebAuthn credential material |
| Session context | `sid`, revocation | HTTP session record | IdP session |
| Infrastructure | host, TLS, gateway, queue-free scale | routing, throttling, secrets | business decisions |

### 1.3 Key modelling decision

```text
Keycloak sub  = canonical user identity for the portal from now on.
Verimi sub    = historical external mapping, stored as an attribute/cache.
Passkey       = WebAuthn credential owned exclusively by Keycloak.
Portal cookie = encrypted pointer to a revocable portal session.
```

This avoids coupling the portal schema to Verimi's identifier.

---

## 2. Robust system design

### 2.1 Decoupling

The components are decoupled by protocols and data ownership:

```text
React ──HTTPS /api──> API Gateway ──AWS_PROXY──> Lambda
Lambda ──OIDC back-channel──> Keycloak ──SQL──> Postgres
Lambda ──DynamoDB API──> DynamoDB
Browser ──front-channel redirects──> Keycloak ──front-channel──> Verimi
```

The Lambda never follows Keycloak/Verimi redirects itself. That keeps browser
cookies, WebAuthn origin checks and OIDC state binding correct.

### 2.2 Failure behaviour

| Failure | Behaviour | Reason |
|---|---|---|
| Verimi unavailable | Keycloak returns error; BFF maps to fixed `login=error` reason | Do not invent authentication |
| Keycloak unavailable | Login/enrolment cannot start | Fail closed |
| Account API unavailable | `hasPasskey()` returns `null`; last known state kept | Do not guess enrolment |
| DynamoDB read fails during login | cached passkey hint treated as false; login continues | Cache is not authority |
| DynamoDB write fails during callback | login fails with `internal_error` | No unrevokeable session may be created |
| Discovery endpoint slow | 5s timeout, 10-minute cache | Bounded latency |
| Browser lacks WebAuthn | Passkey button hidden; Verimi path still available in Phase B | Progressive rollout |

### 2.3 Idempotency

- `webauthn-register-passwordless:skip_if_exists` makes repeated enrolment
  clicks safe.
- Every successful callback creates a fresh `sid`, preventing session fixation.
- Portal user update uses `if_not_exists(passkeyEnrolled, false)` and never
  overwrites `verimiSub` with `null`.
- Logout is safe to repeat: session revocation tolerates missing records.

### 2.4 Consistency model

| Data | Model | Rationale |
|---|---|---|
| OIDC callback | Strong per transaction | state/nonce/PKCE must match exactly |
| Portal session | Strong read on `/me` | revoked sessions must stop working immediately |
| `passkeyEnrolled` cache | Eventually consistent | Authoritative value is Keycloak Account API |
| Keycloak user/credential | Strong within Keycloak/Postgres | Security authority |

---

## 3. Scalable system design

### 3.1 Stateless compute

The Lambda holds no durable state. All browser-bound state is in encrypted
cookies; all server state is in DynamoDB. Therefore API Gateway can scale the
BFF horizontally.

### 3.2 Multi-tenant but isolated

One Lambda and one HTTP API serve 9 portals. Isolation is by:

```text
requestContext.domainName → portalId → realm/client/secret/redirectUri
```

The browser's `Host` header is never trusted for this decision.

### 3.3 Scale path

| Load dimension | Mechanism |
|---|---|
| Login callbacks | Lambda concurrency + API Gateway throttling |
| Session reads | DynamoDB on-demand capacity |
| OIDC metadata | 10-minute in-warm-container cache |
| Frontend delivery | Static hosting/CDN per portal domain |
| Keycloak load | Single VPS today; HA cluster later |

At millions of users, the BFF is not the bottleneck. The IONOS single VPS and
its PostgreSQL instance are the real scaling/availability limit. See section 6.

---

## 4. Secure system design

### 4.1 Security principles applied

| Principle | Implementation |
|---|---|
| Separation of concerns | OIDC in `oidc.js`, crypto in `crypto.js`, persistence in `store.js` |
| Information hiding | Tokens never leave Lambda; cookies encrypted |
| Least privilege | Lambda IAM only reads/writes two DynamoDB tables and KMS keys |
| Fail closed | Dev flags, memory store, HTTP Keycloak URLs, wrong portal counts abort cold start |
| Defence in depth | PKCE + state + nonce + JWE + host binding + WAF hook |
| Secure defaults | `__Host-` cookies, `Secure`, `HttpOnly`, `SameSite=Lax`, no Domain |
| Observability | Structured JSON logs with `request_id`; API Gateway access logs |

### 4.2 Attack vectors and mitigations

| Attack | Mitigation |
|---|---|
| Authorization code injection | `state` check + PKCE S256 verifier |
| ID token replay | `nonce`, `exp`, `iss`, `aud`, `azp`, JWKS signature |
| CSRF on callback | `SameSite=Lax`, `state` in encrypted cookie, constant-time compare |
| Host-header spoofing | `requestContext.domainName` is authoritative |
| Open redirect | Frontend allowlists Keycloak origin; backend validates every `redirectUri` |
| Session fixation | New random `sid` on every successful callback |
| Cookie theft/XSS | `HttpOnly`, `Secure`, `__Host-`, JSON CSP, React escaping |
| Timing attacks on `state` | `timingSafeEqual` via `safeEqual()` |
| Unauthorized enrolment | Requires portal session; tx bound to `sub`; Account API proves credential |
| Admin console exposure | Separate hostname/port, IP allowlist, `deny all`, firewall |
| Secret leakage | Secrets Manager + Keycloak file vault; generated folders gitignored |
| Brute force | Keycloak `bruteForceProtected`, nginx rate limits, optional WAF |
| Clickjacking | `X-Frame-Options`, CSP `frame-ancestors 'none'` |

### 4.3 Why BFF instead of direct SPA OIDC?

A direct SPA would need to store tokens in the browser. That creates XSS token
theft and makes logout/revocation harder. It also requires either a public
client or exposing a confidential client secret — neither is acceptable here.

The BFF is the correct boundary:

```text
SPA:      "Where do I go?"       → receives only an authorization URL
Lambda:   "Who is the user?"     → exchanges code, verifies token, owns session
Keycloak: "Is this person real?" → Verimi broker or WebAuthn
```

---

## 5. C4 diagrams

### 5.1 C4 Level 1 — System context

```text
                         ┌──────────────────────────┐
                         │        Person            │
                         │ Portal user (9 domains)  │
                         └────────────┬─────────────┘
                                      │
          clicks login / passkey      │ sees portal UI
                                      ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     System: Portal Auth Platform                    │
│                                                                     │
│  React SPA on vw-baev.de, ltkv.de, ...                              │
│  AWS Lambda BFF behind API Gateway                                  │
│  Keycloak on kc.gateway-vw.de:8443                                  │
└──────────┬───────────────────────────┬───────────────────────────────┘
           │ OIDC front-channel        │ OIDC brokering
           ▼                           ▼
┌────────────────────────┐   ┌──────────────────────────────────────┐
│ External System        │   │ External System                      │
│ Verimi OIDC IdP        │   │ WebAuthn authenticator               │
│ active until 2026-12-31│   │ QR / USB key / platform biometric    │
└────────────────────────┘   └──────────────────────────────────────┘
```

### 5.2 C4 Level 2 — Containers

```text
Browser (user device)
┌──────────────────────────────────────────────────────────────────────┐
│ React SPA container                                                  │
│  - GET /api/auth/login?method=verimi                                 │
│  - GET /api/auth/enroll                                              │
│  - GET /api/me                                                       │
│  - window.location.assign(authorizationUrl)                          │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ HTTPS, same origin
                                ▼
AWS
┌──────────────────────────────────────────────────────────────────────┐
│ API Gateway HTTP API                                                 │
│  custom domains: vw-baev.de/api/*, ltkv.de/api/*, ...                │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ AWS_PROXY, payload 2.0
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Lambda BFF (Node.js 24)                                              │
│  state/nonce/PKCE, JWE cookies, callback validation, sessions        │
└───────────────┬────────────────────────────────┬─────────────────────┘
                │ DynamoDB SDK                   │ HTTPS OIDC / Account API
                ▼                                ▼
┌──────────────────────────┐        ┌──────────────────────────────────┐
│ DynamoDB                 │        │ IONOS VPS                        │
│  - identity cache        │        │  nginx 8443/8444                 │
│  - revocable sessions     │        │  Keycloak 26.8 internal 8080     │
└──────────────────────────┘        │  PostgreSQL                      │
                                    └──────────────┬───────────────────┘
                                                   │ OIDC broker
                                                   ▼
                                    ┌──────────────────────────────────┐
                                    │ Verimi IdP                       │
                                    └──────────────────────────────────┘
```

### 5.3 C4 Level 3 — BFF components

```text
┌──────────────────────────────── Lambda BFF ────────────────────────────────┐
│                                                                            │
│  handler.js                                                                │
│      │                                                                     │
│      ▼                                                                     │
│  router.js ──normalizePath(/api/...)                                       │
│      │                                                                     │
│      ├── handlers/login.js ──createOidcTransaction()──> oidc.js             │
│      ├── handlers/enroll.js ──kc_action AIA──────────> oidc.js             │
│      ├── handlers/callback.js ──authorizationCodeGrant()──> oidc.js        │
│      ├── handlers/me.js ──readSession()─────────────> session.js           │
│      └── handlers/logout.js ──revokeSession()───────> store.js             │
│                                                                            │
│  config.js   fail-closed env + portal manifest                             │
│  cookies.js  __Host- cookie serialize/parse (cookie lib)                   │
│  crypto.js   JWE seal/open (jose), CSPRNG, timingSafeEqual                 │
│  http.js     domain binding, callback URL reconstruction, fixed reasons    │
│  session.js  encrypted cookie readers, key rotation                        │
│  store.js    DynamoDB identity cache + sessions                            │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

### 5.4 C4 Level 4 — Dynamic login sequence

```text
User   React     API GW    Lambda      Browser    Keycloak     Verimi     DynamoDB
 │       │          │         │            │           │          │          │
 │ click │          │         │            │           │          │          │
 │──────>│ GET /api/auth/login          │            │           │          │
 │       │─────────>│ invoke   │            │           │          │          │
 │       │          │─────────>│ tx+JWE     │           │          │          │
 │       │          │          │ authUrl    │           │          │          │
 │       │<─────────│<─────────│            │           │          │          │
 │       │ location.assign     │            │           │          │          │
 │       │────────────────────────────────>│ /auth      │          │          │
 │       │          │          │            │──────────>│ 302 IdP   │          │
 │       │          │          │            │─────────────────────>│          │
 │ credentials      │          │            │           │          │          │
 │─────────────────────────────────────────────────────────────────>│          │
 │       │          │          │            │<─────────────────────│ 302      │
 │       │          │          │            │──────────>│ broker    │          │
 │       │          │          │            │<──────────│ 302 /api  │          │
 │       │<────────────────────────────────│ callback   │          │          │
 │       │ GET /api/auth/callback          │           │          │          │
 │       │─────────>│─────────>│ verify     │           │          │          │
 │       │          │          │──token───────────────>│          │          │
 │       │          │          │──────────────────────────────────────────────>│ session
 │       │          │<─────────│ 302 /?login=success   │          │          │
 │<──────│          │          │            │           │          │          │
```

---

## 6. Robustness caveats and improvements

The application layer is decoupled and horizontally scalable. However, the
current infrastructure still has two obvious single points of failure:

1. **One IONOS VPS** runs nginx, Keycloak and PostgreSQL.
2. **One PostgreSQL container** stores Keycloak state.

Production improvements, in priority order:

1. Back up PostgreSQL automatically and test restore.
2. Move TLS certificates into a secret/backup process; do not keep only on VPS.
3. Add monitoring/alerts for Keycloak health, discovery issuer drift, JWKS
   rotation and port 8444 exposure.
4. Consider a second Keycloak node with shared PostgreSQL and a load balancer.
5. Add OpenTelemetry traces and RED metrics per route.
6. Enable the WAF WebACL and rate-limit login/enrolment endpoints.
7. Run a quarterly key-rotation and Verimi-shutdown drill.
8. Define a recovery policy for users without a passkey before shutdown.

---

## 7. Litmus test

1. **Does it decrease coupling?** Yes. Portal UI, BFF, Keycloak and DynamoDB
   have separate contracts and data ownership.
2. **Can it change without touching unrelated parts?** Yes. Verimi endpoints are
   realm config; portal list is a manifest; frontend only knows `/api` and the
   Keycloak origin.
3. **If one component fails catastrophically, does the rest survive?** Mostly.
   Lambda and DynamoDB scale independently; Keycloak/VPS remains the main SPOF
   and is documented as such.
