# Implementation Guide: Verimi → Keycloak Passkey Enrolment

**Project:** keycloak-passkey
**Date:** 2026-11-14
**Companion to:** `architecture_11-14-2026.md`
**Environment (given):**
- Portal: `https://vw-baev.de`
- Keycloak public: `https://kc.gateway-vw.de:8443`
- Keycloak admin: `https://kc-admin.gateway-vw.de:8444`
- Hosting: IONOS VPS, Docker (nginx + Keycloak + Postgres)
- Users: ~190,000 · Logins: 500–1,000/day
- Verimi login: username + password
- **Passkey RP ID (derived): `kc.gateway-vw.de`** ← immutable after first enrolment

Placeholders used below: realm `portal`, client `portal`.

> ⚠️ **The portal (`vw-baev.de`) and Keycloak (`kc.gateway-vw.de`) are on different
> registrable domains.** This works technically but has real consequences — see **Q18b**.

---

## Q1 — The redesigned step 3

**Old step 3:** Lambda creates the Keycloak user via Admin API.
**New step 3:** the browser is redirected to Keycloak; Keycloak provisions and enrols.

```
 1. User is logged into the portal via Verimi (unchanged)
 2. Portal shows popup: "Secure your account with a passkey"
 3. User clicks  →  SPA builds Keycloak authorize URL and does a TOP-LEVEL redirect
        ?kc_idp_hint=verimi
        &kc_action=webauthn-register-passwordless:skip_if_exists
 4. Keycloak has no session → brokers to Verimi (kc_idp_hint)
 5. Verimi SSO still active → returns identity (usually silent, no re-login)
 6. Keycloak "First Broker Login" flow → CREATES + LINKS the local user automatically
 7. Keycloak runs required action webauthn-register-passwordless → passkey UI (QR/USB/platform)
 8. User registers passkey (private key never leaves device)
 9. Keycloak redirects back to portal: ?code=...&kc_action_status=success
10. SPA/Lambda exchanges code (PKCE) → ID token → read `sub`
11. Portal stores portal_account_id ↔ keycloak_sub
12. Portal shows "Passkey created ✓"
```

**The whole point:** steps 6 is done by Keycloak's broker. No Admin API, no user pre-creation,
no impersonation. Step 3 is a **browser redirect**, not a Lambda write.

---

## Q2 — Register Verimi as an Identity Provider in Keycloak

### OIDC variant (if Verimi is OIDC)
1. Log in to `https://kc-admin.gateway-vw.de:8444`, select the realm (e.g. `portal`).
2. **Identity providers → Add provider → OpenID Connect v1.0**.
3. **Alias = `verimi`** ← this exact string is what `kc_idp_hint=verimi` refers to.
4. **Discovery endpoint**: paste Verimi's `https://<verimi>/.well-known/openid-configuration`
   and click **Import** (or fill Authorization URL / Token URL / User Info URL manually).
5. **Client ID** / **Client Secret**: from Verimi.
6. **Validate Signatures = ON**, **Use JWKS URL = ON**, JWKS URL = Verimi's JWKS endpoint.
7. **First login flow** = `first broker login` (default). Optionally set a **Post login flow** (Q6).
8. Save. Keycloak now displays the **Redirect URI** to give to Verimi:
   `https://kc.gateway-vw.de:8443/realms/portal/broker/verimi/endpoint`

### SAML variant (if Verimi is SAML)
1. **Identity providers → Add provider → SAML v2.0**.
2. **Alias = `verimi`**.
3. **Import from URL** = Verimi IdP metadata URL (or **Import from file** with the XML).
4. **Service provider entity ID** = `https://kc.gateway-vw.de:8443/realms/portal`.
5. Give Verimi the SP metadata:
   `https://kc.gateway-vw.de:8443/realms/portal/broker/verimi/endpoint/descriptor`
   (and the ACS URL is the same `/broker/verimi/endpoint`).
6. Save.

> The broker endpoint pattern is always
> `{kc}/realms/{realm}/broker/{alias}/endpoint`.

---

## Q3 — Implementing the redirect: Lambda + Keycloak config

### Critical rule
The passkey/OIDC flow requires a **top-level browser navigation** (`window.location.assign`),
never `fetch`/XHR. Keycloak must be able to set cookies and drive the WebAuthn prompt.

### Option A — SPA builds the URL (simplest, recommended)
See Q12 for the PKCE code. Then `window.location.assign(url)`.

### Option B — Lambda returns the URL (keeps config server-side)
Lambda generates PKCE and must persist the `code_verifier` (DynamoDB/Redis) keyed by `state`,
because it is needed at the token exchange.

