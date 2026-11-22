# OIDC redirect-flow clarification: who calls Keycloak, Verimi, and the portal callback?

**Project:** keycloak-passkey-3  
**Date:** 2026-11-21  
**Scope:** Clarification of the browser/Lambda/Keycloak/Verimi interaction during login

---

## Short answer

The high-level flow is:

```text
React → Lambda → Browser → Keycloak → Verimi → Keycloak → Lambda → React
```

The important technical correction is:

> The Lambda does **not** follow the redirect chain itself.  
> The Lambda **starts** the flow by returning the Keycloak authorization URL to the browser.  
> Then the **browser** is redirected: Keycloak → Verimi → Keycloak → portal callback.  
> The Lambda is invoked again when the browser lands back on the portal callback.

So:

```text
1. User clicks login in React

2. Browser → Lambda:
   GET /api/auth/login?method=verimi

3. Lambda:
   - creates state
   - creates nonce
   - creates PKCE verifier
   - encrypts them into __Host-pk_tx cookie
   - builds Keycloak authorizationUrl
   - returns { authorizationUrl } to React

4. React:
   window.location.assign(authorizationUrl)

5. Browser → Keycloak:
   GET /realms/vw-beav/protocol/openid-connect/auth?...&kc_idp_hint=verimi

6. Keycloak → Browser:
   302 Location: Verimi authorization URL

7. Browser → Verimi:
   user logs in at Verimi

8. Verimi → Browser:
   302 Location: Keycloak broker callback

9. Browser → Keycloak:
   GET /realms/vw-beav/broker/verimi/endpoint?code=...&state=...

10. Keycloak → Browser:
   302 Location: https://vw-baev.de/api/auth/callback?code=...&state=...

11. Browser → API Gateway → Lambda:
   GET /api/auth/callback?code=...&state=...

12. Lambda:
   - reads encrypted transaction cookie
   - verifies state
   - POSTs code + PKCE verifier to Keycloak /token
   - validates ID token
   - checks passkey status via Account API
   - creates portal session cookie
   - redirects browser to portal homepage

13. Browser → React:
   GET /?login=success
```

---

## 1. Front-channel vs back-channel

This is the core IAM principle behind the flow.

### Front-channel = browser redirects

These calls happen through the user’s browser:

| Step | Call |
|---|---|
| 1 | Browser → Keycloak `/protocol/openid-connect/auth` |
| 2 | Keycloak → Verimi `/authorize` |
| 3 | Verimi → Keycloak `/broker/verimi/endpoint` |
| 4 | Keycloak → Portal `/api/auth/callback` |

These are HTTP `302 Redirect` responses. The browser follows them.

### Back-channel = server-to-server

These calls happen from Lambda to Keycloak:

| Purpose | Endpoint |
|---|---|
| Discovery | `GET /realms/{realm}/.well-known/openid-configuration` |
| JWKS | `GET /realms/{realm}/protocol/openid-connect/certs` |
| Code exchange | `POST /realms/{realm}/protocol/openid-connect/token` |
| Passkey check | `GET /realms/{realm}/account/credentials?type=webauthn-passwordless` |

These happen inside Lambda, not in the browser.

---

## 2. So does Lambda “call Keycloak”?

### Yes, Lambda calls Keycloak for back-channel OIDC work

For example:

```js
client.discovery(...)
client.authorizationCodeGrant(...)
fetch(`${config.kcBaseUrl}/realms/${realm}/account/credentials?...`)
```

That is in:

```text
backend/src/oidc.js
```

### No, Lambda does not call the browser-facing authorize endpoint

The Lambda does **not** do:

```js
fetch(keycloakAuthorizationUrl)
```

That would be wrong.

Instead, it returns the URL to React:

```js
return response(200, { authorizationUrl }, {
  cookies: [setCookie(COOKIES.tx, sealedTx, config.txTtl)],
});
```

React then does:

```ts
window.location.assign(authorizationUrl);
```

The browser must be the one that visits Keycloak.

---

## 3. Why can’t Lambda follow the redirects itself?

Because the login flow depends on things that exist only in the user’s browser.

### 3.1 Keycloak SSO cookie

After the user logs in, Keycloak sets a session cookie in the browser, e.g. for:

```text
kc.gateway-vw.de
```

Later, when the user creates a passkey, Keycloak uses that SSO cookie to know the user is already authenticated.

If Lambda followed the redirects itself, the Keycloak SSO cookie would be stored in the Lambda HTTP client, not in the user’s browser. That would break the enrolment flow.

### 3.2 Verimi login UI

Verimi needs the real user to type credentials. Lambda cannot do that.

### 3.3 WebAuthn/passkey ceremony

WebAuthn requires:

