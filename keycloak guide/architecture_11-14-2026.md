# Architecture: Verimi → Keycloak/Passkey Migration

**Project:** keycloak-passkey
**Date:** 2026-11-14
**Author:** Software Architecture review
**Scope:** User-driven passkey enrolment in Keycloak while Verimi is still active, and
passwordless (passkey) login after Verimi shuts down (2026-12-31).

---

## 0. TL;DR — Verdicts on your three questions

| # | Question | Verdict | One-line reason |
|---|----------|---------|-----------------|
| **a** | Is the described workflow possible & production-ready? | **Yes, possible — but redesign step 3** | Keycloak has a first-class, standards-based mechanism (Application Initiated Actions) for exactly this. Creating the user from Lambda via the Admin API is unnecessary. |
| **b** | Is impersonation recommended & secure? | **No — not recommended** | Impersonation mints a *full user session* from an admin privilege. It converts your Lambda into a super-powerful account-takeover primitive. It is a bootstrap hack, not a security boundary. |
| **c** | Secure alternatives? | **Yes — Identity Brokering + `kc_action=webauthn-register`** | One browser redirect. No admin credentials. No custom Java. Verimi keeps vouching for identity; Keycloak turns that into a real session and runs passkey registration. |

**Recommended architecture in one sentence:**
Make **Keycloak the front door** and let it **broker Verimi as an upstream IdP**. The
"Create passkey" button becomes a redirect to Keycloak with
`kc_idp_hint=verimi&kc_action=webauthn-register-passwordless:skip_if_exists`. The Lambda
never needs admin rights on Keycloak, and no user is ever impersonated.

---

## 1. Domain decomposition (DDD)

Even for a "small" migration, separating bounded contexts keeps the change contained.

| Bounded Context | Responsibility | Owner / System | Must NOT know about |
|-----------------|----------------|----------------|---------------------|
| **Identity & Authentication** | Verify *who* the user is. Issue sessions/tokens. Store credentials (passkeys). | Keycloak + Verimi (temporary) | Portal business data, roles of the domain |
| **Identity Linking / Account Mapping** | Map `portal_account_id` ↔ `keycloak_sub` (stable Keycloak user id) | Portal DB (AWS) | Credential material, raw passkey keys |
| **Authorization** | What the authenticated user may do (roles, entitlements) | Portal / Lambda + Keycloak roles | How the user authenticated |
| **Enrolment Campaign / Onboarding** | Drive users to create passkeys, track migration progress | Portal SPA + Lambda | Crypto internals |
| **Recovery** | Regain access when a passkey is lost | Keycloak (Recovery Codes + admin reset) | — |

**Key rule (Separation of Concerns):** the *portal* owns the account↔sub mapping; *Keycloak*
owns the credential. The two are joined only by an opaque `sub` claim. This is the same split
your own `Vorgehensweise.txt` already sketched (`UserId`, `KeycloakUserId (sub)`).

**Why this matters:** after Verimi dies, only the "Identity & Authentication" context changes
(Verimi is removed). Nothing in the portal domain logic changes — because the portal was only
ever consuming a `sub` + roles. That is the whole point of putting an IdP in front.

---

## 2. What actually happens under the hood (ground truth)

Before the design, the three facts that decide everything:

### 2.1 A passkey can only be created **in a browser, on Keycloak's origin**
WebAuthn binds a credential to a **Relying Party ID (RP ID)** = the *effective domain* of the
origin. Keycloak is the RP. Therefore:
- The passkey is scoped to Keycloak's domain (e.g. `auth.example.com`).
- **The Keycloak domain must be final before you enrol a single user.** Changing it later
  invalidates every passkey (they are origin-bound and cannot be migrated).
- The private key never leaves the user's device; Keycloak stores only the public key.

### 2.2 Keycloak has a first-class "please register a passkey now" API
**Application Initiated Actions (AIA)** — a Keycloak-proprietary OIDC extension. Your client
appends `kc_action=...` to the authorization URL:

| Action | Meaning |
|--------|---------|
| `kc_action=webauthn-register` | Register a WebAuthn credential for **2FA** |
| `kc_action=webauthn-register-passwordless` | Register a **passkey** (passwordless, discoverable) |
| `...:skip_if_exists` | No-op if the user already has such a credential; returns `kc_action_status=success` |

Redirect back carries `kc_action_status=success|cancelled`. This is exactly what the Keycloak
Account Console itself uses to manage credentials.

