# Architecture: Verimi → Keycloak/Passkey Migration (Q&A follow-up)

**Project:** keycloak-passkey
**Date:** 2026-11-15
**Scope:** Answer to questions (a) possibility/production-readiness, (b) impersonation, (c) alternatives, plus robust/scalable/secure design.

---

## 0. Direct answers (TL;DR)

| # | Question | Answer |
|---|----------|--------|
| **a** | Possible & production-ready? | **Yes**, but NOT by having Lambda create the Keycloak user and NOT by impersonation. Use Keycloak **Identity Brokering** (Verimi as upstream IdP) + **Application Initiated Actions (AIA)**. No Java, no Verimi changes. |
| **b** | Impersonation recommended & secure? | **No.** It turns Lambda into an account-takeover primitive. Use only for support/debug, never for the enrolment flow. |
| **c** | Alternatives? | (1) Identity Brokering + AIA (recommended, most standard). (2) Admin API provisioning + required actions. (3) Forced required action at first login. Best = (1) combined with (3) for the migration campaign. |

---

## 1. Why the originally proposed flow is wrong (and how to fix it)

Proposed: Verimi login → popup → Lambda creates Keycloak user → passkey registration.

Problems:
- **Chicken-and-egg session**: WebAuthn registration in Keycloak requires an **active Keycloak SSO session** in the browser. Lambda creating a user server-side does not create a browser session.
- **Secrets in Lambda**: Admin API needs a service account with realm-management rights → a high-value secret in Lambda env → blast radius if leaked.
- **No audit trail of "who vouched"**: Keycloak would see an admin-created user, not a Verimi-authenticated one.
- **Race/duplicate users**: 9 portals × retries → duplicate accounts unless idempotency keys are perfect.

Fix: **Make Keycloak the front door.** ⚠️ This is a **target-state change**: today the portals redirect *directly* to Verimi (Phase A in §2.1). Verimi becomes an upstream IdP that Keycloak brokers. Keycloak auto-provisions the user on first successful Verimi login (JIT). The portal then triggers passkey registration with one redirect. **Verimi is still required for the first login — by design — until the passkey exists.**

---

## 2. Domain decomposition (DDD)

| Bounded Context | Responsibility | Owner |
|-----------------|----------------|-------|
| Identity & Authentication | Verify identity, issue sessions/tokens, store passkeys | Keycloak (Verimi temporary upstream) |
| Identity Linking | Map `portal_account_id` ↔ Keycloak `sub` | Portal DB (AWS) |
| Authorization | Roles/entitlements | Portal + Keycloak roles |
| Enrolment Campaign | Drive users to create passkeys, track progress | Portal SPA + Lambda |
| Recovery | Regain access on lost passkey | Keycloak (recovery codes + admin reset) |

Rule: portal owns account↔sub mapping; Keycloak owns credentials. Joined only by opaque `sub`.

### 2.1 Phase model — read this before any diagram

The original diagram was misleading because it showed only the **target** state. There are three phases:

| Phase | Front door | Is Verimi needed to enter the portal? | Passkey state |
|-------|-----------|----------------------------------------|---------------|
| **A — today** | Verimi (direct from portal) | ✅ **Yes, always.** No Verimi = no portal. | none |
| **B — transition** | Keycloak → brokers Verimi | First login: ✅ Yes. Later logins: ❌ No (passkey). | bootstrapped on first login |
| **C — after 2026-12-31** | Keycloak (passkey) | ❌ No — Verimi is gone. | required (or recovery) |

Key rule: **a passkey can only be created inside an authenticated browser session.** Therefore Verimi must authenticate the user *once* before a passkey can exist. The dependency on Verimi is real but **temporary**.

---

## 3. Recommended flow (Phase B — target state; step by step, who calls whom)

