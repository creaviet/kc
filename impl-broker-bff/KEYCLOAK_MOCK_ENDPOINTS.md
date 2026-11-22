# Keycloak mock endpoints vs. real endpoints in `impl-broker-bff`

Date: 2026-11-21

## Short answer

Yes — in local mock mode, Keycloak is mocked and the URLs are local/fake.

Important nuance: the application code is **environment-driven**, not hard-coded to the mock:

| Mode | Backend config | Frontend config | Effective Keycloak origin |
|---|---|---|---|
| Simple mock | `backend/.env.mock` → `KC_BASE_URL=http://localhost:9443` | `frontend/.env.local` → `VITE_KC_HOST=localhost:9443` | `http://localhost:9443` |
| Emulated VPS | `backend/.env.emulated` → `KC_BASE_URL=http://localhost:8443` | `frontend/.env.emulated.local` → `VITE_KC_HOST=localhost:8443` | `http://localhost:8443` |
| Production / default | `backend/.env` → `KC_BASE_URL=https://kc.gateway-vw.de:8443` | production build guard → `kc.gateway-vw.de:8443` | `https://kc.gateway-vw.de:8443` |

In all examples below, `vw-beav` is the example realm. In production this becomes one realm per portal.

---

## 1. Base URL mapping

| Purpose | Mock base | Real base |
|---|---|---|
| Public Keycloak origin | `http://localhost:9443` or `http://localhost:8443` | `https://kc.gateway-vw.de:8443` |
| Internal Keycloak in emulator | `http://127.0.0.1:8080` behind nginx mock | internal container, e.g. `http://keycloak:8080`, not public |
| Admin console | `http://localhost:8444/admin` | `https://kc-admin.gateway-vw.de:8444/admin/` |

The browser and BFF must **never** call `127.0.0.1:8080` directly. In the emulator, `:8443` is the public nginx mock that proxies to the internal Keycloak mock on `:8080`.

---

## 2. Real OIDC/application endpoints used against Keycloak

### 2.1 OIDC discovery

| | URL |
|---|---|
| Mock, simple | `GET http://localhost:9443/realms/vw-beav/.well-known/openid-configuration` |
| Mock, emulated | `GET http://localhost:8443/realms/vw-beav/.well-known/openid-configuration` |
| Real | `GET https://kc.gateway-vw.de:8443/realms/vw-beav/.well-known/openid-configuration` |

**Who calls it:** the BFF via `openid-client.discovery()` in `backend/src/oidc.js`.

**Purpose:** discovers Keycloak’s endpoint URLs for this realm:

```json
{
  "issuer": "https://kc.gateway-vw.de:8443/realms/vw-beav",
  "authorization_endpoint": ".../protocol/openid-connect/auth",
  "token_endpoint": ".../protocol/openid-connect/token",
  "jwks_uri": ".../protocol/openid-connect/certs",
  "end_session_endpoint": ".../protocol/openid-connect/logout"
}
```

This avoids hard-coding every endpoint. It also ensures the `iss` claim in the ID token matches the discovered issuer.

In code: `backend/src/oidc.js`, `getClientConfig()`.

---

### 2.2 Authorization endpoint — browser login / enrolment start

| | URL |
|---|---|
| Mock, simple | `GET http://localhost:9443/realms/vw-beav/protocol/openid-connect/auth?...` |
| Mock, emulated | `GET http://localhost:8443/realms/vw-beav/protocol/openid-connect/auth?...` |
| Real | `GET https://kc.gateway-vw.de:8443/realms/vw-beav/protocol/openid-connect/auth?...` |

**Who calls it:** the browser. The BFF only builds the URL and returns it as `{ authorizationUrl }` to React.

**Purpose:** starts the OIDC flow. Typical parameters:

```text
GET /realms/vw-beav/protocol/openid-connect/auth
  ?client_id=portal-spa
  &redirect_uri=https://vw-baev.de/api/auth/callback
  &response_type=code
  &scope=openid profile email roles
  &state=<random>
  &nonce=<random>
  &code_challenge=<PKCE S256 hash>
  &code_challenge_method=S256
  &kc_idp_hint=verimi
```