```js
// AWS Lambda (Node.js 20) — GET /auth/passkey-enroll-url
const crypto = require('crypto');
const b64url = (b) => Buffer.from(b).toString('base64url');

exports.handler = async () => {
  const KC_BASE      = process.env.KC_BASE;        // https://kc.gateway-vw.de:8443
  const REALM        = process.env.KC_REALM;       // portal
  const CLIENT_ID    = process.env.KC_CLIENT_ID;   // portal
  const REDIRECT_URI = process.env.KC_REDIRECT_URI;// https://vw-baev.de/auth/callback

  const verifier  = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state     = b64url(crypto.randomBytes(16));
  const nonce     = b64url(crypto.randomBytes(16));

  // PERSIST { verifier, nonce } under state with a 5-minute TTL (DynamoDB/Redis).
  await storeState(state, { verifier, nonce });   // <-- your implementation

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'openid',
    state, nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    kc_idp_hint: 'verimi',
    kc_action: 'webauthn-register-passwordless:skip_if_exists',
  });

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify({
      authorizeUrl: `${KC_BASE}/realms/${REALM}/protocol/openid-connect/auth?${params}`,
      state,
    }),
  };
};
```

### Keycloak configuration that must change

| # | Where | Setting | Value |
|---|-------|---------|-------|
| 1 | Clients → `portal` | Standard flow | ON |
| 2 | Clients → `portal` | Valid redirect URIs | `https://vw-baev.de/auth/callback` (exact) |
| 3 | Clients → `portal` | Web origins | `https://vw-baev.de` (CORS for token endpoint) |
| 4 | Clients → `portal` | PKCE code challenge method | `S256` |
| 5 | Clients → `portal` | Client authentication | OFF for SPA (public+PKCE); ON if Lambda does the exchange |
| 6 | Authentication → Required Actions | `Webauthn Register Passwordless` | **Enabled = ON** |
| 7 | Authentication → Required Actions | `Recovery Authentication Codes` | Enabled = ON (see Q20) |
| 8 | Authentication → Policies | WebAuthn Passwordless Policy | RP ID = `kc.gateway-vw.de`, User Verification = Required, Discoverable Credential = Required |
| 9 | Identity providers | `verimi` | Added (Q2) |
| 10 | Authentication → Flows | Browser | WebAuthn Passwordless Authenticator enabled (post-cutover) |

> The exact required-action provider id for the passkey action is
> `webauthn-register-passwordless` (confirmed in Keycloak docs). For recovery codes, verify the
> provider id under **Realm info → Provider info → `required-action`** (it is typically
> `CONFIGURE_RECOVERY_AUTHN_CODES`).

---

## Q4 — Verifying that Verimi will grant you another client (step by step)

This is your **critical-path external dependency**. Do it first.

1. **Find your current integration.** In the portal code/config, search for
   `verimi`, `.well-known`, `client_id`, `client_secret`, `SAMLRequest`, `saml`, `oauth`, `openid`.
   You will find either an OIDC client config or a SAML metadata file → tells you the protocol.
2. **Identify your Verimi contact.** Verimi GmbH operates a partner/customer portal (and you
   likely have an account manager or a support ticket channel). Find the person/team who
   onboarded the original integration.
3. **Probe the protocol yourself** (see Q15).
4. **Ask Verimi explicitly** — with these exact asks:
   - "Can you register **one additional OIDC client** (or SAML SP) for our Keycloak instance?"
   - Redirect URI: `https://kc.gateway-vw.de:8443/realms/portal/broker/verimi/endpoint`
   - "Given the announced shutdown, **is client registration still possible, and until when?**"
   - Request: `client_id`, `client_secret`, `issuer`, endpoints (or SAML metadata XML).
5. **Test in a staging realm** (`portal-staging`) before touching production.
6. **If Verimi refuses** → fall back to **Option 4** (`execute-actions-email`, Q10/Q11) or
   **Option 3** (token exchange, Q8/Q9). Get the "no" in writing early so you have time.

**Timeline risk:** if registration takes weeks and Verimi shuts down 2026-12-31, you have a hard
deadline. Escalate now.

---

## Q4b — How to register the additional client in Verimi (and why it is needed)

### Why this is needed
When the user clicks "Create passkey", the browser chain is:

```
Portal SPA ──▶ Keycloak /auth (kc_idp_hint=verimi, kc_action=...)
                │
                │ Keycloak has no session → delegates to Verimi
                ▼
            Verimi (Keycloak is now a normal OIDC client / RP)
                │
                │ user already has Verimi SSO → silent login
                │ Verimi issues auth code and redirects BACK to:
                ▼
            https://kc.gateway-vw.de:8443/realms/portal/broker/verimi/endpoint   ← callback
                │
                │ Keycloak exchanges code for tokens, creates/links user
                ▼
            passkey registration UI (WebAuthn) ──▶ back to portal
```

