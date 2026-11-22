# Architecture: Keycloak as IdP Broker + Passkey Bootstrap (BFF edition)

**Project:** keycloak-passkey-3
**Date:** 2026-11-20
**Status:** Approved design — production-shaped implementation in `impl-broker-bff/`; real deployment blocked only on the user-supplied values listed in `impl-broker-bff/PRODUCTION.md` §0
**Supersedes / extends:** `architecture_11-15-2026.md`, `architecture_11-19-2026.md`, `login-url-verimi_11-19-2026.md`

---

## 0. Evaluation — is this task reasonable?

**Yes.** The design is a textbook application of two standard Keycloak capabilities:

1. **Identity Brokering** — Verimi is configured as an upstream OIDC Identity Provider. Keycloak is the OIDC front door for the portal. Verimi's code is untouched; only the portal's redirect target changes.
2. **Application Initiated Action (AIA)** — after a *real* browser login (Verimi → Keycloak), the portal redirects the browser back to Keycloak's authorize endpoint with `kc_action=webauthn-register-passwordless:skip_if_exists`. Keycloak runs WebAuthn on its own origin and stores the public key.

No Java. No Keycloak extension. No Verimi changes. No admin API in the user journey.

### The one correction you must internalise

```
A passkey can only be created inside an ALREADY AUTHENTICATED browser session.
⇒ Verimi must authenticate each user ONCE, before a passkey exists.
⇒ Verimi is a temporary bootstrap dependency, not a permanent one.
```

So your steps 1–11 are correct, with one nuance: during the transition, **every user's first login still needs Verimi**. From the second login onward (passkey exists), Verimi is never contacted. After 2026-12-31 it is removed entirely.

### Decisions confirmed with you

| Decision | Choice | Consequence |
|---|---|---|
| Realm topology | **One realm per portal** | `vw-beav`, `vw-ltkv`, … 9 realms, 1 client each. No cross-portal SSO (isolation over convenience). |
| Token storage | **BFF + signed/encrypted httpOnly cookie** | Lambda holds `client_secret`; browser JS never sees an OIDC token. |
| Verimi protocol | **OIDC / OAuth2** | Broker config uses `providerId: "oidc"`. |
| Keycloak version | **26.x current** | Native passkeys, `skip_if_exists` (26.3+), `kc_action_status`. |

---

## 1. Understand the system — bounded contexts (DDD)

| Bounded Context | Responsibility | Owner | Talks to |
|---|---|---|---|
| **Identity & Authentication** | Authenticate user, hold SSO session, store WebAuthn public keys, issue OIDC tokens | Keycloak (9 realms) | Verimi, browser, Postgres |
| **Identity Linking** | Map `verimi_sub` / Keycloak `sub` → portal account | Portal BFF (Lambda) + DynamoDB | Keycloak token endpoint, Account API |
| **Enrolment Campaign** | Decide *when* to ask for a passkey, render banner, record result | React SPA + Lambda | BFF, browser |
| **Session & Consent** | Signed portal session cookie, logout | Lambda BFF | browser |
| **Recovery** | Lost passkey / never-enrolled users | Keycloak recovery codes + support runbook | Keycloak |
| **Observability** | Login/enrolment events, coverage dashboard | Keycloak events → CloudWatch | all |

**Rule that keeps coupling low:** Keycloak owns *credentials*. The portal owns the *account mapping and campaign state*. They are joined only by the opaque `sub` and the passthrough `verimi_sub` claim. Neither side reaches into the other's database.

### Phase model (still valid)

```
PHASE A (today)          PHASE B (now → 2026-12-31)        PHASE C (after cutoff)
portal → Verimi          portal → Keycloak → Verimi        portal → Keycloak only
no passkeys              first login bootstraps passkey     passkey / recovery only
```

This implementation targets **Phase B**, with the Phase C switch being a one-line config change (remove `kc_idp_hint`, delete the IdP).

---

## 2. Robust design (failure isolation)

| Failure | Behaviour | Why it's robust |
|---|---|---|
| Verimi slow/down during Phase B | Login for users without an enrolled hint fails; users with a valid `__Host-pk_enrolled` JWE can use the explicit passkey button and skip Verimi | The encrypted enrolment hint acts as a bulkhead; on a new device the user still needs the bootstrap IdP |
| Keycloak down during Phase B | Login fails closed | Keycloak is the credential authority. A direct-Verimi fallback was considered but is **not implemented**, because it would bypass the migration/BFF session and create a second security model |
| DynamoDB portal-state write fails after successful Keycloak login | Login still succeeds; the enrolment cache write is retried on the next callback. Session creation failure fails closed | Credential truth lives in Keycloak; the portal user record is a cache. Revocable session creation is part of the security boundary |
| Lambda cold start | `openid-client` Configuration + cached JWKS; JWE keys from env; no DB call on `/auth/login` | Sub-100 ms start of the redirect after warm discovery |
| Browser loses `__Host-pk_tx` transaction cookie | `state` check fails → login aborted with a clear error, never a silent mismatch | Fail closed |
| User removes `kc_action` from URL | BFF **does not trust** `kc_action_status`; it asks Keycloak's Account API whether a `webauthn-passwordless` credential actually exists | Keycloak's own docs explicitly warn about this |
| Duplicate enrolment clicks | `skip_if_exists` makes the AIA a no-op; Account API check is idempotent | No duplicate credentials, no double writes |