For enrolment, instead of `kc_idp_hint`, the URL contains:

```text
kc_action=webauthn-register-passwordless:skip_if_exists
```

The frontend verifies that the URL really points to the allowed Keycloak origin and has the `/protocol/openid-connect/auth` path before navigating:

```ts
// frontend/src/config.ts
if (target.origin !== KEYCLOAK_ORIGIN) {
  throw new Error(`unexpected_keycloak_origin:${target.origin}`);
}
if (!target.pathname.includes('/protocol/openid-connect/auth')) {
  throw new Error(`unexpected_keycloak_path:${target.pathname}`);
}
```

This is an open-redirect / malicious-IdP protection.

In code: `backend/src/oidc.js`, `createAuthorizationUrl()`; `frontend/src/config.ts`, `toKeycloakAuthorizationUrl()`.

---

### 2.3 Verimi broker callback endpoint

| | URL |
|---|---|
| Mock, simple | `GET http://localhost:9443/realms/vw-beav/broker/verimi/endpoint?code=...&state=...` |
| Mock, emulated | `GET http://localhost:8443/realms/vw-beav/broker/verimi/endpoint?code=...&state=...` |
| Real | `GET https://kc.gateway-vw.de:8443/realms/vw-beav/broker/verimi/endpoint?code=...&state=...` |

**Who calls it:** Verimi redirects the browser here. Our BFF does not call it directly.

**Purpose:** this is Keycloak’s **identity-provider callback**. The alias `verimi` is configured in `keycloak/realm-template.json`:

```json
{
  "alias": "verimi",
  "providerId": "oidc"
}
```

When Verimi sends the user back, Keycloak:

1. validates the Verimi response,
2. links/JIT-provisions the Keycloak user,
3. creates the Keycloak SSO session,
4. redirects the browser back to the portal callback:

```text
https://vw-baev.de/api/auth/callback?code=...&state=...
```

This is the endpoint you must register in Verimi as the OIDC redirect URI for each realm:

```text
https://kc.gateway-vw.de:8443/realms/<realm>/broker/verimi/endpoint
```

That is generated in `backend/ops/generate-api-domains.js`.

---

### 2.4 Token endpoint

| | URL |
|---|---|
| Mock, simple | `POST http://localhost:9443/realms/vw-beav/protocol/openid-connect/token` |
| Mock, emulated | `POST http://localhost:8443/realms/vw-beav/protocol/openid-connect/token` |
| Real | `POST https://kc.gateway-vw.de:8443/realms/vw-beav/protocol/openid-connect/token` |

**Who calls it:** the BFF via `openid-client.authorizationCodeGrant()`.

**Purpose:** exchanges the short-lived authorization code for tokens:

```text
code + PKCE verifier + client_secret_basic
    -> id_token + access_token
```

The BFF sends the client secret in the HTTP Basic header:

```text
Authorization: Basic base64url(client_id:client_secret)
```

`openid-client` then validates:

- `state`,
- `nonce`,
- PKCE S256 verifier,
- ID token signature,
- `iss`,
- `aud`,
- `azp`,
- expiry.

In code: `backend/src/oidc.js`, `completeAuthorization()`.

---

### 2.5 JWKS / certificate endpoint

| | URL |
|---|---|
| Mock, simple | `GET http://localhost:9443/realms/vw-beav/protocol/openid-connect/certs` |
| Mock, emulated | `GET http://localhost:8443/realms/vw-beav/protocol/openid-connect/certs` |
| Real | `GET https://kc.gateway-vw.de:8443/realms/vw-beav/protocol/openid-connect/certs` |

**Who calls it:** `openid-client`, indirectly, because the code enables:

```js
const execute = [client.enableNonRepudiationChecks];
```

**Purpose:** fetches the realm’s public keys so the BFF can cryptographically verify the ID token signature.

The BFF does not trust the callback query parameter. It verifies the signed token.

In code: `backend/src/oidc.js`, `getClientConfig()`.

---