> ⚠️ AIA requires the user to **already have a Keycloak session** (or to authenticate during the
> redirect). It says so explicitly in the docs: *"This can be done even if the user is already
> authenticated on the client and has an active SSO session."*

### 2.3 The chicken-and-egg problem — and its one clean solution
- To register a passkey, the browser needs a **Keycloak SSO session**.
- The user currently has a **Verimi** session, not a Keycloak session.
- ⇒ You must give the browser a Keycloak session *without* making the user re-type credentials.

The clean way: **Identity Brokering.** Register Verimi as an Identity Provider *inside*
Keycloak. Then `kc_idp_hint=verimi` makes Keycloak delegate to Verimi, and because the user
already has a live Verimi SSO session, this is usually **silent** (no re-login). Keycloak then
creates/links the local user and runs the passkey action.

This is why **impersonation is the wrong tool**: it is a workaround for *not* brokering, and it
pays for that shortcut with an over-privileged service account.

---

## 3. Answers in detail

### a) Is the workflow possible and production-ready?

**Possible: yes. Production-ready as you described it: no — redesign step 3.**

Your step 3 ("Lambda creates a user on Keycloak") is the problem. It implies:
1. A Lambda holding **Keycloak Admin API credentials** (realm-admin or `manage-users`).
2. A hand-rolled user-provisioning path that duplicates what Keycloak's broker already does.
3. A need to *then* get that user into a browser session — which drags in impersonation (b).

| Aspect | Your step-3 design | Brokering + AIA design |
|--------|--------------------|------------------------|
| Custom user creation code | Yes (Admin API) | **No** (Keycloak auto-provisions on first broker login) |
| Admin credentials in Lambda | **Yes** (broad blast radius) | **No** |
| Identity linking | Manual, error-prone | **Automatic** (federated identity link) |
| Standards-based | Partly (proprietary impersonation) | **Yes** (OIDC + broker) |
| Extra Java | No | **No** |
| Post-shutdown cleanup | Delete custom code | Disable/remove Verimi IdP |

**Verdict:** the *goal* (user-initiated passkey enrolment while Verimi is alive) is not only
possible, it is a designed-for Keycloak use case. The *mechanism* in step 3 should change.

---

### b) Is impersonation recommended and secure?

**No.** It works technically, but it is an anti-pattern for a user-facing enrolment flow.

How Keycloak impersonation works: an admin with the `impersonation` role calls
`POST /admin/realms/{realm}/users/{id}/impersonation`, which returns a **one-time redirect
token** that logs the browser in **as that user** (full session). It exists for *support
scenarios* ("reproduce the user's bug"), not for onboarding.

**Your argument, examined:**
> *"At the point of passkey creation, the user is already in the portal — Verimi vouched for
> his identity."*

That argument is **about identity**, and it is fine for *identity*. But impersonation is an
**authorization** primitive. The risk is not "is this user who he says he is" — it is
"does my Lambda now hold a key that opens *every* user's account?" And the answer is yes.

| Risk | Why it is serious |
|------|-------------------|
| **Over-privileged service account** | The Lambda needs `impersonate` on users (effectively realm-admin). Compromise of the Lambda = **mass account takeover**, not one account. |
| **Passkey-registration hijack** | If an attacker can cause the impersonation endpoint to be called for a *victim's* user id, they register **their own** passkey on the victim's account and lock the victim out permanently. This is the classic "register attacker credential" attack. |
| **Not scoped to the task** | Impersonation yields a *full session*, not a "register one passkey" capability. Even if you redirect to the account console, the token is a full login. |
| **Token-in-URL leakage** | The impersonation redirect carries a bearer token in the URL → browser history, proxy logs, referrer headers. Short-lived, but a real leak surface. |
| **Blast radius violates least privilege** | "Least privilege: a service gets only the permissions it needs, nothing more." Impersonation grants far more than needed. |
| **Horizontal escalation** | Correctly mapping Verimi-subject → Keycloak-user must be tamper-proof *server-side*. If any part of that mapping is user-influenced, it becomes an account-takeover API. |

**The "one passkey" rule does not save you** — in fact it makes the hijack *worse*. With a
single-passkey policy, an attacker who registers one credential has locked the legitimate user
out of recovery too. (See §7 — I recommend *against* a one-passkey limit.)

**Verdict:** impersonation is a **bootstrap hack with a security boundary problem**. Use it only
for genuine, audited support workflows, never as the mechanism behind a user-facing button.

---

### c) Recommended and secure alternatives

Ranked. All avoid custom Java and avoid changing Verimi code.