Verimi (like every OIDC IdP) enforces an **exact-match redirect-URI allow-list** to prevent
open-redirect / authorization-code theft. If Keycloak's broker callback URL is **not** registered
in Verimi as an allowed redirect URI, Verimi rejects the redirect and the whole flow fails.
Therefore you must register Keycloak as **one more application/client** in Verimi.

### How to register (generic OIDC — adapt to Verimi's console)
1. **Log in to Verimi's partner/customer console** (same place you registered the 9 portals).
2. **Create a new OIDC client/application** (e.g. name `keycloak-broker`).
3. **Set the redirect URI (callback URL)** to exactly:
   ```
   https://kc.gateway-vw.de:8443/realms/portal/broker/verimi/endpoint
   ```
   Exact match — no trailing slash, no wildcards, no query params. Replace `portal` with your
   actual Keycloak realm name.
4. **Grant Authorization Code flow** (response type `code`); scopes: `openid`, `email`, `profile`
   (plus whatever subject claim you map).
5. **Save** → you receive `client_id` + `client_secret`.
6. **In Keycloak Admin Console** → Identity Providers → Add provider → **OpenID Connect v1.0**:
   - Alias: `verimi`
   - Authorization / Token / JWKS URLs + Issuer (from Verimi's
     `https://<verimi-host>/.well-known/openid-configuration`)
   - Client ID / Client Secret (from step 5)
   - Default Scopes: `openid email profile`
7. **First Broker Login flow** → keep default (auto-create + link by email/sub). No Java code.
8. **Claim mapper** (optional): map Verimi's `sub`/`email` to Keycloak user attributes.

### SAML variant (if Verimi only offers SAML)
- Keycloak → Identity Providers → **SAML v2.0**.
- Set the **ACS (Assertion Consumer Service) URL** in Verimi's SP registration to
  `https://kc.gateway-vw.de:8443/realms/portal/broker/verimi/endpoint`.
- Exchange entity ID + signing cert (Keycloak SP metadata ↔ Verimi IdP metadata).

### What you need from Verimi (checklist)
- [ ] Ability to register a new client (registration may still work even though they stopped
      *implementing* features — confirm)
- [ ] Verimi's OIDC discovery document URL or SAML metadata
- [ ] `client_id` + `client_secret` (or SAML cert exchange)
- [ ] Confirmation that **silent SSO** works (already-logged-in user → no re-prompt)

### If Verimi refuses
Fall back to **Option 4** (Q10/Q11): Lambda creates the user via Keycloak Admin API (pure
HTTP/JS) + `execute-actions-email` with `webauthn-register`. No Verimi contact needed, but
requires working email delivery. Get the "no" in writing early.

---

## Q5 — How the button uses the Keycloak redirect

The button performs a **full-page navigation**:

```html
<button id="create-passkey">Create passkey</button>
<script>
  document.getElementById('create-passkey').addEventListener('click', async () => {
    const res = await fetch('/api/auth/passkey-enroll-url', { credentials: 'include' });
    const { authorizeUrl } = await res.json();
    window.location.assign(authorizeUrl);   // top-level navigation — NOT fetch()
  });
</script>
```

**Endpoint (GET):**
`https://kc.gateway-vw.de:8443/realms/portal/protocol/openid-connect/auth`

**Parameters:**

| Parameter | Value | Purpose |
|-----------|-------|---------|
| `client_id` | `portal` | Your Keycloak client |
| `redirect_uri` | `https://vw-baev.de/auth/callback` | Where Keycloak returns |
| `response_type` | `code` | Authorization Code Flow |
| `scope` | `openid` | Request an ID token |
| `state` | random | CSRF protection |
| `nonce` | random | Replay protection |
| `code_challenge` | `S256(verifier)` | PKCE |
| `code_challenge_method` | `S256` | PKCE |
| `kc_idp_hint` | `verimi` | Force the Verimi IdP (**= IdP alias**) |
| `kc_action` | `webauthn-register-passwordless:skip_if_exists` | Run passkey registration; no-op if already enrolled |

On return, Keycloak appends `kc_action_status=success|cancelled`.
⚠️ **Do not trust `kc_action_status` as proof of enrolment** — the user can strip the parameter.
Verify server-side (query the user's credentials, or check the token's `acr`/claims).

---

## Q6 — Option 2: "enrol everyone automatically"

### Approach A — Default Action (simplest, reliable)
1. **Authentication → Required Actions**.
2. Find `Webauthn Register Passwordless` → toggle **Default Action = ON**.
3. Every **new** user (including users auto-provisioned on first broker login) must register a
   passkey at first login.
