# Architecture: Login Phase Model & Corrected C4 Diagrams

**Project:** keycloak-passkey-3
**Date:** 2026-11-19
**Type:** Addendum / correction to `architecture_11-15-2026.md` (section 10 was misleading)
**Scope:** Clarify *when* Verimi is required, redraw the C4 diagrams for all three phases, and specify the exact portal change.

---

## 0. Direct answer to the correction

> Claim: "Logging in requires Verimi — otherwise you couldn't go into the portal."

**Verdict: partly right.** The claim is **true today** and **true for the first login of every user**, but it is **false after a passkey exists**.

| Situation | Needs Verimi to enter portal? | Why |
|---|---|---|
| Today, all logins | ✅ **Yes** | Portals redirect directly to Verimi. Keycloak is not in the path. |
| Transition, **first** login of a user | ✅ **Yes** | A passkey can only be created inside an authenticated session. Verimi provides that first proof of identity. |
| Transition, **later** logins (passkey exists) | ❌ No | Keycloak authenticates with the passkey; Verimi is not contacted. |
| After 2026-12-31 | ❌ No | Verimi is shut down; Keycloak + passkey only. |

**Core principle to memorise:**

```
You cannot create a passkey for someone who has not authenticated yet.
⇒ Verimi must authenticate the user ONCE to bootstrap the passkey.
⇒ The Verimi dependency is real, but TEMPORARY — it ends at enrolment.
```

The old diagram was wrong because it showed only the *target* design without saying that the portal login URL must change. Read it as "how it works today" and your objection is 100% valid.

---

## 1. Bounded contexts (DDD) — unchanged from 11-15

| Bounded Context | Responsibility | Owner |
|---|---|---|
| Identity & Authentication | Verify identity, issue sessions/tokens, store passkeys | Keycloak (Verimi temporary upstream) |
| Identity Linking | Map `portal_account_id` ↔ Keycloak `sub` | Portal DB (AWS) |
| Authorization | Roles/entitlements | Portal + Keycloak roles |
| Enrolment Campaign | Drive users to create passkeys, track progress | Portal SPA + Lambda |
| Recovery | Regain access on lost passkey | Keycloak (recovery codes + admin reset) |

Rule: portal owns account↔sub; Keycloak owns credentials. Joined only by opaque `sub`.

---

## 2. Phase model — the thing the old diagram was missing

```
PHASE A ─────────────► PHASE B ─────────────► PHASE C
 today                  transition            after 2026-12-31
 Verimi = front door    Keycloak = front door  Keycloak = front door
 no passkeys            Verimi brokered        no Verimi at all
                        passkeys bootstrapped  passkeys required
```

| | Phase A (today) | Phase B (transition) | Phase C (cutoff) |
|---|---|---|---|
| Portal redirects to | Verimi | **Keycloak** (with `kc_idp_hint=verimi` only for non-enrolled users) | Keycloak (no hint) |
| Keycloak in login path? | ❌ No | ✅ Yes | ✅ Yes |
| Verimi contacted? | Always | First login only (until passkey exists) | Never |
| Credential | Verimi login | Verimi login → passkey | Passkey (+ recovery) |
| Main risk | Verimi shutdown | Users who never enrol | Users who never enrolled / lost device |

---

## 3. C4-style ASCII diagrams — who calls whom, with endpoints

### 3.1 Phase A — TODAY (Verimi is the front door)

```
  ┌───────────────────────┐      ┌────────────────────────────┐      ┌─────────────────────┐
  │ Browser               │      │ Portal                     │      │ Verimi              │
  │ 9 portal domains      │─────►│ SPA + AWS Lambda           │─────►│ external IdP        │
  │ vw-baev.de, ltkv.de…  │◄─────│ portal session cookie      │◄─────│ auth + id_token     │
  └───────────────────────┘      └────────────────────────────┘      └─────────────────────┘
                                  ▲
                                  └── Keycloak / IONOS: NOT in this path

  Sequence (exact calls):
  1. Browser → Portal       GET https://vw-baev.de/login
  2. Portal  → Browser      302 Location: <verimi-authorize-url>?client_id=…
                                        &redirect_uri=https://vw-baev.de/callback&state=…
  3. Browser → Verimi       GET /authorize → login form → user authenticates (Verimi code unchanged)
  4. Verimi  → Browser      302 → https://vw-baev.de/callback?code=…&state=…
  5. Lambda  → Verimi       POST <verimi-token-url> (code + client secret) → id_token, access_token
  6. Portal creates portal session (httpOnly cookie) → user is IN.

  ⇒ Verimi down ⇒ steps 2–5 impossible ⇒ NO portal access. This is your correct observation.
```