#### ✅ Option 1 (Recommended): Identity Brokering + AIA
Register Verimi as an OIDC/SAML IdP in Keycloak. "Create passkey" = redirect to Keycloak with
`kc_idp_hint=verimi` + `kc_action=webauthn-register-passwordless:skip_if_exists`.

- No admin credentials, no impersonation, no custom user provisioning.
- Identity linking is automatic and standards-based.
- Works while Verimi is alive; when it dies, you just disable the IdP and passkey login remains.
- **Only prerequisite:** Verimi must let you register *one more* OIDC/SAML client (redirect URI =
  Keycloak). ⚠️ **Verify this immediately** — Verimi has stopped implementing, so this is your
  single biggest external dependency risk.

#### ✅ Option 1b: Same, but "broker on demand" (minimal disruption)
Don't change the portal's normal login yet. Only the *passkey button* uses the Keycloak
redirect with `kc_idp_hint=verimi`. The main Verimi login path stays untouched during the
transition. Best risk/effort trade-off if you're nervous about touching the login flow.

#### 🟡 Option 2: Post-Login Flow on the Verimi IdP
Configure a **Post Login Flow** on the Verimi IdP that triggers passkey registration after
broker login. Good for "enrol everyone automatically," but less user-driven (no opt-in popup).
Combine with Option 1 if you want *both* automatic nudging and a manual button.

#### 🟡 Option 3: Token Exchange (external → internal) + AIA
If you cannot broker in the browser but *can* configure Verimi as an IdP for token validation,
the Lambda exchanges the Verimi token for a Keycloak token (RFC 8693). More moving parts; still
needs Verimi IdP config; the browser-session problem remains, so AIA still needs a redirect.
**Use only if Option 1 is blocked.** Higher complexity, lower benefit.

#### 🟡 Option 4: Admin API + `execute-actions-email`
Lambda creates the user (Admin API) and calls `PUT /users/{id}/execute-actions-email` with the
`webauthn-register` action. The user clicks an emailed link → Keycloak session → passkey
registration. **No impersonation.** Downside: requires working email delivery and takes the
user out of the portal into their inbox. Good fallback if you cannot broker.

#### ❌ Option 5: Direct WebAuthn in Lambda
Already rejected in your own research (`Vorgehensweise.txt`, Option A). Confirmed: you would
re-implement credential storage, recovery, MFA, and attestation — high security responsibility,
high maintenance. Don't.

#### ❌ Option 6: Impersonation
Rejected — see (b).

---

## 4. Target architecture (C4)

### Level 1 — System Context

```
                              ┌──────────────────────────────┐
                              │          End User            │
                              │   (member, browser/phone)    │
                              └───────────────┬──────────────┘
                                              │ HTTPS
                                              ▼
             ┌────────────────────────────────────────────────────────────┐
             │                     Portal Platform (AWS)                  │
             │                                                            │
             │   ┌────────────────┐         ┌────────────────────────┐    │
             │   │  Portal SPA    │  REST   │  Backend API           │    │
             │   │  (React / JS)  │────────▶│  (AWS Lambda, Node.js) │    │
             │   └───────┬────────┘         └───────────┬────────────┘    │
             └───────────┼──────────────────────────────┼─────────────────┘
                         │                              │
             OIDC redirect (browser)          OIDC / token validation
             kc_idp_hint + kc_action          (server-to-server)
                         │                              │
                         ▼                              ▼
        ┌──────────────────────────────────────────────────────────────────┐
        │            Identity Platform  (IONOS VPS / Docker)               │
        │                                                                  │
        │      nginx (TLS, WAF, rate-limit) ─▶ Keycloak ─▶ Postgres        │
        └───────────────┬───────────────────────────────────┬──────────────┘
                        │ OIDC/SAML brokering                │ WebAuthn (RP)
                        ▼                                    ▼
             ┌────────────────────┐              ┌────────────────────────┐
             │   Verimi  (IdP)    │              │  Passkey authenticators │
             │  (retired 2026-12) │              │  (platform / USB / QR)  │
             └────────────────────┘              └────────────────────────┘
```

**Notes**
- The Portal SPA talks to Keycloak for login; the Lambda validates Keycloak-issued JWTs.
- Verimi is only reachable *through* Keycloak during the transition.
- Passkeys are handled entirely inside Keycloak (RP) and the user's device.

### Level 2 — Containers