**Consistency model:** credential state is *strongly consistent* in Keycloak (authoritative). Portal `passkeyEnrolled` is *eventually consistent* (re-verified from Keycloak on every callback and on `/me` if stale).

---

## 3. Scalable design (millions of users)

- **Stateless redirect transactions.** `state`, `nonce`, `code_verifier` travel in a short-lived encrypted cookie. Lambda needs no sticky session for the OIDC round-trip.
- **Small, linear server-side state.** The portal keeps two DynamoDB tables: a user cache keyed by `kcSub`, and revocable sessions keyed by `sid`. Both are on-demand, KMS-encrypted, TTL/PITR-enabled where appropriate, and accessed with least-privilege IAM. This is a deliberate trade-off: session revocation is worth the extra DynamoDB call.
- **Keycloak is the stateful credential authority.** Postgres stores users and WebAuthn public keys. 10 M users ≈ tens of GB — manageable with managed Postgres or a cluster later.
- **`openid-client` Configuration cached per realm/client** across invocations; JWKS is fetched once and cached by `oauth4webapi`. No per-login discovery or JWKS round-trip.
- **Token endpoint called once per login** (code exchange). No introspection on the hot path; ID token claims and JWS signature are verified locally by `openid-client` with `enableNonRepudiationChecks`.
- **One realm per portal** = natural data partition. A hot portal cannot fill the DB for another; realms can be moved to separate Keycloak clusters later without code changes.
- **IONOS single VPS is the current SPOF.** Migration path: managed Postgres + Keycloak cluster behind the same nginx/ALB. The portal BFF only knows the public HTTPS Keycloak URL for discovery/redirects plus `KC_BASE_URL` for the Account API, so this remains config-only.
- **Redirects are cheap.** Phase B adds one browser hop (portal → KC → Verimi → KC → portal). No extra server cost.

---

## 4. Secure design (threat model)

| Threat | Mitigation in this implementation |
|---|---|
| **CSRF on login callback** | Random `state` in encrypted `__Host-pk_tx` cookie, compared with `crypto.timingSafeEqual` to the `state` query param |
| **Authorization code injection / replay** | PKCE `S256`; verifier never leaves the encrypted cookie; code is single-use at Keycloak |
| **ID token forgery** | `openid-client` (`oauth4webapi`) validates `iss`, `aud`, `azp`, `exp`, `iat`, `nonce`, `alg` **and** the JWS signature against the realm JWKS (`enableNonRepudiationChecks`) |
| **XSS steals session** | Token never in browser JS. Session cookie is `HttpOnly` + `Secure` + `SameSite=Lax` + `__Host-` prefix |
| **Subdomain cookie injection** | `__Host-` prefix forbids `Domain`; cookies scoped to `Path=/` on the exact portal host |
| **Cross-site POST-based login CSRF** | `SameSite=Lax` + state check; callback only accepts GET |
| **Client secret leak** | Secret lives in Lambda env (Secrets Manager in prod), never in React bundle. Confidential client + PKCE (both) |
| **Host-header injection / open redirect** | In AWS, `requestContext.domainName` (set by API Gateway from the custom domain) is authoritative; locally `DEV_PORTAL_HOST`/Host is only used with `INSECURE_COOKIES=true`. `PORTALS_JSON` allowlist; unknown host → 400. Redirect target is a fixed path `/?...`, never user input |
| **Admin-API privilege escalation** | **No admin credentials anywhere.** Enrolment verification uses the *user's own* access token against Keycloak's Account API (`GET /realms/{realm}/account/credentials?type=webauthn-passwordless`) |
| **Fake `kc_action_status=success`** | Ignored for the security decision; only used for UI wording. Truth comes from the Account API |
| **Session fixation** | New session JWE with fresh `sid` on every successful callback; transaction cookie is cleared |
| **Redirect_uri abuse** | Exact URI per realm/client, no wildcards; Lambda reuses the *configured* URI, not a client-supplied one |
| **Brute force at Keycloak** | nginx rate limit on `/realms/*/protocol/openid-connect/*`; Keycloak brute-force detection enabled in realm config |
| **RP-ID confusion** | RP ID frozen as `gateway-vw.de` before first enrolment (registrable parent of `kc.gateway-vw.de`) — never change it |
| **Token leakage via logs** | Structured logs log `sub`, `portal`, `flow`, `status` — never tokens, codes, verifiers, or cookies |
| **Verimi `sub` collision across portals** | Namespaced by realm; `verimi_sub` is unique within a realm |