```
Browser (portal.vw-baev.de)
  1. Click "Login"  ──►  Portal SPA
  2. Redirect to Keycloak authorize URL:
        https://kc.gateway-vw.de:8443/realms/vw/protocol/openid-connect/auth
          ?client_id=portal-vw-baev
          &redirect_uri=https://vw-baev.de/callback
          &response_type=code
          &scope=openid profile
          &kc_idp_hint=verimi          <-- broker Verimi
  3. Keycloak has no session → redirects to Verimi (upstream IdP)
  4. User authenticates at Verimi (unchanged Verimi code)
  5. Verimi redirects back to Keycloak with auth code/id_token
  6. Keycloak validates, JIT-provisions user (if first time), creates SSO session,
     issues authorization code to portal redirect_uri
  7. Portal SPA exchanges code for tokens at Keycloak token endpoint (via Lambda or BFF)
  8. Portal shows popup "Create a passkey" (user is now authenticated in portal)
  9. User clicks button → SPA redirects to Keycloak AGAIN with same client but:
        kc_action=webauthn-register-passwordless:skip_if_exists
        (plus prompt=none is NOT used; we want the AIA screen)
 10. Keycloak sees active SSO session → runs WebAuthn registration ceremony
     (browser talks to authenticator: QR/USB/biometric)
 11. Keycloak stores public key; redirects back with kc_action_status=success|cancelled
 12. Portal records enrolment status (via ID token claim or userinfo) and hides popup
```

**Who calls whom:**
- Browser → Keycloak: OIDC authorize (with kc_idp_hint / kc_action)
- Keycloak → Verimi: OIDC/SAML (broker, server-side)
- Verimi → Keycloak: callback
- Keycloak → Browser: redirect with code / status
- Portal SPA → Lambda (optional): token exchange / session cookie (BFF pattern recommended)
- Lambda → Keycloak token endpoint: only standard client credentials, never admin

No Java. No admin API in the enrolment path.

---

## 4. Keycloak configuration (no code)

- **Realm**: `vw` (or per-portal realms sharing a common IdP; recommend one realm + clients per portal for SSO across portals).
- **Client per portal**: `portal-vw-baev`, `portal-ltkv`, ... (confidential or public + PKCE). Redirect URIs whitelisted per domain.
- **Identity Provider**: Verimi (OIDC), with "Trust Email" / "Sync Mode" = IMPORT or FORCE; mapper maps Verimi `sub`/email to Keycloak user attributes.
- **Required Action**: enable `webauthn-register-passwordless` as a required action on first login for the migration campaign (forces enrolment before any portal access). Combine with AIA for users who skip.
- **WebAuthn policy**: RP ID = `gateway-vw.de`? ⚠️ **Decide RP ID now and never change it.** Recommended RP ID = `gateway-vw.de` (registrable domain) so all subdomains share passkeys. Actually passkeys scoped to RP ID; if portals are on different registrable domains (vw-baev.de vs gateway-vw.de), a single RP ID cannot cover both. Options:
  - Option A: RP ID = `gateway-vw.de`, portals redirect to Keycloak for login (always), passkey works. Portals never handle WebAuthn themselves. ✅ Recommended.
  - Option B: Separate realms/RP IDs per registrable domain → users enrol multiple passkeys. Worse UX.
- **Recovery**: enable Recovery Codes required action; keep email reset as fallback until Verimi shuts down.

---

## 5. Robustness

- **Idempotency**: `kc_action=...:skip_if_exists` makes repeated clicks no-ops; Keycloak returns `kc_action_status=success`.
- **Retries**: browser redirect is naturally retryable; no partial state because Keycloak is source of truth for credentials.
- **Decoupling**: portals depend only on OIDC (standard). Keycloak can be upgraded/replaced without portal code changes.
- **No SPOF in enrolment**: if Keycloak is down, users fall back to Verimi login (still active until 2026-12-31). Portal must handle Keycloak unavailability gracefully (show "try again later", keep Verimi path).
- **Dual-run window**: both Verimi-direct and Keycloak-brokered paths coexist until cutoff. Feature flag per portal.

---

## 6. Scalability

- Keycloak on IONOS VPS: single node is fine for 9 portals but is a SPOF. For millions of users, plan: Keycloak clustering (Infinispan) + separate Postgres (RDS/managed) + CDN for static assets; horizontal scale behind nginx. Today's load is low; design interfaces so migration is config-only.
- Passkey crypto is client-side; server only stores public keys → storage cost tiny.
- Lambda stays stateless; no per-user server state.

---

## 7. Security

- **No admin secrets in Lambda** in the recommended flow. Lambda only does standard OIDC token exchange with a public/confidential client (client secret rotatable, scoped to one realm).
- **No impersonation** (see §8).
- **PKCE** for all browser-initiated flows (public clients).
- **Redirect URI whitelisting** per client; exact match, no wildcards.
- **State + nonce** parameters to prevent CSRF/replay.
- **RP ID finality**: decide before first enrolment; document in runbook.
- **Audit**: Keycloak events (LOGIN, REGISTER, CREDENTIAL_REGISTER) shipped to CloudWatch/central log. Alert on anomalous registration bursts.
- **Rate limiting** at nginx on `/realms/*/protocol/openid-connect/*`.
- **MFA during transition**: keep Verimi step-up; after cutoff rely on passkey + recovery codes.
- **Token handling**: prefer BFF (Lambda sets httpOnly cookie) over storing tokens in browser storage.