```
┌──────────────────────────── Portal Platform (AWS) ────────────────────────────┐
│                                                                               │
│  [SPA] Portal SPA (React)                                                     │
│    • Renders "Create passkey" popup                                           │
│    • Builds Keycloak authorize URL (PKCE)                                     │
│    • Reads kc_action_status on return, updates UI                             │
│                                                                               │
│  [API] Backend API (AWS Lambda, Node.js)                                      │
│    • Validates Keycloak JWTs (JWKS)                                           │
│    • Stores portal_account_id ↔ keycloak_sub mapping (DynamoDB/RDS)           │
│    • NO Keycloak admin credentials in the enrolment path                      │
│                                                                               │
│  [SEC] AWS Secrets Manager  — client secrets, DB creds                        │
└───────────────────────────────────────────────────────────────────────────────┘
                     │ HTTPS                      │ HTTPS (JWKS / token)
                     ▼                            ▼
┌──────────────────────── Identity Platform (IONOS VPS / Docker) ──────────────┐
│                                                                               │
│  [PROXY] nginx                                                                │
│    • TLS termination, HSTS, security headers                                  │
│    • Rate limiting (per-IP + per-user), request size caps                     │
│    • Routes: auth.example.com → keycloak                                      │
│                                                                               │
│  [IAM] Keycloak                                                               │
│    • Realm: portal                                                            │
│    • IdP: verimi (OIDC/SAML)  ← broker                                        │
│    • Required actions: webauthn-register-passwordless, recovery-auth-codes    │
│    • Browser flow: passkey-first, Verimi fallback (transition)                │
│    • WebAuthn policy: RP ID = auth.example.com                                │
│                                                                               │
│  [DB] Postgres                                                                │
│    • Users, credentials (public keys only), sessions, events                  │
│                                                                               │
│  [OBS] Logs/metrics exporter → central observability                          │
└───────────────────────────────────────────────────────────────────────────────┘
```

### Level 3 — Keycloak Components (the parts that matter here)

```
┌───────────────────────────── Keycloak ───────────────────────────────────────┐
│                                                                              │
│  ┌────────────────────┐   ┌──────────────────────┐   ┌────────────────────┐  │
│  │ OIDC Endpoint      │   │ Authentication       │   │ Identity Provider  │  │
│  │ /auth              │──▶│ Engine (flows)       │──▶│ Broker             │  │
│  │ • kc_idp_hint      │   │ • Browser flow       │   │ • verimi adapter   │  │
│  │ • kc_action        │   │ • First Broker Login │   │ • claim mappers    │  │
│  └────────────────────┘   │ • Post Login Flow    │   └─────────┬──────────┘  │
│                            └──────────┬───────────┘             │            │
│                                       │                         │            │
│                            ┌──────────▼───────────┐   ┌─────────▼──────────┐  │
│                            │ Required Actions     │   │ Federated Identity │  │
│                            │ • webauthn-register- │   │ Link (subject ↔    │  │
│                            │   passwordless       │   │  keycloak user)    │  │
│                            │ • recovery-auth-codes│   └────────────────────┘  │
│                            └──────────┬───────────┘                          │
│                                       │                                      │
│                            ┌──────────▼───────────┐                          │
│                            │ WebAuthn (RP)        │                          │
│                            │ • RP ID: auth.ex...  │                          │
│                            │ • stores public keys │                          │
│                            └──────────────────────┘                          │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Recommended enrolment flow (sequence)

```
SPA (browser)          Keycloak                 Verimi              Authenticator
     │                    │                        │                      │
 1   │ user already logged into portal via Verimi  │                      │
     │ (existing, unchanged login)                 │                      │
     │                    │                        │                      │
 2   │ ── popup: "Secure your account with a passkey" ──                  │
     │                    │                        │                      │
 3   │ user clicks → build authorize URL:          │                      │
     │   /protocol/openid-connect/auth             │                      │
     │   ?client_id=portal                         │                      │
     │   &response_type=code                       │                      │
     │   &scope=openid                             │                      │
     │   &redirect_uri=https://portal/.../callback │                      │
     │   &code_challenge=... (PKCE)                │                      │
     │   &kc_idp_hint=verimi                       │                      │
     │   &kc_action=webauthn-register-passwordless:skip_if_exists         │
     │ ───────────────────▶│                        │                      │
     │                    │                        │                      │
 4   │                    │ no KC session → broker │                      │
     │                    │ ──────────────────────▶│                      │
     │                    │                        │ Verimi SSO still live│
     │                    │◀───── identity (silent, no re-login) ────────│
     │                    │                        │                      │
 5   │                    │ First Broker Login: create/link local user   │
     │                    │ (auto-provision — NO Lambda admin call)      │
     │                    │                        │                      │
 6   │                    │ run required action: webauthn-register-...   │
     │◀── passkey UI (QR / USB / platform) ────────│                      │
     │ ───────────────────────────────────────────────────────────────────▶│
     │                    │◀──────── public key (private key never leaves)─│
     │                    │                        │                      │
 7   │◀── redirect back: ?code=...&kc_action_status=success ──────────────│
     │                    │                        │                      │
 8   │ exchange code (PKCE) → ID token → read `sub`                      │
     │ store portal_account_id ↔ keycloak_sub                            │
     │                    │                        │                      │
 9   │ ── notification: "Passkey created ✓" ──                            │
