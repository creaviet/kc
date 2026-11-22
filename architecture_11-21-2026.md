# Architecture assessment: Is there a better alternative than the BFF?

**Project:** keycloak-passkey-3  
**Date:** 2026-11-21  
**Scope:** Assessment of alternatives to the current Identity-BFF architecture in `impl-broker-bff/`  
**Tech stack:** React SPA, AWS Lambda, Keycloak 26.8 + nginx + Postgres on Docker/IONOS VPS, Verimi as temporary upstream OIDC IdP

---

## 0. Short answer

**No — I would not replace the BFF architecture.** For your exact stack and constraints, it is still the best fit.

Keep:

```text
React SPA  →  AWS Lambda Identity BFF  →  Keycloak (IONOS VPS)  →  Verimi
                    │
                    └── DynamoDB: portal session + user cache
```

I would **not** switch to “SPA talks directly to Keycloak”. That is simpler, but security-wise it is worse for your case.

The only things I would improve are around the edges:

- Keycloak HA / managed Postgres,
- better Keycloak theming,
- optional popup-based redirect UX,
- observability and enrolment dashboard,
- logout hardening.

Those are refinements — not a different architecture.

---

## 1. Why the BFF is the right fit for your stack

### 1.1 React cannot keep secrets

Your Keycloak portal client is a **confidential client**. It has a `client_secret`.

A browser SPA cannot safely keep a client secret. Even if you hide it in the JS bundle, minification does not help — anyone can open DevTools and read it.

With the BFF:

```text
React SPA          → no client secret, no tokens
AWS Lambda BFF     → client secret, PKCE verifier, ID token, access token
Keycloak           → sees a normal confidential OIDC client
```

That is the correct trust boundary.

---

### 1.2 Tokens never enter browser JavaScript

This is the biggest security advantage.

Current model:

```text
Browser JS:  only __Host- HttpOnly cookies
Lambda:      id_token + access_token during callback
```

If you remove the BFF and do direct OIDC in React, the SPA must hold tokens:

```text
Browser JS:  access_token + id_token in memory/sessionStorage
```

That means any XSS bug or malicious npm dependency can steal tokens and call your APIs until they expire.

For an identity migration across 9 portals, I would not accept that trade-off.

---

### 1.3 You get real session revocation

With the BFF, you have a portal session record in DynamoDB:

```text
__Host-pksid → sid → DynamoDB session → revoke possible
```

That means you can kill a session immediately if needed.

With direct JWT validation in Lambda/API Gateway, you usually get:

```text
Browser sends JWT → Lambda validates signature → valid until exp
```

Revocation then requires a denylist, introspection endpoint, or short token lifetimes. More complexity, not less.

---

### 1.4 Passkey enrolment needs a trusted decision point

Your step 9–10 is security-sensitive:

```text
User clicks "create passkey"
→ BFF checks: do we have a valid portal session?
→ BFF starts Keycloak AIA
→ Keycloak performs WebAuthn
→ BFF verifies via Account API
```

The BFF is the place where you can enforce:

- user is logged in,
- enrolment transaction belongs to the same `sub`,
- `kc_action_status` is ignored,
- real credential existence is checked via Keycloak Account API.

Direct SPA OIDC can do this, but it means the browser handles more security state and more tokens.

---

### 1.5 It fits AWS Lambda naturally

Your backend is already Lambda. The BFF map fits cleanly:

```text
GET  /api/auth/login       → build authorization URL, set __Host-pk_tx
GET  /api/auth/callback    → code exchange, token validation, create session
GET  /api/auth/enroll      → start AIA WebAuthn registration
GET  /api/me               → session + passkey status
GET  /api/auth/logout      → clear session, redirect to Keycloak logout
```

Locally you proxy `/api/*` through Vite. In production API Gateway custom domains can do the same.

That is a very natural fit.

---

## 2. Alternatives considered — and why I reject them

### 2.1 Alternative 1: Direct SPA OIDC with Authorization Code + PKCE

This would look like this:

```text
React SPA
  → Keycloak /authorize
  → Verimi
  → Keycloak /callback
  → SPA exchanges code at Keycloak /token
  → SPA stores tokens
  → SPA calls Lambda with Authorization: Bearer <access_token>
```

You could use a browser library such as `oidc-client-ts`.

#### Advantages

- Less backend code.
- No BFF session table needed.
- Standard SPA pattern.
- Fewer Lambda invocations.

#### Why it is worse for you

| Problem | Consequence |
|---|---|
| Tokens in browser | XSS can steal them |
| Public client only | You lose confidential-client secret protection |
| Weak revocation | Logout/session kill is harder |
| Passkey enrolment verification becomes browser-side or token-proxy-heavy | More attack surface |
| Keycloak is still visible in the URL | Does not help your “invisible Keycloak” goal |
| 9 portals × token/session handling in SPA | More repeated security logic |