### Why the Account API instead of an admin API?

Keycloak's own AIA documentation says: *"Even if the parameter `kc_action` was used, it is not sufficient to assume that the user always performs the action … the client application may need to check the claims like `acr` in the tokens."* We do better: we query Keycloak with the **user's bearer token**. That needs no service account, no `realm-management` role, and no new attack surface. The realm must assign the `view-profile` role (via the `roles` default client scope) to the portal client — documented in `keycloak/README.md`.

---

## 5. C4 diagrams (ASCII)

### 5.1 Level 1 — System Context

```
                         ┌────────────────────────┐
                         │   User (browser)       │
                         │  vw-baev.de / ltkv.de  │
                         └───────────┬────────────┘
                                     │ HTTPS
              ┌──────────────────────┼───────────────────────┐
              ▼                      ▼                       ▼
   ┌──────────────────┐   ┌────────────────────┐   ┌─────────────────────┐
   │ 9 Portals        │   │ Keycloak (IONOS)   │   │ Verimi (external)   │
   │ React SPA        │   │ kc.gateway-vw.de   │   │ OIDC IdP            │
   │ + Lambda BFF     │◄─►│ 9 realms           │◄─►│ shut down 2026-12-31│
   └────────┬─────────┘   └─────────┬──────────┘   └─────────────────────┘
            │                       │
            ▼                       ▼
   ┌──────────────────┐   ┌────────────────────┐
   │ DynamoDB         │   │ Postgres (Docker)  │
   │ account↔sub,     │   │ users + passkeys   │
   │ enrolment flag   │   │                    │
   └──────────────────┘   └────────────────────┘
```

### 5.2 Level 2 — Containers (one portal shown; ×9)

```
  ┌──────────────────────────────────────────────────────────────────────────┐
  │ Portal host: vw-baev.de                                                  │
  │                                                                          │
  │  ┌────────────────────────┐        ┌──────────────────────────────────┐  │
  │  │ React SPA              │        │ AWS Lambda BFF (shared function) │  │
  │  │ - /login button        │───────►│ /auth/login                     │  │
  │  │ - passkey banner       │  JSON  │ /auth/enroll                    │  │
  │  │ - status message       │◄───────│ /auth/callback                  │  │
  │  └────────────────────────┘        │ /me, /auth/logout               │  │
  │                                    └───────┬──────────────┬───────────┘  │
  └────────────────────────────────────────────┼──────────────┼─────────────┘
                                               │              │
                       OIDC authorize + token  │              │ DynamoDB
                                               ▼              ▼
  ┌──────────────────────────────────────────────────┐  ┌──────────────────┐
  │ nginx :8443 → Keycloak realm vw-beav             │  │ passkey-migration│
  │  - IdP: verimi (OIDC)                            │  │ table            │
  │  - client: portal-spa (confidential + PKCE)      │  └──────────────────┘
  │  - WebAuthn passwordless policy, RP gateway-vw.de│
  └───────────────┬──────────────────┬───────────────┘
                  │                  │
                  ▼                  ▼
         ┌────────────────┐  ┌──────────────────────┐
         │ Verimi OIDC    │  │ Postgres (public keys)│
         └────────────────┘  └──────────────────────┘
```

### 5.3 Level 3 — Sequence: FIRST login (Phase B, no passkey yet)

```
 Browser          React SPA        Lambda BFF        Keycloak(vw-beav)      Verimi        Postgres/DDB
   │                 │                 │                    │                 │              │
   │ click Login     │                 │                    │                 │              │
   │────────────────►│                 │                    │                 │              │
   │                 │ GET /auth/login │                    │                 │              │
   │                 │───────────────►│                    │                 │              │
   │                 │                 │ seal tx JWE        │                 │              │
   │                 │                 │ (state,nonce,      │                 │              │
   │                 │                 │  verifier,flow)    │                 │              │
   │                 │◄───────────────│ Set-Cookie:        │                 │              │
   │                 │                 │ __Host-pk_tx       │                 │              │
   │                 │ {authorizationUrl}                  │                 │              │
   │                 │◄───────────────│                    │                 │              │
   │ location.assign │                 │                    │                 │              │
   │──────────────────────────────────────────────────────►│                 │              │
   │                 │                 │  GET /auth?...&kc_idp_hint=verimi   │              │
   │                 │                 │◄───────────────────│                 │              │
   │                 │                 │  302 → Verimi /authorize            │              │
   │◄────────────────────────────────────────────────────────────────────────│              │
   │ user types credentials at Verimi (Verimi code UNCHANGED)                │              │
   │────────────────────────────────────────────────────────────────────────►│              │
   │◄──────────────────────────────── 302 broker/verimi/endpoint ────────────│              │
   │────────────────────────────────────────────────────────────────────────►│ JIT user     │
   │◄── 302 https://vw-baev.de/api/auth/callback?code=…&state=… ─────────────│ (Postgres)   │
   │                 │                 │                    │                 │              │
   │ GET /api/auth/callback?code&state │                    │                 │              │
   │──────────────────────────────────►│                    │                 │              │
   │                 │                 │ open tx JWE        │                 │              │
   │                 │                 │ compare state      │                 │              │
   │                 │                 │ POST /token        │                 │              │
   │                 │                 │───────────────────►│                 │              │
   │                 │                 │◄── id/access token─│                 │              │
   │                 │                 │ openid-client:     │                 │              │
   │                 │                 │ nonce + JWKS sig   │                 │              │
   │                 │                 │ GET /account/       │                 │              │
   │                 │                 │  credentials       │                 │              │
   │                 │                 │───────────────────►│ (user bearer)  │              │
   │                 │                 │ no passkey yet     │                 │              │
   │                 │                 │ put user (false)   │──────────────────────────────►│
   │◄── 302 /?login=success, Set-Cookie __Host-pksid (JWE) ─│                 │              │
   │                 │                 │                    │                 │              │
   │ SPA calls GET /me → {authenticated:true, passkeyEnrolled:false}         │              │
   │                 │                 │                    │                 │              │
   │            ┌────────────────────────────────────────┐   │                 │              │
   │            │ BANNER: "Secure your account with a   │   │                 │              │
   │            │ passkey"  ← your step 8               │   │                 │              │
   │            └────────────────────────────────────────┘   │                 │              │
```