```

**After Verimi shutdown (post-2026-12):** the same authorize call, but **without**
`kc_idp_hint`, and the browser flow authenticates with the **passkey** (discoverable credential
/ conditional UI). The Verimi IdP is simply disabled. Nothing in the portal domain changes.

> **Important:** never trust `kc_action_status=success` as proof. The docs warn the user can
> strip `kc_action` from the URL. If you must *know* a passkey exists, **verify it** — e.g. check
> the token's `acr`/credential claims, or query the user's credentials server-side. UI state is
> not a security control.

---

## 6. Robustness (no single point of failure, graceful degradation)

| Concern | Current (single IONOS VPS) | Recommended |
|---------|----------------------------|-------------|
| Keycloak node | 1 container = SPOF | ≥2 Keycloak replicas behind nginx; shared cache + shared DB |
| Postgres | Co-located = SPOF + data-loss risk | Managed/HA Postgres, streaming replica, PITR backups, tested restores |
| nginx | 1 instance | 2 instances + health checks, or an upstream LB |
| DNS/TLS | Single cert | Automated renewal, monitored expiry, multiple SANs planned |
| Verimi outage (transition) | Login blocked | Keycloak login page still offers passkey once enrolled → **degrade gracefully** |
| Keycloak outage | Portal down | Cache JWKS with sane TTL, short token lifetimes, health checks + alerting |
| Enrolment storm | Admin API rate limits | Brokering path has no admin-API bottleneck → naturally scales |

**Design principles applied:** bulkheads (separate DB from Keycloak), idempotency
(`skip_if_exists` makes the enrolment action safely repeatable), and graceful degradation
(once a user has a passkey, a Verimi outage no longer affects them).

> ⚠️ **Architectural inconsistency to resolve:** your research doc chose *"Option C — Keycloak on
> own AWS infrastructure"* (data residency in your AWS account), but the current deployment is a
> single **IONOS VPS**. Pick one and be explicit. If data residency in AWS was the deciding
> factor, hosting Keycloak on IONOS contradicts that decision.

---

## 7. Scalability (millions of users)

| Dimension | Approach |
|-----------|----------|
| Stateless Keycloak | Run N replicas; scale horizontally. Sessions in DB/cache, not local disk. |
| Database | The real bottleneck. Connection pooling (PgBouncer), read replicas for read-heavy flows, tune Keycloak's pool. |
| Enrolment campaign | The brokering flow is O(1) per user and needs no Lambda admin calls → no artificial rate limit. A Lambda Admin-API design would hit Keycloak admin rate limits. |
| Token validation in Lambda | Validate JWTs **offline via cached JWKS** — no call to Keycloak per request. |
| Caching | Cache JWKS, realm public keys, and user lookup by `sub`. |
| Static assets | Keycloak themes/logos via CDN. |
| Cost of "one passkey per user" | Millions of credential rows is trivial for Postgres — the scale risk is *sessions*, not credentials. |

**Scale verdict:** the brokering design scales linearly and cheaply; the impersonation/Admin-API
design introduces a **centralized, rate-limited admin dependency** that fights you at scale.

---

## 8. Security — threat model

| # | Threat | Vector | Mitigation |
|---|--------|--------|-----------|
| T1 | **Attacker registers their passkey on a victim's account** | Over-privileged impersonation endpoint, or user-controlled sub mapping | No impersonation. Broker-authenticated session only. Map `sub` server-side, never from client input. |
| T2 | **Mass account takeover via leaked Lambda creds** | Lambda holds realm-admin / `impersonate` | Lambda has **zero** Keycloak admin rights in the enrolment path. Least privilege. |
| T3 | **CSRF on the "Create passkey" action** | Cross-site form/redirect triggers enrolment | Enrolment is an OIDC redirect with `state` + PKCE; verify `state`. Never a bare state-changing GET. |
| T4 | **Token / auth-code interception** | Code in URL, weak redirect handling | PKCE (`S256`), strict `redirect_uri` allow-list (exact match), short-lived codes, `state`+`nonce`. |
| T5 | **Open redirect** | Loose redirect URI patterns | Exact-match redirect URIs; Keycloak "unspecific redirect URIs" protection. |
| T6 | **User enumeration** | Different responses for known/unknown users | Uniform responses; broker auto-provisioning avoids an enumeration endpoint entirely. |
| T7 | **Passkey domain migration breaks all credentials** | RP ID changes after enrolment | **Freeze the Keycloak domain before enrolling anyone.** Document it as immutable. |
| T8 | **Lost passkey → permanent lockout** | Single passkey, no recovery | Enable **Recovery Codes** required action + documented admin reset. Enrol **≥2** passkeys. |
| T9 | **Verimi token replay / weak validation** | Trusting unverified Verimi tokens | Validate issuer, audience, signature (JWKS), `exp`/`nbf`. Never trust client-provided identity. |
| T10 | **Brute force / abuse of auth endpoints** | Credential stuffing, enumeration | nginx rate limiting + Keycloak brute-force detection; alerting on spikes. |
| T11 | **Attestation not verified** | Unverified authenticators accepted | Set Attestation Conveyance + Acceptable AAGUIDs if your risk model requires it (adds user friction). |
| T12 | **Secrets in plaintext** | Client secrets in env/compose files | AWS Secrets Manager (Lambda), Docker secrets (VPS), rotation policy. |
| T13 | **Unencrypted transport / weak headers** | Missing HSTS, mixed content | TLS everywhere, HSTS, CSP, `X-Frame-Options`/frame-ancestors, Secure cookies. |
| T14 | **Blast radius of the VPS** | Single host holds proxy + IAM + DB | Network segmentation, host hardening, minimal exposed ports, monitored. |

### On the "one passkey only" requirement — I recommend against it
- A single credential is a **single point of failure** (lost/broken device = locked out).
- It *worsens* T1: an attacker who registers one credential fully owns the account.
- The correct model is **≥2 passkeys + recovery codes**, not 1.
- If you truly need "one *primary*," model it as a *policy/UX* preference (e.g. prompt for a
  second after the first), not a hard technical limit that harms recovery.

---

## 9. Open questions (please confirm before implementation)

1. **Verimi protocol:** OIDC or SAML? (Both are brokerable; the config differs.) Do you have
   `issuer`, `client_id`, `client_secret`, and can you register **one additional redirect URI**
   for Keycloak? ⚠️ *This is the critical path — Verimi has stopped implementing, so confirm it
   now.*
2. **Hosting decision:** IONOS VPS or AWS (your doc said AWS Option C)? This affects data
   residency, HA, and cost.
3. **User scale:** 100 or 100,000? (Changes HA and DB sizing.)
4. **Keycloak domain:** what is the *final* `auth.*` domain? It must never change after the first
   passkey is enrolled.
5. **Mapping source of truth:** which field maps a portal account to a Verimi identity today
   (email? Verimi `sub`?)? This defines the `portal_account_id ↔ keycloak_sub` link.
6. **Recovery policy:** who may reset a lost passkey, and through what audited process?
7. **Compliance:** any ISO 27001 / BSI / GDPR / sector requirements that constrain logging,
   retention, or data residency?

---

## 10. Suggested next steps

1. **Confirm Verimi can host a Keycloak broker client** (blocker). If not, fall back to Option 4
   (`execute-actions-email`) or Option 3 (token exchange).
2. **Freeze the Keycloak domain** and stand up TLS on it.
3. **Configure Verimi as an IdP** in Keycloak + First Broker Login flow.
4. **Enable required actions:** `webauthn-register-passwordless` + `recovery-auth-codes`.
5. **Prototype the redirect** in the SPA (one button) in a staging realm — no Lambda changes.
6. **Add the account↔sub mapping** to the portal (server-side, from the ID token `sub`).
7. **Build the enrolment campaign** (popup + progress tracking + nudge emails).
8. **Plan HA** (second Keycloak replica, managed/HA Postgres, backups + restore drill).
9. **Penetration test** the enrolment + login flow before the Verimi shutdown date.
10. **Cutover runbook:** disable Verimi IdP on shutdown day; verify passkey login; keep a
    rollback path documented.