---

## 8. Why NOT impersonation

Impersonation in Keycloak lets an admin (with `impersonation` role) mint a full user session. Using it for enrolment:
- Requires a powerful service account in Lambda (single compromise → total account takeover of any user).
- Bypasses the real authentication chain; Keycloak audit shows "admin impersonated X", not "user authenticated via Verimi".
- Breaks WebAuthn origin/session assumptions in subtle ways; AIA works on a *real* user session, not an impersonated one, reliably.
- Is explicitly a support/debug tool, not a production user journey.
- Creates a "super-user" code path that must be secured, rotated, and audited forever.

**Verdict: rejected for production.** Keep impersonation disabled for service accounts.

---

## 9. Alternatives considered

| Alternative | How | Pros | Cons |
|-------------|-----|------|------|
| **A. Identity Brokering + AIA** (recommended) | Verimi as IdP; AIA redirect for passkey | No admin secrets; standard; auditable; no Java | Requires Keycloak as front door (change portal login URL) |
| **B. Admin API provisioning** | Lambda creates user via Admin API with service account | Works without changing login URL | Admin secret in Lambda; duplicate-user risk; still needs AIA session → must log user in anyway |
| **C. Required action at first login** | Set `webauthn-register-passwordless` required action on JIT-provisioned user | Forces enrolment; simplest campaign | Must combine with A; users can't skip (good for migration) |
| **D. Direct WebAuthn in portal** | Portal calls navigator.credentials directly | Full control | Re-implements Keycloak crypto; not standard; RP ID mismatch with Keycloak login later → broken |

**Most standard & recommended: A + C.** Broker Verimi, JIT-provision, force required action for migration window, allow AIA re-enrolment later (recovery).

---

## 10. C4-style ASCII diagram — corrected (three phases)

> ⚠️ **Correction (2026-11-19):** the previous diagram showed only the *target* design and
> implied you could enter the portal without Verimi. That was misleading. Today (Phase A)
> login **does** require Verimi — the portals redirect to Verimi directly and Keycloak is
> not in the path at all. Verimi is only removed after a passkey exists. See §2.1.

### 10.1 Phase A — TODAY: Verimi is the front door, Keycloak is not involved

```
  ┌───────────────────────┐      ┌────────────────────────────┐      ┌─────────────────────┐
  │ Browser               │      │ Portal                     │      │ Verimi              │
  │ 9 portal domains      │─────►│ SPA + AWS Lambda           │─────►│ external IdP        │
  │ vw-baev.de, ltkv.de…  │◄─────│ portal session cookie      │◄─────│ auth + id_token     │
  └───────────────────────┘      └────────────────────────────┘      └─────────────────────┘
                                  ▲
                                  └── Keycloak / IONOS: NOT in this path

  1. Browser → Portal        GET https://vw-baev.de/login
  2. Portal  → Browser       302 → Verimi /authorize?client_id=…&redirect_uri=…&state=…
  3. Browser → Verimi        user authenticates (unchanged Verimi code)
  4. Verimi  → Portal        302 → /callback?code=…&state=…
  5. Lambda  → Verimi        POST /token (code + client secret) → id_token
  6. Portal creates session; user is IN — but ONLY because Verimi authenticated.

  ⇒ Verimi offline ⇒ steps 2-5 impossible ⇒ NO portal access.  ✅ your point is correct
```

### 10.2 Phase B — TRANSITION: Keycloak front door, Verimi broker, passkey bootstrap