4. Do the same for `Recovery Authentication Codes` if you want recovery codes generated up front.

### Approach B — Post Login Flow (per-IdP, more control)
1. **Authentication → Flows → Create flow** e.g. `verimi-post-login`.
2. Add the passkey-register execution and set it **Required** (optionally wrap it in a
   **Conditional** sub-flow so it only runs when the user has no passwordless credential).
3. **Identity providers → verimi → Post login flow** = `verimi-post-login`.

### Approach C — Hybrid (what I recommend for your goal)
Keep the **button** (Option 1, user-driven) *and* set the **Default Action** (Option A) so users
who ignore the popup still get enrolled at their next login. Best of both.

> "Enrol everyone automatically" conflicts slightly with your "popup + opt-in" UX. Decide:
> opt-in only (slower migration) vs. forced-at-next-login (faster, more friction).

---

## Q6b — What "enrol everyone automatically" actually means (and what it cannot mean)

**"Enrol everyone automatically" is a misnomer.** No one can create a passkey *for* a user —
not Keycloak, not Lambda, not an admin. A passkey is a keypair whose **private key is generated
on, and never leaves, the user's own authenticator**. The server only stores the **public key**.

"Automatic" can therefore only mean: **the *prompt* is automatic — the *ceremony* is always manual
and device-bound.**

| Layer | Automatic? | Who does it |
|-------|-----------|-------------|
| **Trigger** — "you must create a passkey now" | ✅ Yes | Keycloak (Default Action / Post-Login Flow) |
| **Ceremony** — `navigator.credentials.create()` | ❌ Always manual | The **user**, on their **device**, with biometric/PIN/tap |
| **Key generation** | ❌ | The **authenticator hardware/OS** |
| **Public-key storage** | ✅ Yes | Keycloak |

You can force the *screen* to appear; you cannot force the *key* to exist. If the user closes the
dialog, nothing is created.

### The user needs an authenticator (a device)

| Type | Examples | Requirement |
|------|----------|-------------|
| **Platform authenticator** | iPhone Face/Touch ID, Android biometric, Windows Hello, Mac Touch ID | Modern phone/laptop |
| **Roaming / security key** | YubiKey, Feitian (USB/NFC) | Separate hardware key |
| **Cross-device (hybrid)** | Desktop QR code scanned by phone | A phone |

Also: **synced passkeys** (iCloud Keychain / Google Password Manager / Windows Hello) survive
device loss; **device-bound passkeys** do not. In all cases: WebAuthn-capable browser + HTTPS +
user gesture. **No device → no passkey.**

### The consequence to plan for

At ~190,000 users a non-trivial minority cannot create a passkey: no smartphone, old phone
(pre-iOS 16 / pre-Android 9), locked-down corporate device, shared/kiosk device, or lack of
understanding.

> ⚠️ **Lockout risk:** if passkey registration is a **required** step in the login flow, a user
> without a capable device **cannot log in at all** — the opposite of the goal.

### Corrected framing

| Phrase | Reality |
|--------|---------|
| "Enrol everyone automatically" | ❌ Impossible — misnomer |
| "Prompt every user to enrol at next login" | ✅ Accurate — the *trigger* is automatic |
| "Force enrolment (block login until done)" | ⚠️ Accurate but **lockout risk** for device-less users |

### Corrected recommendation
1. **Option 1 (opt-in button) is the safer primary path** — device-less users can defer and keep
   using Verimi until shutdown.
2. Use the automatic nudge (Default Action) as a **repeated prompt, not a hard gate**.
3. **Keep a fallback auth method** (or a documented assisted-onboarding process) for users who
   cannot create a passkey.
4. **Measure early** (pilot): count failures and decide whether a fallback factor or a
   support-desk enrolment path is needed.

The enrolment *campaign* can be automated; the *enrolment itself* cannot. The user's device is
always in the loop.

---

## Q7 — What "broker in the browser" means

"Broker in the browser" = the **OIDC redirect chain that runs in the user's browser**:

```
Browser ──1──▶ Keycloak /auth
Browser ◀─2─── Keycloak 302 → Verimi /authorize
Browser ──3──▶ Verimi (login, or silent if Verimi session exists)
Browser ◀─4─── Verimi 302 → Keycloak /broker/verimi/endpoint?code=...
              Keycloak exchanges the code with Verimi, gets identity,
              creates/links the local user, establishes the Keycloak session
Browser ◀─5─── Keycloak 302 → app redirect_uri?code=...
Browser ──6──▶ App exchanges code for tokens
```