```text
user presence
user verification
browser API
authenticator device
correct origin
```

A Lambda cannot perform:

```js
navigator.credentials.create()
navigator.credentials.get()
```

That is why passkey enrolment must happen on the Keycloak origin in the browser:

```text
https://kc.gateway-vw.de:8443
```

### 3.4 Browser-bound CSRF protection

Your `state`, `nonce`, and PKCE verifier are bound to the browser via the encrypted cookie:

```text
__Host-pk_tx
```

If Lambda followed the redirect chain itself, the browser would not carry the same transaction state back to `/api/auth/callback`.

---

## 4. Exact code path

### 4.1 Frontend click

`frontend/src/components/LoginPanel.tsx`:

```tsx
async function handleLogin(method: LoginMethod) {
  const { authorizationUrl } = await startLogin(method);

  const target = toKeycloakAuthorizationUrl(authorizationUrl);
  window.location.assign(target.toString());
}
```

This is the moment the browser leaves the portal.

---

### 4.2 Lambda creates the transaction

`backend/src/handlers/login.js`:

```js
const tx = createOidcTransaction({
  flow: 'login',
  portal: portal.portalId,
  hasPasskey,
  loginMethod,
});
```

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

Then:

```js
const sealedTx = await seal(tx, config.txKey, {
  ttl: config.txTtl,
  issuer: TX_ISSUER,
  audience: portal.portalId,
});
```

That produces the encrypted transaction cookie.

---

### 4.3 Lambda builds the Keycloak URL

`backend/src/oidc.js`:

```js
const params = {
  response_type: 'code',
  redirect_uri: redirectUri,
  scope: 'openid profile email roles',
  state: tx.state,
  nonce: tx.nonce,
  code_challenge: await client.calculatePKCECodeChallenge(tx.verifier),
  code_challenge_method: 'S256',
};

if (flow === 'login' && config.phase === 'B') {
  params.kc_idp_hint = 'verimi';
}
```

So the first browser redirect is:

```http
GET https://kc.gateway-vw.de:8443/realms/vw-beav/protocol/openid-connect/auth
  ?client_id=portal-spa
  &redirect_uri=https://vw-baev.de/api/auth/callback
  &response_type=code
  &scope=openid profile email roles
  &state=<BFF_STATE>
  &nonce=<BFF_NONCE>
  &code_challenge=<PKCE_CHALLENGE>
  &code_challenge_method=S256
  &kc_idp_hint=verimi
```

---

## 5. What Keycloak does with `kc_idp_hint=verimi`

Because of:

```text
kc_idp_hint=verimi
```

Keycloak does **not** show its own login form.

It immediately returns:

```http
HTTP/1.1 302 Found
Location: https://verimi.../authorize?...
```

The browser follows that to Verimi.

That is why the user should not visually notice Keycloak during the Verimi login path.

---

## 6. What Verimi sends back

After successful Verimi login, Verimi redirects the browser to the broker callback configured in Keycloak:

```text
https://kc.gateway-vw.de:8443/realms/vw-beav/broker/verimi/endpoint?code=...&state=...
```

Important:

```text
Verimi → Keycloak
```

is a browser redirect, not a direct server call from Verimi to Keycloak.

At that moment, Keycloak processes the broker response, provisions/links the user, creates its SSO session, and then redirects the browser back to the portal callback configured for the client:

```text
https://vw-baev.de/api/auth/callback?code=...&state=...
```

That callback goes to API Gateway → Lambda.

---

## 7. Lambda is invoked twice in this flow

This is a useful mental model.

### Invocation 1: `/api/auth/login`

Purpose:

```text
prepare OIDC transaction
create state/nonce/verifier
set encrypted cookie
return authorizationUrl
```

### Invocation 2: `/api/auth/callback`

Purpose:

```text
verify callback
exchange code for tokens
validate ID token
check passkey
create portal session
redirect to portal
```

Therefore:

```text
Lambda starts the login.
Browser performs the redirects.
Lambda finishes the login.
```

---

## 8. Corrected mental model

The original statement was almost right:

> “Shouldn't the triggered lambda call Keycloak, and Keycloak redirects to Verimi, then redirects back to Keycloak and Keycloak then redirects to the portal?”

Correct version:

> The triggered Lambda **asks the browser to go to Keycloak** by returning an `authorizationUrl`.  
> The browser then goes to Keycloak.  
> Keycloak redirects the **browser** to Verimi.  
> Verimi redirects the **browser** back to Keycloak’s broker endpoint.  
> Keycloak redirects the **browser** to the portal callback.  
> That callback invokes the Lambda again, which completes the token exchange and creates the portal session.

That is the actual OAuth/OIDC design. Redirects are browser operations, not Lambda operations.