**Verdict:** simpler, but not better for your security requirements.

---

### 2.2 Alternative 2: API Gateway JWT Authorizer / Lambda authorizer only

This is basically direct SPA OIDC, but token validation moves to API Gateway or a Lambda authorizer:

```text
React SPA → Keycloak → tokens in browser
React SPA → API Gateway with Bearer token
API Gateway/Lambda → validate JWT against JWKS
```

#### Advantages

- Clean JWT validation.
- Less custom session logic.
- API Gateway can reject bad tokens before Lambda.

#### Why it is worse for you

It still has the core problem:

```text
tokens live in the browser
```

It also does not solve:

- passkey enrolment campaign state,
- `sub` ↔ portal account mapping,
- immediate session revocation,
- hiding Keycloak internals,
- confidential client secret handling.

**Verdict:** good pattern for simpler APIs, not better for this migration.

---

### 2.3 Alternative 3: Reverse-proxy Keycloak under each portal domain

Example:

```text
https://vw-baev.de/auth/...
https://ltkv.de/auth/...
```

nginx would proxy `/auth/*` to the Keycloak container.

#### Why this looks attractive

The browser URL would stay on the portal domain. It would feel more “invisible”.

#### Why I reject it

1. **WebAuthn RP ID becomes a mess.**  
   Your current design deliberately uses one WebAuthn RP ID:

   ```text
   gateway-vw.de
   ```

   That is a registrable parent of:

   ```text
   kc.gateway-vw.de
   ```

   If you move login to `vw-baev.de`, the RP ID must become `vw-baev.de` or another valid parent of that origin. `gateway-vw.de` is not valid for `vw-baev.de`.

   So you would have to redesign your WebAuthn identity model.

2. **Nine hostnames means nine Keycloak hostname configurations.**  
   Issuer, cookies, redirect URIs, CORS, themes, and logout URLs all become harder.

3. **Security boundaries get blurred.**  
   Your IdP origin and portal origin should be separate. That separation is useful.

4. **Admin plane remains separate anyway.**  
   You still need `kc-admin.gateway-vw.de:8444` restricted.

**Verdict:** technically possible, but clearly worse. Do not do it.

---

### 2.4 Alternative 4: iframe-based login

I reject this.

Keycloak usually sends:

```text
X-Frame-Options: DENY
Content-Security-Policy: frame-ancestors 'none'
```

Browsers also block third-party cookies and WebAuthn flows inside cross-site iframes more aggressively every year.

**Verdict:** fragile and insecure. Do not build your login on this.

---

### 2.5 Alternative 5: Popup-based login

This one is acceptable as a **UX improvement**, not an architecture replacement.

```text
User clicks Login in React
→ React opens window.open(keycloakAuthorizationUrl)
→ Keycloak/Verimi flow happens in popup
→ popup posts/redirects back
→ main React app updates session
```

#### Advantages

- Main portal tab stays open.
- Can look like a branded sign-in window.
- Does not change OIDC security model.

#### Disadvantages

- Popup blockers.
- Mobile behavior can be awkward.
- Must validate messages/redirects carefully.
- Still shows Keycloak/Verimi domain in the popup URL.

**Verdict:** optional UX layer. Keep the BFF underneath.

---

### 2.6 Alternative 6: oauth2-proxy / OAuth2 Proxy at ingress

This would put a proxy in front of your portals:

```text
Browser → oauth2-proxy → portal
```

#### Why it looks attractive

- Browser sees only the portal.
- Proxy handles OIDC.
- App receives an identity header or cookie.

#### Why it is not better here

Your backend is AWS Lambda + API Gateway, not a traditional ALB/ECS app. You would add another component that does not naturally fit Lambda.

You would also lose or reimplement:

- portal-specific enrolment campaign,
- per-portal session records,
- explicit passkey status,
- `sub` binding to the AIA transaction,
- Account API verification logic.

**Verdict:** not better for this stack.

---

### 2.7 Alternative 7: Replace Keycloak with Cognito / Auth0 / Entra

Not better for your stated requirements.

You already have:

- Keycloak 26.8,
- Verimi as OIDC broker,
- native WebAuthn/passkeys,
- no Java requirement,
- 9 realms,
- nginx + Postgres on IONOS.

Replacing the IdP now would be a migration project inside a migration project.

**Verdict:** not better.

---

## 3. Recommended architecture — keep this