**What you need for this to work:**
1. Verimi accepts Keycloak as a client (redirect URI = `/realms/portal/broker/verimi/endpoint`).
2. The IdP is configured in Keycloak (Q2).
That's it — no Lambda involved in the redirect itself.

**"If you cannot broker in the browser"** = Verimi refuses step 1 (won't register the redirect
URI). Then steps 2–4 cannot happen, so the browser never obtains a Keycloak session → the AIA
passkey action can't run. That is precisely when you need Option 4 or Option 3.

---

## Q8 — Configure Verimi as an IdP for token validation (Option 3 prerequisite)

For **token exchange (external → internal)**, Keycloak must validate Verimi-issued tokens:

1. **Identity providers → Add provider → OpenID Connect v1.0**.
2. **Alias** = `verimi`.
3. **Issuer** = Verimi's issuer URL.
4. **Validate Signatures = ON**.
5. **Use JWKS URL = ON**; **JWKS URL** = Verimi's JWKS endpoint
   (for a Keycloak IdP: `{base}/realms/{realm}/protocol/openid-connect/certs`; use Verimi's equivalent).
   - Or **Use JWKS URL = OFF** + **Validating Public Key** (PEM) + **Validating Public Key Id**.
6. Enable the feature on the Keycloak server: `--features=token-exchange` (Docker env
   `KC_FEATURES=token-exchange`).
7. Client ID/Secret fields are still present in the form; for pure validation the issuer + JWKS
   are what matter. Verify against your Keycloak version in staging.

> This is the **advanced** path. It needs Verimi to be configured in Keycloak anyway, so if you
> can do that, you can usually just broker (Option 1) and skip token exchange entirely.

---

## Q9 — Option 3: Lambda token exchange (RFC 8693)

```js
// AWS Lambda — exchange a Verimi token for a Keycloak token
const body = new URLSearchParams({
  grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
  client_id: process.env.KC_LAMBDA_CLIENT_ID,
  client_secret: process.env.KC_LAMBDA_CLIENT_SECRET,
  subject_token: verimiAccessToken,                 // token issued by Verimi
  subject_issuer: 'verimi',                         // = Keycloak IdP alias
  subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
  requested_token_type: 'urn:ietf:params:oauth:token-type:refresh_token',
  audience: 'portal',
});

const res = await fetch(
  'https://kc.gateway-vw.de:8443/realms/portal/protocol/openid-connect/token',
  { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }
);
const kcTokens = await res.json(); // access_token, refresh_token, ...
```

### ⚠️ The decisive limitation
Token exchange returns **tokens, not a browser SSO session**. Passkey registration (AIA) needs a
**browser session** at Keycloak's origin. So token exchange **does not** let you run the passkey
enrolment in the browser — you would still need the browser to visit Keycloak (i.e. brokering).

**Therefore Option 3 is only useful for:** server-side API access as the user, or account
linking — **not** for the browser passkey-enrolment step. Prefer Option 1.

---

## Q10 — Option 4: "Lambda creates the user" — contradiction?

Fair challenge. Let me be precise about what I actually recommend against:

| Practice | Verdict | Why |
|----------|---------|-----|
| **Impersonation** | ❌ Never for this | Mints a full session from an admin privilege; mass-takeover blast radius |
| **Lambda as realm-admin in the happy path** | ❌ Avoid | Over-privileged; attack surface |
| **Admin-API user creation as a fallback** | 🟡 Acceptable if brokering is impossible | Smaller blast radius than impersonation (no session minting), but still privileged |

So Option 4 **does** still need an over-privileged Lambda — it is **not** my first choice. It is a
**fallback** for the case where Verimi will not let you broker. Its advantage over impersonation:
`execute-actions-email` sends a one-time action link and does **not** grant session takeover.
That is "less bad," not "good." Option 1 remains the recommendation.

---

## Q11 — Where to set/call the `webauthn-register` action

| # | Mechanism | How |
|---|-----------|-----|
| 1 | **Enable** (one-time) | Authentication → Required Actions → toggle `Webauthn Register Passwordless` Enabled = ON |
| 2 | **AIA** (recommended) | `kc_action=webauthn-register-passwordless` in the authorize URL |
| 3 | **Per user (Admin API)** | `PUT /admin/realms/portal/users/{id}` body `{"requiredActions":["webauthn-register-passwordless"]}` |
| 4 | **Email link** | `PUT /admin/realms/portal/users/{id}/execute-actions-email` body `["webauthn-register-passwordless"]` |
| 5 | **Default Action** | Required Actions → `Default Action = ON` → applies to all new users |

> AIA can run **one action per redirect**. To also generate recovery codes, either set both as
> Default Actions, or do two sequential redirects (`webauthn-register-passwordless`, then the
> recovery-codes action).

---

## Q12 — Building the Keycloak authorize URL with PKCE (JS)

```js
const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const rand = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));

async function buildAuthorizeUrl() {
  const verifier  = rand(32);
  const challenge = b64url(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  );
  const state = rand(16);
  const nonce = rand(16);

  sessionStorage.setItem('pkce_verifier', verifier);
  sessionStorage.setItem('pkce_state', state);
  sessionStorage.setItem('pkce_nonce', nonce);

  const params = new URLSearchParams({
    client_id: 'portal',
    redirect_uri: 'https://vw-baev.de/auth/callback',
    response_type: 'code',
    scope: 'openid',
    state, nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    kc_idp_hint: 'verimi',
    kc_action: 'webauthn-register-passwordless:skip_if_exists',
  });

  return `https://kc.gateway-vw.de:8443/realms/portal/protocol/openid-connect/auth?${params}`;
}