```
  ┌───────────────────────┐      ┌────────────────────────────┐      ┌──────────────────────────────────┐
  │ Browser               │      │ Portal                     │      │ IONOS: nginx → Keycloak          │
  │ 9 portal domains      │─────►│ SPA + Lambda (BFF)         │─────►│ kc.gateway-vw.de:8443            │
  │ no WebAuthn here      │◄─────│ redirect target CHANGED ⚠  │◄─────│ realm vw · 9 clients · IdP:verimi│
  └──────────┬────────────┘      └────────────────────────────┘      └───┬──────────────────┬───────────┘
             │                                                          │ broker (OIDC)    │ store pubkey
             │                                                 ┌────────▼─────────┐ ┌──────▼────────────┐
             │                                                 │ Verimi           │ │ Postgres (Docker) │
             │                                                 │ upstream IdP     │ │ users + passkeys  │
             │                                                 └──────────────────┘ └───────────────────┘
             └───── authenticator (QR / USB / biometric) ◄───── WebAuthn runs at kc.gateway-vw.de:8443
                   (RP ID = gateway-vw.de; portal domains never call navigator.credentials)

  1. Browser → Portal       GET /login
  2. Portal  → Browser      302 → https://kc.gateway-vw.de:8443/realms/vw/protocol/
                            openid-connect/auth?client_id=portal-vw-baev
                            &redirect_uri=https://vw-baev.de/callback&response_type=code
                            &scope=openid+profile&state=…&nonce=…&kc_idp_hint=verimi
                            ⚠ THIS IS THE CHANGE: this URL used to point to Verimi
  3. Keycloak (no SSO cookie) → Verimi /authorize; user authenticates (Verimi code unchanged)
  4. Verimi  → Keycloak      /broker/verimi/endpoint?code=… → JIT user + Keycloak SSO cookie
  5. Keycloak → Portal       302 → /callback?code=… (Keycloak code)
  6. Lambda  → Keycloak      POST /token → tokens; map Keycloak sub → portal account
  7. Popup "Create a passkey" → user clicks
  8. SPA → Keycloak (2nd redirect): same /auth but
            kc_action=webauthn-register-passwordless:skip_if_exists
            NO kc_idp_hint (SSO cookie exists → Verimi is NOT contacted again)
  9. Keycloak + authenticator: WebAuthn ceremony; public key stored in Postgres
 10. Keycloak → Portal       …?kc_action_status=success → hide popup
 11. Later logins: omit kc_idp_hint → passkey works, Verimi not needed. ✅
```

### 10.3 Phase C — AFTER 2026-12-31: passkey only, Verimi removed

```
  ┌───────────────────────┐      ┌────────────────────────────┐      ┌───────────────────────────────┐
  │ Browser               │      │ Portal                     │      │ IONOS: nginx → Keycloak       │
  │ 9 portal domains      │─────►│ SPA + Lambda (BFF)         │─────►│ kc.gateway-vw.de:8443         │
  └───────────────────────┘◄─────└────────────────────────────┘◄─────│ IdP: verimi REMOVED           │
                                                                     │ WebAuthn passwordless only    │
                                                                     └───┬──────────────────┬────────┘
                                                                         │ verify sig       │ lookup
                                                                ┌────────▼────────┐ ┌───────▼─────────┐
                                                                │ Authenticator   │ │ Postgres        │
                                                                │ QR/USB/biometric│ │ public keys     │
                                                                └─────────────────┘ └─────────────────┘

  1. Browser → Portal       GET /login
  2. Portal  → Browser      302 → Keycloak /auth?client_id=portal-vw-baev&… (NO kc_idp_hint)
  3. Keycloak → Browser     passkey prompt → authenticator (QR/USB/biometric)
  4. Keycloak verifies signature vs Postgres public key → SSO cookie + authorization code
  5. Portal callback → Lambda POST /token → portal session. User is IN, Verimi not contacted.

  ⚠ Users who never enrolled cannot log in here — recovery codes / email reset / support
    process is mandatory (see §11 item 7).
```

---

## 11. Open tasks / improvements

1. Decide and freeze **RP ID** (recommend `gateway-vw.de`) before any enrolment; document in runbook.
2. Decide realm strategy: one realm for all 9 portals (SSO across portals) vs per-portal realm. Recommend one realm + 9 clients.
3. Set up Keycloak event → CloudWatch pipeline for audit.
4. Implement feature flag to toggle Verimi-direct vs Keycloak-brokered login per portal.
5. Plan Keycloak HA (clustering + managed Postgres) before millions of users.
6. Recovery UX: recovery codes + email reset; test lost-device flow.
7. Sunset plan: after 2026-12-31, remove Verimi IdP, force remaining users through recovery.
8. Load test passkey registration + login at expected peak.

---

## 12. Litmus check (per architecture principles)

- Separation of Concerns: portal owns account↔sub; Keycloak owns creds. ✅
- Dependency Inversion: portals depend on OIDC standard, not Keycloak internals. ✅
- Loose coupling: async redirect-based; no sync RPC in enrolment. ✅
- Security by design: no admin secrets in Lambda; no impersonation. ✅
- Idempotency: skip_if_exists. ✅