### 3.2 Phase B — TRANSITION (Keycloak front door, Verimi broker, passkey bootstrap)

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
             └─── authenticator (QR / USB / biometric) ◄── WebAuthn runs at kc.gateway-vw.de:8443
                 (RP ID = gateway-vw.de; portal domains NEVER call navigator.credentials)

  Sequence (exact calls):
  1. Browser → Portal      GET /login
  2. Portal  → Browser     302 → https://kc.gateway-vw.de:8443/realms/vw/protocol/openid-connect/auth
                             ?client_id=portal-vw-baev
                             &redirect_uri=https://vw-baev.de/callback
                             &response_type=code&scope=openid+profile
                             &state=…&nonce=…&code_challenge=…&code_challenge_method=S256
                             &kc_idp_hint=verimi          ← only for NOT-yet-enrolled users
                             ⚠ THIS IS THE CHANGE: the URL used to point to Verimi
  3. Keycloak has no SSO cookie → 302 to Verimi /authorize; user authenticates (Verimi unchanged)
  4. Verimi  → Keycloak     GET /broker/verimi/endpoint?code=…
                             → validates code, JIT-provisions user, sets Keycloak SSO cookie
  5. Keycloak → Browser → Portal: 302 → https://vw-baev.de/callback?code=…&state=…
  6. Lambda  → Keycloak     POST /realms/vw/protocol/openid-connect/token
                             (code + PKCE verifier / client secret) → id_token, access_token
                             → map Keycloak sub → portal account, set portal session cookie
  7. Portal shows popup "Create a passkey" — user is already authenticated in the portal
  8. SPA → Keycloak (SECOND redirect, after the click):
                             same /auth endpoint, but
                             kc_action=webauthn-register-passwordless:skip_if_exists
                             NO kc_idp_hint (SSO cookie exists → Verimi is NOT contacted again)
  9. Keycloak runs the WebAuthn ceremony at its own origin; browser talks to authenticator
                             (QR / USB / biometric); public key stored in Postgres
 10. Keycloak → Portal      redirect with kc_action_status=success → popup hides
 11. Later logins: omit kc_idp_hint → passkey authenticates → Verimi not needed. ✅

  Rule for kc_idp_hint:
    - user has NO passkey yet → set kc_idp_hint=verimi (forces the bootstrap)
    - user HAS a passkey     → omit it (lets Keycloak offer the passkey)
```

### 3.3 Phase C — AFTER shutdown (passkey only)

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

  Sequence (exact calls):
  1. Browser → Portal      GET /login
  2. Portal  → Browser     302 → Keycloak /auth?client_id=portal-vw-baev&… (NO kc_idp_hint)
  3. Keycloak → Browser    WebAuthn prompt → authenticator (QR/USB/biometric)
  4. Keycloak verifies signature against stored public key → SSO cookie + authorization code
  5. Portal callback → Lambda POST /token → portal session → user is IN. Verimi not contacted.

  ⚠ Users with no enrolled passkey need recovery (codes / email reset / support).
```

---

## 4. The concrete portal change (JavaScript only — no Java, no Verimi changes)

This is the *only* application change required by the target design. It is a **redirect target change**, not an authentication rewrite.

### BEFORE — Phase A (current)

```js
// portal/app.js — TODAY: the portal is a direct client of Verimi
function login() {
  const url = new URL(VERIMI_AUTHORIZE_URL);          // keep your existing value
  url.searchParams.set('client_id', VERIMI_CLIENT_ID);
  url.searchParams.set('redirect_uri', `https://${PORTAL_DOMAIN}/callback`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', randomState());
  location.assign(url.toString());
}
```

### AFTER — Phase B (target)

```js
// portal/app.js — Keycloak is the front door; Verimi becomes an upstream IdP
const KC = 'https://kc.gateway-vw.de:8443/realms/vw/protocol/openid-connect';