// At the redirect_uri callback:
async function exchangeCode(code) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: 'portal',
    code,
    redirect_uri: 'https://vw-baev.de/auth/callback',
    code_verifier: sessionStorage.getItem('pkce_verifier'),
  });
  const res = await fetch(
    'https://kc.gateway-vw.de:8443/realms/portal/protocol/openid-connect/token',
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }
  );
  return res.json(); // { access_token, id_token, refresh_token }
}
```

Notes:
- Always validate `state` on return, and verify the ID token (`nonce`, signature via JWKS).
- The token endpoint needs CORS → set the client's **Web origins** to the portal origin.
- In production, prefer port 443 over `:8443` for cleaner URLs and fewer proxy surprises.

---

## Q13 — Federated identity link (subject ↔ Keycloak user)

There are **two different links**. Don't confuse them.

| Link | Between | Who creates it | Where stored |
|------|---------|----------------|--------------|
| **Federated Identity Link** | Verimi identity ↔ Keycloak user | **Keycloak automatically** (First Broker Login flow) | Keycloak `FEDERATED_IDENTITY` table |
| **Account mapping** | Portal account ↔ Keycloak user | **You** (portal code) | Portal DB: `portal_account_id` + `keycloak_sub` |

**You do not build link #1.** The `first broker login` flow's authenticators
(*Create User If Unique*, *Automatically Set Existing User*, *Detect Existing Broker User*) handle
it. That is the payoff of brokering.

**Link #2 is your job:** after the callback, read `sub` from the ID token and store it:
```
portal_account(keycloak_sub = "<uuid>")
```
Then when the user logs in later (via passkey), Keycloak returns the same `sub` → you find the
same portal account.

If you must link an **existing** Keycloak user to Verimi (e.g. a user already in Keycloak),
use the account console ("Add identity provider account") or the **Client-Initiated Account
Linking** API.

---

## Q14 — "The scale risk is sessions" — meaning and mitigation

Keycloak stores every user session (and offline session) in Postgres, with an Infinispan cache in
front. At high concurrency, the **session table** is the hot write path — not the user or
credential tables.

**At your size this is not actually a problem.** 190,000 users with 500–1,000 logins/day means
only a few thousand concurrent sessions. Postgres handles millions of session rows comfortably.
**Your real risk is HA, not volume** (single IONOS VPS = single point of failure).

Mitigations, in priority order:

| Priority | Measure | Why |
|----------|---------|-----|
| 1 | **HA / backups** | The actual risk at 1k logins/day is the VPS dying, not load |
| 2 | Short **SSO Session Idle / Max** (e.g. idle 30 min, max 10 h) | Bounds session table growth |
| 3 | **Avoid offline tokens** unless required | They never expire and bloat the DB |
| 4 | **PgBouncer** connection pooling | Protects Postgres from connection storms |
| 5 | Tune Infinispan caches | Reduces DB round-trips |
| 6 | Multi-node Keycloak + distributed cache | Only if you exceed one node |
| 7 | Read replicas | Limited help (sessions are write-heavy) |

**Sizing verdict:** one well-tuned Postgres + 2 Keycloak replicas behind nginx is ample for
190k users / 1k logins/day.

---

## Q15 — Can I find out the Verimi protocol myself?

Yes, four ways:

1. **Search the portal codebase** for `verimi`, `openid`, `oauth`, `saml`, `client_id`, `SAMLRequest`.
2. **Watch the login redirect** (browser DevTools → Network):
   - URL contains `response_type=code&client_id=...` → **OIDC/OAuth2**.
   - URL contains `SAMLRequest=...` (base64, often deflated) → **SAML**.
3. **Try discovery:** `curl https://<verimi-domain>/.well-known/openid-configuration`
   - Returns JSON with `authorization_endpoint` → **OIDC**.