### 2.6 Account API — authoritative passkey check

| | URL |
|---|---|
| Mock, simple | `GET http://localhost:9443/realms/vw-beav/account/credentials?type=webauthn-passwordless` |
| Mock, emulated | `GET http://localhost:8443/realms/vw-beav/account/credentials?type=webauthn-passwordless` |
| Real | `GET https://kc.gateway-vw.de:8443/realms/vw-beav/account/credentials?type=webauthn-passwordless` |

**Who calls it:** the BFF, using the logged-in user’s access token:

```js
fetch(url, {
  headers: { authorization: `Bearer ${accessToken}` },
  signal: AbortSignal.timeout(8000),
});
```

**Purpose:** asks Keycloak: “does this user really have a `webauthn-passwordless` credential?”

Expected Keycloak 26 response shape:

```json
[
  {
    "type": "webauthn-passwordless",
    "category": "passwordless",
    "userCredentialMetadatas": [
      { "credential": { "id": "...", "type": "webauthn-passwordless" } }
    ]
  }
]
```

The BFF checks:

```js
return containers.some(
  (entry) =>
    entry?.type === 'webauthn-passwordless' &&
    Array.isArray(entry.userCredentialMetadatas) &&
    entry.userCredentialMetadatas.length > 0,
);
```

This matters because the callback URL contains `kc_action_status=success`, but that value is user-controllable. For security, the app ignores it and asks the Account API instead.

In code: `backend/src/oidc.js`, `hasPasskey()`.

---

### 2.7 Logout endpoint

| | URL |
|---|---|
| Mock, simple | `GET http://localhost:9443/realms/vw-beav/protocol/openid-connect/logout?client_id=portal-spa&post_logout_redirect_uri=http://localhost:5173/` |
| Mock, emulated | `GET http://localhost:8443/realms/vw-beav/protocol/openid-connect/logout?...` |
| Real | `GET https://kc.gateway-vw.de:8443/realms/vw-beav/protocol/openid-connect/logout?client_id=portal-spa&post_logout_redirect_uri=https://vw-baev.de/` |

**Who calls it:** the browser, after the BFF builds the redirect.

**Purpose:** ends the Keycloak SSO session and returns to the portal homepage. The BFF also clears its own cookies:

```js
[clearCookie(COOKIES.tx), clearCookie(COOKIES.session), clearCookie(COOKIES.enrolled)]
```

In code: `backend/src/handlers/logout.js`.

---

## 3. Endpoints advertised/mocked but not used by the application

| Endpoint | Mock | Real | Purpose / status |
|---|---|---|---|
| `GET /realms/vw-beav` | `http://localhost:8443/realms/vw-beav` in emulated mock | `https://kc.gateway-vw.de:8443/realms/vw-beav` | Deployment verification only; used by `verify-keycloak.sh`, not by login flow |
| `GET /realms/vw-beav/protocol/openid-connect/userinfo` | advertised in discovery | real Keycloak UserInfo endpoint | Advertised, but our BFF does **not** call it; identity claims come from the verified ID token |
| `GET /admin` / `GET /admin/...` | `http://localhost:8444/admin` | `https://kc-admin.gateway-vw.de:8444/admin/` | Admin console test only; deliberately not used in user journey |
| `GET /healthz` | `http://localhost:8080/healthz` internal, `http://localhost:8443/healthz` nginx mock | not the same endpoint; Keycloak health is usually `/health/live`, `/health/ready` if enabled | Local emulator convenience only |
| `GET /mock/reset` | `http://localhost:9443/mock/reset` or `http://localhost:8443/mock/reset` | no real equivalent | Test helper; resets simulated passkey state |
| `POST /mock-aia/enroll` | `http://localhost:9443/mock-aia/enroll` or via `:8443` | no direct public API equivalent | Simulates WebAuthn registration page submit |
| `POST /mock-passkey/login` | `http://localhost:9443/mock-passkey/login` or via `:8443` | no direct public API equivalent | Simulates WebAuthn assertion verification |
| `GET /mock-verimi/authorize` | simple: `http://localhost:9443/mock-verimi/authorize`; emulated: `http://localhost:3443/mock-verimi/authorize` | real Verimi authorization URL, currently placeholder `__VERIMI_AUTHORIZATION_URL__` | Mock external IdP, not Keycloak |
| `POST /mock-verimi/login` | same mock origin | real Verimi-hosted login form | Mock only; we never implement or call real Verimi login logic |