### 5.4 Level 3 — Sequence: passkey enrolment (your steps 9–10)

```
 Browser        React SPA        Lambda BFF        Keycloak          Authenticator      Postgres
   │                │                 │                │                   │                │
   │ click banner   │                 │                │                   │                │
   │───────────────►│                 │                │                   │                │
   │                │ GET /auth/enroll│                │                   │                │
   │                │ (+__Host-pksid) │                │                   │                │
   │                │────────────────►│                │                   │                │
   │                │                 │ require session│                   │                │
   │                │                 │ seal NEW tx     │                   │                │
   │                │                 │ kc_action=       │                   │                │
   │                │                 │ webauthn-register│                  │                │
   │                │                 │ -passwordless:   │                   │                │
   │                │                 │ skip_if_exists  │                   │                │
   │                │◄────────────────│ authorizationUrl│                   │                │
   │ location.assign (NO kc_idp_hint — Keycloak SSO cookie already exists)  │                │
   │───────────────────────────────────────────────────►│                   │                │
   │                                     AIA runs on KC origin             │                │
   │◄──────────────── WebAuthn ceremony (QR / USB / biometric) ────────────►│                │
   │                                     verify + store public key ─────────────────────────►│
   │◄── 302 /api/auth/callback?code&state&kc_action_status=success ────────│                │
   │                 │                 │                │                   │                │
   │ GET /api/auth/callback?...        │                │                   │                │
   │──────────────────────────────────►│                │                   │                │
   │                 │                 │ validate state │                   │                │
   │                 │                 │ exchange code  │                   │                │
   │                 │                 │ GET /account/   │                   │                │
   │                 │                 │ credentials?   │                   │                │
   │                 │                 │ type=webauthn- │                   │                │
   │                 │                 │ passwordless   │                   │                │
   │                 │                 │───────────────►│                   │                │
   │                 │                 │◄─ credential ──│                   │                │
   │                 │                 │ ✔ passkey REAL │                   │                │
   │                 │                 │ set flag +      │──────────────────────────────────►│
   │                 │                 │ __Host-pk_enrolled=1                 │                │
   │◄── 302 /?passkey=created ─────────│                │                   │                │
   │ banner disappears                 │                │                   │                │
```

### 5.5 Level 3 — Sequence: later login (passkey exists, Verimi bypassed)

```
 Browser → BFF GET /auth/login  (reads __Host-pk_enrolled=1)
 BFF → Browser {authorizationUrl} with NO kc_idp_hint
 Browser → Keycloak /auth?...  (Keycloak SSO cookie present too)
 Keycloak → Browser passkey prompt (conditional/modal UI, RP gateway-vw.de)
 Browser ↔ Authenticator WebAuthn get()
 Keycloak verifies signature → 302 → BFF /auth/callback?code&state
 BFF validates, sets new __Host-pksid → 302 /?login=success
 ⇒ ZERO calls to Verimi. ✅
```

---

## 6. Implementation map — `impl-broker-bff/`