4. **Ask your Verimi contact / read the integration contract.**

---

## Q16–Q18 — Your concrete environment

| Item | Value | Implication |
|------|-------|-------------|
| Public | `https://kc.gateway-vw.de:8443` | **RP ID = `kc.gateway-vw.de`** — immutable |
| Admin | `https://kc-admin.gateway-vw.de:8444` | Separate host = good practice |
| Hosting | IONOS VPS / Docker | HA must be built manually; plan 2 nodes + HA Postgres |
| Users | ~190,000 | Low load; Postgres easily sufficient |
| Logins | 500–1,000/day | Concurrency is small; focus on HA |

**Actions specific to your environment:**
1. **Freeze `kc.gateway-vw.de` forever.** Passkeys are bound to it; moving it invalidates every
   credential. Document it as immutable in your ops runbook.
2. **TLS cert must cover both** `kc.gateway-vw.de` and `kc-admin.gateway-vw.de`.
3. Broker redirect URI to give Verimi:
   `https://kc.gateway-vw.de:8443/realms/portal/broker/verimi/endpoint`
4. Consider serving on **443** instead of `:8443` (cleaner, fewer proxy/CORS issues). If you
   change the port only, the RP ID is unaffected (RP ID is the domain, not the port).
5. Add the portal origin to the client's **Web origins** (CORS).
6. Restrict the admin console (`:8444`) to a VPN/allow-list, not the public internet.

---

## Q18b — Portal and Keycloak are on DIFFERENT domains (important)

Given:
- Portal: `https://vw-baev.de`
- Keycloak: `https://kc.gateway-vw.de:8443`

These are **two different registrable domains** (`vw-baev.de` vs `gateway-vw.de`). The passkey
**RP ID is `kc.gateway-vw.de`**, because Keycloak is the Relying Party — the portal's domain is
irrelevant to where the passkey is scoped.

### Does it work? Yes.
The login is a **top-level cross-domain redirect**, which is normal OIDC. Keycloak's cookies are
first-party in Keycloak's own context, so there is no third-party-cookie problem. You only need:
- `redirect_uri` registered exactly: `https://vw-baev.de/auth/callback`
- **Web origins** = `https://vw-baev.de` (CORS for the token endpoint)

### The consequences you should weigh

| Issue | Impact |
|-------|--------|
| **Users see a foreign domain** | Clicking "create passkey" jumps to `kc.gateway-vw.de` — a different brand/domain. Looks like a redirect to some users → trust & phishing-perception cost. |
| **RP ID is tied to `gateway-vw.de`** | If that domain is shared, temporary, or repurposed, **every passkey breaks**. |
| **No flexibility** | You cannot later use `vw-baev.de` as the RP ID without re-enrolling all 190k users. |
| **Cross-domain cookies** | Not an issue for the redirect flow; only the token endpoint needs CORS. |

### Recommendation (decide BEFORE enrolling anyone)
Serve Keycloak under the portal's **own** registrable domain, e.g.:

| Option | RP ID becomes | Pros / cons |
|--------|---------------|-------------|
| `login.vw-baev.de` (Keycloak) | `vw-baev.de` | Familiar domain, best trust; RP ID shared across all `*.vw-baev.de` apps |
| `kc.vw-baev.de` (Keycloak) | `vw-baev.de` | Same benefit |
| `login.vw-baev.de` with RP ID `login.vw-baev.de` | `login.vw-baev.de` | Scoped to that subdomain only — less flexible |
| Keep `kc.gateway-vw.de` | `kc.gateway-vw.de` | Works, but **freeze the domain forever** and accept the foreign-domain UX |

**Rule:** RP ID must be a **suffix of the origin** (or equal to it). `vw-baev.de` as RP ID allows
Keycloak at `login.vw-baev.de` **and** future passkey apps at `app.vw-baev.de` etc.

> If you keep `kc.gateway-vw.de`, that is acceptable — but it becomes an **immutable dependency**.
> Document it in the ops runbook and never let the domain lapse or be repurposed.

### ✅ Decision (2026-11-14): keep `kc.gateway-vw.de`
`gateway-vw.de` is confirmed to be a **long-lived domain the organisation controls**. Therefore:

- **RP ID = `kc.gateway-vw.de`** is frozen and safe. Document it as immutable in the ops runbook.
- No re-hosting needed. The only remaining cost is **UX/trust**, not risk.

**Mitigations for the "foreign domain" UX cost:**
1. Apply a **custom Keycloak theme** matching the `vw-baev.de` branding (logo, colours, wording) so
   the login/passkey page looks like part of the portal.
2. Add **clear copy** before the redirect: *"You will be securely redirected to our sign-in
   service (kc.gateway-vw.de) to set up your passkey."*