function login({ enrolledPasskey = false } = {}) {
  const url = new URL(`${KC}/auth`);
  url.searchParams.set('client_id', `portal-${PORTAL_ID}`);   // portal-vw-baev, portal-ltkv, …
  url.searchParams.set('redirect_uri', `https://${PORTAL_DOMAIN}/callback`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid profile');
  url.searchParams.set('state', randomState());
  url.searchParams.set('nonce', randomNonce());
  url.searchParams.set('code_challenge', pkceChallenge());
  url.searchParams.set('code_challenge_method', 'S256');

  // Verimi only bootstraps users who do not yet have a passkey
  if (!enrolledPasskey && PHASE === 'B') {
    url.searchParams.set('kc_idp_hint', 'verimi');
  }
  location.assign(url.toString());
}

// Called from the popup button — SECOND redirect, only after login succeeded
function enrollPasskey() {
  const url = new URL(`${KC}/auth`);
  url.searchParams.set('client_id', `portal-${PORTAL_ID}`);
  url.searchParams.set('redirect_uri', `https://${PORTAL_DOMAIN}/callback`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid profile');
  url.searchParams.set('kc_action', 'webauthn-register-passwordless:skip_if_exists');
  // intentionally NO kc_idp_hint: the Keycloak SSO session already exists
  location.assign(url.toString());
}
```

Callback (server-side, Lambda/BFF) — unchanged in shape, only the token endpoint changes from Verimi to Keycloak:

```js
// lambda/handler.js (sketch)
const r = await fetch(`${KC}/token`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: `https://${PORTAL_DOMAIN}/callback`,
    client_id: `portal-${PORTAL_ID}`,
    code_verifier,                 // PKCE
  }),
});
const { id_token, access_token } = await r.json();
// map id_token.sub (Keycloak sub) → portal account; set httpOnly session cookie
```

> Note: `kc_action=webauthn-register-passwordless:skip_if_exists` follows Keycloak's documented AIA pattern (`kc_action=<alias>:skip_if_exists`). Verify the alias against your exact Keycloak version; passkey-native defaults changed around Keycloak 26.4.

---

## 5. Robustness (updates to §5 of 11-15)

- **Phase A → B cutover is reversible per portal**: a feature flag switches the redirect target. If Keycloak fails, flip that portal back to Verimi (still alive during Phase B). This is graceful degradation, not a SPOF.
- **No partial enrolment state**: WebAuthn registration is atomic in Keycloak (public key stored or not). `skip_if_exists` makes repeated popup clicks no-ops.
- **Decoupling via standard OIDC**: portals depend on the authorize/token endpoints, not Keycloak internals. Verimi broker config can be changed without portal code changes.
- **New risk made explicit**: the "last un-enrolled users" before cutoff. Track `% enrolled` per portal and escalate; this is an operational risk, not a technical failure.

## 6. Scalability (updates to §6 of 11-15)

- Phase B adds **one extra redirect hop** per first login (browser → Keycloak → Verimi). Stateless redirect, so no server-side session explosion; nginx + Keycloak scale horizontally behind a load balancer.
- Passkey verification is client-side cryptography; server stores only public keys → negligible storage growth even at millions of users.
- Lambda stays stateless; all session state lives in Keycloak (SSO cookie) and the portal's own session store.
- IONOS single VPS remains a SPOF in all phases; keep the managed-Postgres + clustered-Keycloak migration path from §11 of 11-15.

## 7. Security (updates to §7 of 11-15)

- **Phase B**: `kc_idp_hint=verimi` must only be set for users who still need bootstrapping. Setting it for enrolled users would force them through Verimi and defeat passkey-first login.
- **Phase B**: PKCE + `state` + `nonce` on both redirects; exact redirect-URI whitelist per client; no wildcards across the 9 domains.
- **Phase C**: remove the Verimi IdP client, its secret, and the mapper config entirely — dead IdP config is attack surface.
- **RP ID is fixed** (`gateway-vw.de`) before first enrolment; portals never handle WebAuthn, so no origin/RP-ID mismatch.
- **No admin secret in Lambda**, no impersonation — unchanged from 11-15.
- **Enrolment audit**: Keycloak `CREDENTIAL_REGISTER` events + portal "enrolled" flag; alert on bursts or stalls.

---

## 8. Open tasks / improvements

1. **Enrolment coverage dashboard** — per portal: total active users, enrolled, not enrolled. Escalate before 2026-12-31. *(highest priority new task)*
2. Decide the source of truth for `enrolledPasskey` used by `login()`: portal DB flag vs Keycloak `userinfo`. Portal DB flag is simpler and avoids an extra call.
3. Freeze RP ID (`gateway-vw.de`) in a runbook before first enrolment.
4. One realm `vw` + 9 clients (SSO across portals) vs 9 realms — keep one realm.
5. Keycloak event → CloudWatch pipeline; alert on anomalous registration bursts.
6. HA: clustered Keycloak + managed Postgres before scaling beyond the IONOS VPS.
7. Recovery UX for the un-enrolled/lost-device: recovery codes + email reset + documented support path, tested before cutoff.
8. Evaluate Keycloak 26.4+ native passkey features (mediation `conditional`, passkey defaults) against the current WebAuthn required action.
9. Load test both redirects (Phase B login + AIA enrolment) at expected peak.
10. Sunset checklist: remove Verimi IdP config, broker mappers, Verimi client secret, and the `kc_idp_hint` branch from portal JS.

---

## 9. Litmus check (per architecture principles)

| Principle | Status | Note |
|---|---|---|
| Separation of Concerns | ✅ | Portal owns account↔sub + campaign; Keycloak owns credentials. |
| Dependency Inversion | ✅ | Portals depend on OIDC endpoints, not Keycloak internals. |
| Loose Coupling | ✅ | Redirect-based; feature flag decouples the cutover per portal. |
| Idempotency | ✅ | `skip_if_exists` + Keycloak as source of truth. |
| Graceful Degradation | ✅ | Phase B can fall back to Verimi-direct per portal. |
| Security by Design | ✅ | No admin secrets, no impersonation, PKCE, fixed RP ID. |
| Observability | ⚠️ | Enrolment coverage dashboard still to build (task 1). |
| Consistency Model Clarity | ✅ | Credential state strongly consistent in Keycloak; campaign flag eventually consistent in portal DB. |