```
impl-broker-bff/
├── backend/                       AWS Lambda BFF (Node 24 ESM)
│   ├── src/config.js                fail-closed zod env + portal allowlist
│   ├── src/crypto.js                jose JWE, CSPRNG, timing-safe compare
│   ├── src/cookies.js               __Host- cookies via `cookie`
│   ├── src/http.js                  security headers, domain allowlist, reason allowlist
│   ├── src/oidc.js                  openid-client OIDC protocol + Account API
│   ├── src/store.js                 DynamoDB user cache + revocable sessions
│   ├── src/session.js               JWE readers, rotation, revocation
│   ├── src/handlers/*.js            login / enroll / callback / me / logout
│   ├── src/router.js                API Gateway v2 router, /api normalization
│   ├── src/handler.js               Lambda entry point
│   ├── src/local-server.js          local dev server
│   ├── tests/flow.test.js           21 node:test tests (incl. JWS/nonce rejection)
│   ├── template.yaml                production SAM/CloudFormation
│   └── ops/                         portal manifest, generators, preflight, verify
├── frontend/                      React + TypeScript + Vite + CSP
├── keycloak/
│   ├── realm-template.json          generated realm source (vault refs)
│   ├── realm-vw-beav.json           example realm with Verimi placeholders
│   ├── generated/                   generated 9 realms (gitignored)
│   ├── docker/Dockerfile            Keycloak file-vault image
│   └── README.md                    exact Admin Console verification steps
├── nginx/                         public/admin vhosts, rate limits, allowlist
├── mock-vps/                      local Node-only topology emulator
├── PRODUCTION.md                  full deployment runbook
├── README.md                      quickstart + endpoint map
└── docker-compose.yml             nginx / Keycloak / Postgres
```

### Security libraries used (nothing hand-rolled)

| Task | Library | Why |
|---|---|---|
| OIDC protocol (discovery, authorize, code grant, state/nonce/PKCE, ID token claims + JWS) | **`openid-client` 6.9.1** | Server-side OIDC/RP library built on `oauth4webapi`; `enableNonRepudiationChecks` verifies the ID token signature against realm JWKS |
| Encrypted BFF cookies | **`jose`** | `EncryptJWT` / `jwtDecrypt`, `dir` + `A256GCM`, issuer/audience/expiry and key rotation |
| Cookie parse/serialize | **`cookie`** | Correct escaping, `Max-Age`, `SameSite`, `__Host-` handling |
| Input validation | **`zod` 4.6.7** | Schema validation of env + query params; fail closed; patched DoS advisory |
| Randomness and timing-safe compare | **Node `crypto`** | CSPRNG (`randomBytes`) for state/nonce/IDs; `timingSafeEqual` for comparisons |
| DynamoDB access | **`@aws-sdk/lib-dynamodb`** | Native AWS SDK, IAM-scoped |
| Frontend fetch | native `fetch` + TS types | No token handling in frontend by design |

---

## 7. Suggestions / open tasks

1. **Highest priority: supply the real production inputs** listed in `impl-broker-bff/PRODUCTION.md` §0. Until then the system is deliberately fail-closed.
2. **Enrolment coverage dashboard.** Per realm: total active users, `passkeyEnrolled=true`, outstanding. Escalate weekly before 2026-12-31. The encrypted `__Host-pk_enrolled` hint is browser-local — a user on a new device is sent through Verimi once more even if enrolled elsewhere. That is correct and safe, but the dashboard must reflect it.
3. **Phase C switch:** set `Phase=C`, remove the Verimi IdP and its mappers from all 9 realms, rotate/delete Verimi secrets. Runbook exists in `PRODUCTION.md` §11.
4. **Recovery flow:** recovery codes + a documented support path for lost devices, tested *before* Verimi shuts down.
5. **Keycloak HA:** managed Postgres + clustered Keycloak before scaling past the IONOS VPS. Portal code is config-only to migrate.
6. **Custom theme:** verify the WebAuthn FTL templates in your exact Keycloak 26.8 version.
7. **Check `webAuthnPolicyPasswordlessPasskeysEnabled` after realm import** — a partial Admin REST update can silently revert it. Verify in the Admin Console and re-export the realm.
8. **Keycloak events → CloudWatch/SIEM:** alert on `CREDENTIAL_REGISTER` bursts, login failures from Verimi, and `account_api_denied` warnings from the BFF.
9. **Load test** both redirect chains at peak, especially the AIA enrolment hop.
10. **Optional direct-Verimi fallback** during Phase B was rejected for now: it would bypass the BFF session model. Revisit only as a separate, security-reviewed emergency path.

---

## 8. Litmus check (per `software-architecture-principles.md`)

| Principle | Status | Evidence |
|---|---|---|
| Separation of Concerns | ✅ | Keycloak = credentials; BFF = session + mapping; SPA = UX |
| Encapsulation | ✅ | Browser never sees tokens, client secret, or Keycloak internals |
| Dependency Inversion | ✅ | Portal depends on OIDC endpoints + Account API, not Keycloak internals |
| Loose Coupling | ✅ | Redirect-based; Verimi broker config change needs zero portal code changes |
| Idempotency | ✅ | `skip_if_exists` + Account API re-check + stateless cookies |
| Graceful Degradation | ⚠️ | Fail-closed if Keycloak/Verimi is down; enrolled-hint cookie avoids Verimi on known devices. Direct-Verimi fallback deliberately not implemented |
| Consistency Model Clarity | ✅ | Credentials strong; campaign flag eventual |
| Security by Design | ✅ | No admin secret, PKCE, state/nonce/azp, JWE cookies, allowlisted hosts |
| Observability | ⚠️ | Coverage dashboard is open task #1 |
| Testability | ✅ | In-memory store + injectable keys → unit tests without AWS/Keycloak |
| Fallacies of Distributed Computing | ✅ | Timeouts, fail-closed state check, retries on DB write, no assumption of reliable network |