3. Ensure the TLS certificate is valid and the domain is never allowed to lapse.
4. Keep `gateway-vw.de` out of any future rebrand/domain-consolidation plans, or plan a
   **full passkey re-enrolment** if it ever must change.

**Residual risk:** low. The domain is controlled and long-lived; the passkey scope is stable.

---

## Q19 — Users log into Verimi with username + password

Implications:
- Verimi is a **password-based** IdP → brokering works normally.
- During the transition, the **Verimi password remains the weak link** (phishable). Enrolment is
  time-sensitive: until a user has a passkey, a phished Verimi password still reaches the portal.
- After cutover, passkeys are **phishing-resistant** — a genuine security uplift. Market it that way.

---

## Q20 — Recovery via "random words"

Your described flow maps onto Keycloak's **Recovery Authentication Codes** required action.

| Your description | Keycloak mechanism |
|------------------|--------------------|
| User gets random words at passkey creation | Recovery Codes generated by the `Recovery Authentication Codes` required action (12 one-time codes) |
| User saves them somewhere | User downloads/prints/copies the codes |
| "Reset my passkey" → type the words | User authenticates with a recovery code, then re-enrols the passkey |

### Implementation
1. **Authentication → Required Actions** → enable `Recovery Authentication Codes`.
2. Generate them at enrolment: either set it as a **Default Action**, or trigger a second
   redirect with the recovery-codes AIA action, or include it in the flow.
3. **Add `Recovery Authentication Code Form` to the Browser flow as an ALTERNATIVE authenticator.**
4. Build a portal page "Reset my passkey":
   - Start an OIDC login. If the passkey is lost, the user authenticates with a **recovery code**.
   - Then trigger `kc_action=webauthn-register-passwordless` (optionally first
     `kc_action=delete_credential:<id>` to remove the old credential).

### ⚠️ Critical design point for a passkey-only realm
Keycloak's recovery codes are documented as **2FA** (a second factor after a password). If you go
**fully passwordless**, the recovery code must work as a **first factor**, otherwise a user who
lost their passkey cannot even start authentication. Configure the Browser flow so the
`Recovery Authentication Code Form` is an alternative **at the first-factor level**.

### Security requirements for the recovery words
- They are the **master key** to the account → treat as a high-value credential.
- Stored **hashed** server-side (Keycloak does this).
- Shown **once**, never emailed in plaintext.
- **Rate-limited** (brute-force protection on recovery-code entry).
- Allow **regeneration** (and invalidate old codes).

> "Random words" vs. Keycloak's alphanumeric codes is **cosmetic**. If you specifically want a
> BIP39-style word list, that needs a custom theme/extension — which reintroduces Java. I'd keep
> Keycloak's built-in codes.

---

## Q21 — GDPR / DSGVO

| Topic | Position | Action |
|-------|----------|--------|
| **Data residency** | IONOS VPS in Germany = EU | ✅ No third-country transfer (Art. 44) |
| **Roles** | You = controller; Verimi = processor/controller for auth | Ensure a DPA/AVV with Verimi exists; document the shutdown |
| **Personal data in Keycloak** | email, name, username, IP (logs), sessions, credential metadata | Minimize; define retention |
| **Passkeys** | Only **public** keys stored → not secret, but linked to an identifier → still personal data | Include in your records of processing |
| **Art. 5 minimization** | — | Map only the claims you need from Verimi (`sub`, email, maybe name) |
| **Art. 17 erasure** | — | Build user-deletion (Keycloak has a `delete-account` action) incl. credentials, sessions, and a documented backup window |
| **Art. 32 security** | — | TLS, encryption at rest, least-privilege admin, audit logs |
| **Art. 30 records** | — | Record the processing (Keycloak as IAM) |
| **Art. 25 privacy by design** | — | This architecture (public keys only, no impersonation) supports it |
| **Art. 35 DPIA** | Auth for 190k users, systematic, large scale → likely required | Run a **Datenschutz-Folgenabschätzung** |
| **Logs** | Keycloak audit/user events contain personal data | Retention (e.g. 90 days), purpose limitation, access control |
| **Backups** | GDPR applies to backups too | Document that erasure propagates to backups within N days |

**Additional (if applicable):** BSI TR-02102-1 for cryptography; BSI IT-Grundschutz for the VPS.

**Practical checklist:**
1. Data-processing record (Verzeichnis von Verarbeitungstätigkeiten) updated.
2. Privacy notice for passkey enrolment (Art. 13).
3. Erasure process + tested backup propagation.
4. Audit-log retention policy.
5. DPIA.
6. Admin access to Keycloak restricted and logged.