```text
                                ┌──────────────────────────┐
                                │ Browser / React SPA      │
                                │ vw-baev.de, ltkv.de, ... │
                                └────────────┬─────────────┘
                                             │ /api/*
                                             ▼
                                ┌──────────────────────────┐
                                │ AWS Lambda Identity BFF  │
                                │ - OIDC client            │
                                │ - PKCE + state           │
                                │ - HttpOnly cookies       │
                                │ - portal session         │
                                └──────┬───────────┬───────┘
                                       │           │
                 discovery/token/JWKS  │           │ sessions/user cache
                                       ▼           ▼
                       ┌────────────────────────┐  ┌──────────────┐
                       │ Keycloak + nginx       │  │ DynamoDB     │
                       │ kc.gateway-vw.de:8443  │  │ portal state │
                       │ 9 realms               │  └──────────────┘
                       └───────────┬────────────┘
                                   │
                                   ▼
                          ┌────────────────────┐
                          │ Verimi OIDC IdP    │
                          │ until 2026-12-31   │
                          └────────────────────┘

                       ┌────────────────────────┐
                       │ Postgres on IONOS      │
                       │ users + WebAuthn keys  │
                       └────────────────────────┘
```

This keeps the responsibilities clean:

| Component | Responsibility |
|---|---|
| React SPA | UX only |
| Lambda BFF | OIDC protocol, cookies, portal session, enrolment controls |
| Keycloak | Credentials, SSO, broker, WebAuthn |
| Verimi | Temporary bootstrap IdP |
| DynamoDB | Portal-owned state |
| Postgres | Keycloak-owned credential state |

That is textbook separation of concerns.

---

## 4. Important honesty about “the user shouldn’t notice Keycloak”

The BFF hides **protocol complexity**, but it cannot hide the **browser navigation**.

When the browser does OIDC, it must visit:

```text
https://kc.gateway-vw.de:8443/realms/.../protocol/openid-connect/auth
```

So the URL bar will change during login.

What you can hide:

- Keycloak branding → custom theme.
- Keycloak-specific error text → custom theme/messages.
- OIDC parameters → yes, BFF hides them from the SPA.
- Keycloak endpoints → yes, SPA only calls your BFF.

What you cannot cleanly hide:

- the Keycloak domain during the redirect,
- unless you use reverse proxying or iframes — both of which I reject for security/WebAuthn reasons.

So the realistic UX target is:

> “The login page looks like my portal, but the browser briefly visits kc.gateway-vw.de.”

That is a reasonable and secure target.

---

## 5. What I would improve — without changing the architecture

### 5.1 Make Keycloak highly available

The real weakness is not the BFF. It is this:

```text
single IONOS VPS = single point of failure
```

Improvement path:

```text
Phase 1: keep current VPS, but backups + monitoring
Phase 2: managed Postgres
Phase 3: two Keycloak nodes behind nginx/ALB
Phase 4: remove Verimi IdP after cutoff
```

The BFF does not need to change. Only `KC_PUBLIC_URL` / `KC_BASE_URL` may change.

---

### 5.2 Add Keycloak events → CloudWatch/SIEM

Track:

- `LOGIN`,
- `LOGIN_ERROR`,
- `CREDENTIAL_REGISTER`,
- `FIRST_BROKER_LOGIN`,
- `LOGOUT`,
- `UPDATE_PASSWORD` if applicable.

Especially before 2026-12-31 you need an enrolment dashboard:

```text
users total
users with passkey
users without passkey
last Verimi login
```

---

### 5.3 Use a Keycloak login theme

Do not fight the redirect. Brand it.

Theme goals:

- same colors/logo/fonts as portal,
- German text,
- no “Keycloak” wording,
- clear “Passkey erstellen” screen,
- clear recovery/support link.

---

### 5.4 Consider popup mode as UX polish

Keep the BFF. Only change this:

```text
window.location.assign(authorizationUrl)
```

to optionally:

```text
window.open(authorizationUrl, "oidc-login", "...")
```

Use only with a user gesture and strict redirect validation.

Do **not** use iframe.

---

### 5.5 Harden logout further

Optional improvement:

```text
id_token_hint=<stored id_token>
```

in the Keycloak logout URL. Some deployments require it or behave better with it.

If you add it, store the ID token server-side only — for example in the encrypted session record or a short-lived encrypted cookie — never in browser JS.

---

## 6. Final verdict

**Keep the BFF.**

For your stack — React, AWS Lambda, Keycloak on IONOS, Verimi broker, passkey bootstrap, 9 portals — the BFF is not a compromise. It is the correct architecture.

The alternatives are either:

- simpler but less secure: direct SPA OIDC / JWT authorizer,
- visually nicer but WebAuthn-hostile: reverse proxy under portal domains,
- unreliable: iframe,
- unnecessary: oauth2-proxy,
- too large a migration: replacing Keycloak.

Therefore:

> There is no better alternative than the BFF architecture for your current requirements. I would keep it and improve the surrounding infrastructure, observability, theming, and Keycloak availability.