---

## Addendum — local IONOS VPS mock (2026-11-20)

Because the production VPS is temporarily unavailable, a local Node-only mock was
added at `impl-broker-bff/mock-vps/`. It is a **test double**, not a second
architecture. It preserves the same trust boundaries:

- Browser → React SPA `localhost:5173`
- SPA → BFF `/api/*` (same origin via Vite proxy)
- BFF → mock public Keycloak `localhost:9443`
- Mock Keycloak → mock Verimi (only while `PHASE=B` and no enrolled cookie)
- No admin console is exposed by the mock.

Verified end-to-end:

1. login → `kc_idp_hint=verimi`, PKCE `S256`
2. mock Verimi login → broker → callback → session cookie
3. `/api/me` → `passkeyEnrolled:false`
4. AIA enrolment (`kc_action=webauthn-register-passwordless:skip_if_exists`, no `kc_idp_hint`)
5. Account API proves credential → `/api/me` → `passkeyEnrolled:true`
6. next login → no `kc_idp_hint`, passkey page, Verimi not contacted

### Admin-plane decision

`kc-admin.gateway-vw.de:8444` MUST remain unreachable from untrusted networks.
The production nginx config now fails closed with `deny all`; trusted
office/VPN/bastion CIDRs must be added explicitly before it becomes usable.
This is a deliberate security boundary: the public login origin and the admin
origin must not share exposure.

### Explicit passkey login button (later addition)

The SPA now offers two explicit login buttons. The distinction is only a routing
choice made by the BFF; Keycloak remains the credential authority:

```text
Mit Verimi anmelden  -> GET /api/auth/login?method=verimi -> kc_idp_hint=verimi
Mit Passkey anmelden -> GET /api/auth/login?method=passkey -> NO kc_idp_hint
                        -> Keycloak passkey form, WebAuthn on kc.gateway-vw.de
```

No `kc_action` is used for login; `kc_action` remains enrolment-only.
The realm uses passkey mediation `optional` so clicking the portal's passkey
button opens the passkey chooser immediately, while Keycloak's themed
"Sign in with Passkey" button remains available as a fallback.

### Separate-port local emulation of the IONOS VPS (later addition)

To make the deployment boundaries visible without Docker/Java, a second local
mode was added under `impl-broker-bff/mock-vps/emulated/`. It deliberately uses
separate processes and separate ports:

```text
Portal SPA     :5173
BFF            :3001  (via Vite /api proxy)
public nginx   :8443  -> Keycloak internal :8080
admin  nginx   :8444  -> IP allow/deny, then Keycloak :8080
Keycloak mock  :8080  (not reachable directly from the browser)
Verimi mock    :3443  (separate external origin)
Postgres mock  :55432 (persistent JSON state store)
```

Why this matters architecturally: the old `:9443` mock hid the most important
security boundary — the browser must talk to the **public Keycloak origin**,
never to an internal container port. The emulator makes that boundary explicit.
It also restores the admin-plane control that was absent in the simple mock:
`:8444` fails closed and only allowlisted IPs reach the admin console.

The emulator is still not production: no TLS, no real WebAuthn, no Postgres wire
protocol. It is a topology/safety emulator, not a runtime replacement. The
real nginx/Keycloak/Postgres containers remain the production target.

### Upstream authorization parameters sent to Verimi (production)

The local Verimi mock intentionally accepts only `state`. Real Keycloak 26.8 as
an OIDC broker sends a complete authorization request to the configured
`authorizationUrl`. For the current `vw-beav` realm config the mandatory set is:

```text
GET https://REPLACE_VERIMI_HOST/oauth/authorize
  ?scope=openid%20profile%20email
  &state=<KEYCLOAK_BROKER_STATE>
  &response_type=code
  &client_id=REPLACE_VERIMI_CLIENT_ID
  &redirect_uri=https%3A%2F%2Fkc.gateway-vw.de%3A8443%2Frealms%2Fvw-beav%2Fbroker%2Fverimi%2Fendpoint
  &nonce=<RANDOM>
```

Keycloak generates its **own** `state`/`nonce` for the upstream Verimi request.
The `state` created by our BFF is kept by Keycloak and returned unchanged to
the portal callback later. Therefore:

```text
Portal -> Keycloak : state=<BFF_STATE>
Keycloak -> Verimi : state=<KC_BROKER_STATE>   (different)
Verimi -> Keycloak : state=<KC_BROKER_STATE>
Keycloak -> Portal : state=<BFF_STATE>         (original returned)
```

`client_secret` is never placed in the browser URL. It is used server-side by
Keycloak at the token endpoint (`client_secret_post` in this realm).