The real Verimi URLs are placeholders in `keycloak/realm-template.json`:

```json
{
  "authorizationUrl": "__VERIMI_AUTHORIZATION_URL__",
  "tokenUrl": "__VERIMI_TOKEN_URL__",
  "userInfoUrl": "__VERIMI_USERINFO_URL__",
  "logoutUrl": "__VERIMI_LOGOUT_URL__",
  "jwksUrl": "__VERIMI_JWKS_URL__"
}
```

Those must come from Verimi’s OIDC metadata/configuration. They are not Keycloak endpoints.

---

## 4. Call chain with mock vs real URLs

```text
1. Browser -> BFF
   GET /api/auth/login?method=verimi

2. BFF -> Keycloak discovery
   mock: GET http://localhost:8443/realms/vw-beav/.well-known/openid-configuration
   real: GET https://kc.gateway-vw.de:8443/realms/vw-beav/.well-known/openid-configuration

3. BFF -> Browser
   200 { authorizationUrl }

4. Browser -> Keycloak authorize
   mock: GET http://localhost:8443/realms/vw-beav/protocol/openid-connect/auth?kc_idp_hint=verimi...
   real: GET https://kc.gateway-vw.de:8443/realms/vw-beav/protocol/openid-connect/auth?kc_idp_hint=verimi...

5. Keycloak -> Verimi
   mock: 302 http://localhost:3443/mock-verimi/authorize
   real: 302 <real Verimi authorization URL>

6. Verimi -> Keycloak broker callback
   mock: GET http://localhost:8443/realms/vw-beav/broker/verimi/endpoint?code=...&state=...
   real: GET https://kc.gateway-vw.de:8443/realms/vw-beav/broker/verimi/endpoint?code=...&state=...

7. Keycloak -> BFF callback
   mock: 302 http://localhost:5173/api/auth/callback?code=...&state=...
   real: 302 https://vw-baev.de/api/auth/callback?code=...&state=...

8. BFF -> Keycloak token endpoint
   mock: POST http://localhost:8443/realms/vw-beav/protocol/openid-connect/token
   real: POST https://kc.gateway-vw.de:8443/realms/vw-beav/protocol/openid-connect/token

9. BFF -> Keycloak JWKS
   mock: GET http://localhost:8443/realms/vw-beav/protocol/openid-connect/certs
   real: GET https://kc.gateway-vw.de:8443/realms/vw-beav/protocol/openid-connect/certs

10. BFF -> Keycloak Account API
   mock: GET http://localhost:8443/realms/vw-beav/account/credentials?type=webauthn-passwordless
   real: GET https://kc.gateway-vw.de:8443/realms/vw-beav/account/credentials?type=webauthn-passwordless
```

For passkey enrolment, step 4 changes from `kc_idp_hint=verimi` to:

```text
kc_action=webauthn-register-passwordless:skip_if_exists
```

For passkey login, both `kc_idp_hint` and `kc_action` are omitted.

---

## 5. Conclusion

When you run the mock modes, these local URLs are used instead of the real ones:

```text
http://localhost:9443/...   -> https://kc.gateway-vw.de:8443/...
http://localhost:8443/...   -> https://kc.gateway-vw.de:8443/...
http://localhost:8444/...   -> https://kc-admin.gateway-vw.de:8444/...
http://localhost:3443/...   -> real Verimi endpoints, values not known here
```

The security-sensitive application code path is still real OIDC: discovery, PKCE, state/nonce validation, code exchange, JWKS signature verification, and Account API credential verification are implemented with `openid-client` and behave the same against real Keycloak. The mock only replaces Keycloak/Verimi/WebAuthn behaviour and uses HTTP/localhost for development.