Optional parameters are added only if the IdP config enables them: `login_hint`,
`ui_locales`, `prompt`, `code_challenge`/`code_challenge_method` (broker PKCE),
`max_age`, and forwarded parameters such as `acr_values`. None of those are
currently enabled in `realm-vw-beav.json`; the BFF PKCE challenge belongs to
the Portal→Keycloak leg, not to the Keycloak→Verimi leg.

Open task: confirm Verimi accepts the full standard request and especially the
exact broker `redirect_uri`. If Verimi cannot handle long `state` values, use
Keycloak's "Requires short state parameter" setting instead of hand-crafting a
non-standard URL.

---

## Addendum — production hardening pass (2026-11-20, final)

The earlier sections describe the architecture. This addendum records what the
implementation now actually enforces, and what still requires your real values.

### A.1 What changed in the production-shaped implementation

| Area | Before | Now |
|---|---|---|
| Runtime | Node 20 | **Node 24** Lambda runtime |
| Portal resolution | browser `Host` header | AWS uses `requestContext.domainName`; local Host only with `INSECURE_COOKIES=true` |
| Session cookie | stateless JWE only | JWE + revocable DynamoDB session record with TTL |
| Logout | cleared cookies | revokes session record, clears cookies, calls Keycloak end-session endpoint |
| Enrolment hint | plain cookie value | independent encrypted, portal-bound and `sub`-bound JWE |
| Key rotation | none | three keys + `*_PREVIOUS_*` rotation keys |
| Secrets | prototype env vars | Secrets Manager dynamic references, no plaintext in template/git |
| DynamoDB | one table | user cache + session table, KMS SSE, PITR, least-privilege IAM |
| API Gateway | execute-api enabled | `DisableExecuteApiEndpoint: true`, throttling, access logs, optional WAF |
| Keycloak startup | `start-dev` | production `start`, file vault, hostname v2, trusted proxy required |
| Admin console | commented allow rules | `include admin-allow.conf; deny all;` fail-closed |
| Public Keycloak vhost | catch-all proxy | default `return 444`, admin path blocked, rate limits |
| Frontend build | could ship localhost URLs | production build refuses non-production Keycloak origin; CSP added |
| Deployment | manual | generators + preflight + read-only Keycloak verifier + full runbook |

### A.2 Trust boundaries after hardening

```text
 Browser (portal host)
   │ fetch /api/*  (same origin, __Host- cookies)
   ▼
 API Gateway custom domain /api
   │ requestContext.domainName = authoritative portal host
   ▼
 Lambda BFF
   │ secret: Secrets Manager dynamic refs
   │ state: DynamoDB user cache + sessions
   │ OIDC: KC_PUBLIC_URL for browser URLs/iss, KC_BASE_URL for server calls
   ▼
 nginx :8443 ──proxy──► Keycloak :8080 ──► Postgres
   │                       │
   │                       └──broker──► Verimi (Phase B only)
   │
 nginx :8444 (separate admin host) ──allowlist then deny all──► Keycloak
```

Important distinction:

- `KC_PUBLIC_URL` is what browsers see and what `openid-client` uses for
  discovery and the expected token `iss`. It must be
  `https://kc.gateway-vw.de:8443` and must be resolvable from Lambda.
- `KC_BASE_URL` is what Lambda uses for server-side Account API credential
  checks. It can differ in private networking, but in the current deployment
  it is the same URL.

Mixing these two up is a classic Keycloak hostname-v2 bug: the browser is sent
to the right host, but ID token issuer validation fails because `iss` is built
from a different hostname.

### A.3 Why there are now three encryption keys

```text
TX key       protects the 10-minute OIDC transaction cookie
             (state, nonce, PKCE verifier, flow, portal)

SESSION key  protects the portal session cookie
             (sub, portal, sid) — tied to a revocable DynamoDB record

ENROLLED key protects the "this browser already has a passkey" hint
             (sub, enrolled boolean) — UX metadata only, not authority
```

Separation matters. If one key were reused, a flaw or misuse in one cookie
class would affect all cookie classes. The previous-key slots allow rotation
without logging every user out.

### A.4 Why sessions are no longer purely stateless

The original `architecture_11-20-2026.md` claimed a stateless BFF. That was a
reasonable prototype trade-off, but it meant logout could only clear the
browser cookie: a copied cookie remained usable until expiry.

Production now stores a minimal session record:

```text
sid, kcSub, portal, realm, revoked, createdAt, expiresAt
```

The JWE cookie still cannot be forged. The DynamoDB record adds one property:
the BFF can revoke it. That is a necessary security capability for lost
devices, support incidents, and Phase C cleanup. It costs one DynamoDB
`GetItem` per authenticated request, which is trivial at the expected scale.

### A.5 Fail-closed rules you should expect to see

The system intentionally refuses to start/deploy when:

- `PORTALS_JSON` does not contain exactly 9 portals in AWS;
- realms are duplicated;
- redirect URIs are not `https://<portal-host>/api/auth/callback`;
- `INSECURE_COOKIES` or `DEV_PORTAL_HOST` is set in AWS;
- `STORE=memory` is set in AWS;
- any JWE key is not exactly 32-byte base64url;
- `REPLACE_*` appears in credentials or realm metadata;
- Verimi signature validation, `jwksUrl`, or vault references are missing;
- admin nginx config loses its default `deny all`;
- production frontend bundle contains `localhost:8443` or `localhost:9443`.

These are features, not bugs. They stop a misconfiguration from becoming a
silent security downgrade.

### A.6 Validation performed in this workspace

```text
backend npm test                        21/21 pass
frontend npm run build:production       pass
CloudFormation YAML syntax               pass
ops generate realms (9)                  pass, all JSON parses
ops generate api domains (9)             pass
preflight with placeholders              fails on portal placeholders as designed
preflight with synthetic 9 portals       20/20 checks pass
emulated full flow                       pass:
  Verimi login → passkeyEnrolled:false
  enrolment → passkeyEnrolled:true
  explicit passkey login → no kc_idp_hint
  logout → unauthenticated
admin mock deny/allow                    pass (8.8.8.8 → 403, 127.0.0.1 → 200)
sam validate                             skipped: sam CLI not installed
```

### A.7 Remaining production blockers (all external inputs)

The code is ready; the deployment is not, until you provide:

1. exact Verimi authorization/token/userinfo/JWKS/issuer/client ID/client secrets;
2. the 7 unknown portal hostnames, realm names, and display names;
3. trusted admin IPs/CIDRs for `nginx/admin-allow.conf`;
4. ACM certificate ARN, KMS key ARN, optional WAF ARN;
5. real IONOS TLS certificate covering both Keycloak hostnames;
6. confirmation that the Keycloak account audience mapper and `view-profile`
   role survived realm import.

Until those are supplied, `backend/ops/portals.json`,
`backend/ops/portal-secrets.json`, `keycloak/realm-vw-beav.json`, and generated
output intentionally remain placeholders/gitignored.

The detailed step-by-step deployment checklist is
`impl-broker-bff/PRODUCTION.md`.

---

## Addendum — OIDC protocol library decision (2026-11-20, final)

The production implementation now uses the right library for the right layer:

```text
openid-client 6.9.1  → OIDC protocol with Keycloak
jose                 → encrypted BFF cookies only
Node crypto          → random state/nonce/session IDs and timing-safe compare
cookie               → cookie serialization
zod                  → fail-closed configuration validation
```

This change was made because `jose` is a JOSE/crypto library, not an OIDC
protocol client. The old code used `jose.jwtVerify()` directly, which was not
"hand-rolled crypto", but it did mean we manually assembled discovery, token
exchange, claim checks and JWKS handling. `openid-client` is the maintained
server-side OIDC/RP library (built on `oauth4webapi`) and is the correct tool for
the Portal→Keycloak leg.

`oidc-client-ts` was evaluated and rejected: it is a browser-token SPA library.
It would put OIDC state and tokens in the React app and contradicts the BFF rule:
**the browser never sees tokens**.

### Important security detail: opt-in signature verification

`openid-client` validates `iss`, `aud`, `azp`, `exp`, `iat` and `nonce`, but
JWS signature verification is opt-in via:

```js
client.enableNonRepudiationChecks
```

That option is now enabled for every discovered realm Configuration. Without it,
a token from the token endpoint would be accepted based on TLS + client auth
alone. With it, the ID token signature is checked against the realm JWKS. A
unit test signs a token with a **wrong private key** and asserts rejection, so
this cannot silently regress.

### Who calls whom after the refactor

```text
React SPA
  │ GET /api/auth/login?method=verimi|passkey
  ▼
BFF Lambda
  │ openid-client.discovery()             → KC_PUBLIC_URL/realms/{realm}/.well-known/openid-configuration
  │ openid-client.buildAuthorizationUrl() → 302 to Keycloak /protocol/openid-connect/auth
  ▼
Browser → Keycloak → (Verimi in Phase B) → Browser
  │ GET /api/auth/callback?code&state
  ▼
BFF Lambda
  │ openid-client.authorizationCodeGrant() → Keycloak /token
  │ enableNonRepudiationChecks             → Keycloak JWKS
  │ jose.open/seal                         → encrypted __Host- cookies
  ▼
React SPA authenticated
```

Deployment note: because discovery uses `KC_PUBLIC_URL`, the public Keycloak
hostname must be resolvable not only by browsers but also by the Lambda BFF.
In the current deployment `KC_PUBLIC_URL == KC_BASE_URL`, so this is already
satisfied. If private networking is introduced later, keep the discovery URL
public and use `KC_BASE_URL` only for the Account API call.

Local-only flag `ALLOW_INSECURE_OIDC=true` exists for the HTTP emulator. It is
rejected at cold start in AWS.
