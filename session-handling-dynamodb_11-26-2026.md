# Session Handling and DynamoDB in the Keycloak Passkey Architecture

**Date:** 2026-11-26  
**Project:** keycloak-passkey-3  
**Scope:** Which sessions exist in the Verimi → Keycloak → portal → passkey flow, who owns them, and where DynamoDB is actually needed.

---

## 1. Short answer

**No — you do not need DynamoDB for the whole process.**

There are different kinds of “sessions”:

| Session type | Who owns it? | Where it lives | DynamoDB needed? |
|---|---|---|---|
| Login/Auth session during Verimi → Keycloak redirect | Keycloak | Keycloak auth session / PostgreSQL | ❌ No |
| Keycloak SSO session | Keycloak | PostgreSQL + Keycloak cookie | ❌ No |
| WebAuthn/passkey registration challenge | Keycloak | Keycloak auth session | ❌ No |
| Passkey credential storage | Keycloak | PostgreSQL | ❌ No |
| Portal application session | Your Lambda/backend | You choose | ⚠️ Maybe |
| PKCE `state` / `nonce` / `code_verifier` during portal → Keycloak | Your backend/frontend | Cookie or backend store | ⚠️ Maybe |

So:

> **DynamoDB is not needed for Keycloak’s work. It is only useful for your own Lambda/portal session layer.**

---

## 2. The core principle

Keycloak handles identity sessions.

Your portal handles application sessions.

Do not mix them.

```text
Keycloak answers:
  "Who is this user?"
  "Is this passkey valid?"
  "Is the user still logged in to Keycloak?"

Your portal answers:
  "Is this browser allowed to use this portal right now?"
  "Which portal account is this?"
  "Which portal permissions does this user have?"
```

For your architecture, the clean model is:

```text
React portal
   |
   | session cookie
   v
AWS Lambda BFF
   |
   | OIDC code flow
   v
Keycloak
   |
   | brokered login
   v
Verimi / Passkey
```

React should **not** store access tokens or ID tokens in `localStorage`.

Use a **Backend-for-Frontend**, BFF, pattern:

```text
Browser gets only an HttpOnly session cookie.
Lambda holds the OIDC tokens server-side.
Keycloak holds the SSO/identity session.
```

---

## 3. Session flow for login

```text
1. Browser clicks "Login"
        ↓
2. React calls Lambda:
   GET /auth/login
        ↓
3. Lambda creates:
   - loginId
   - state
   - nonce
   - PKCE code_verifier
        ↓
4. Lambda stores them temporarily
   - DynamoDB OR encrypted cookie
        ↓
5. Lambda sets HttpOnly cookie:
   __Host-auth_login=<loginId>
        ↓
6. Browser redirects to Keycloak authorize endpoint
        ↓
7. Keycloak → Verimi → back to Keycloak
        ↓
8. Keycloak redirects to:
   GET /auth/callback?code=...&state=...
        ↓
9. Lambda validates state, exchanges code with Keycloak,
   validates ID token, maps user to portal account
        ↓
10. Lambda creates portal app session
        ↓
11. Lambda sets HttpOnly cookie:
   __Host-portal_session=<sessionId>
        ↓
12. React calls APIs with cookie only
```

The important bit:

```text
The PKCE code_verifier must survive the browser redirects.
```

That is why you need either:

```text
A. server-side temporary storage, e.g. DynamoDB
B. encrypted cookie containing the temporary login state
```

---

## 4. Do I recommend DynamoDB?

For your case, yes — for the **portal app session and temporary login state**.

Why?

Because you have:

```text
✅ AWS Lambda, which is stateless
✅ 9 independent portals
✅ need for revocation/logout
✅ potential millions of users
✅ no need to manage servers
✅ need for TTL expiry
```

DynamoDB is a good fit:

```text
on-demand capacity
automatic scaling
TTL expiry
encryption at rest
low operational overhead
IAM-controlled access
```

But you do **not** use DynamoDB to store:

```text
❌ Keycloak SSO sessions
❌ Verimi session state
❌ WebAuthn challenges
❌ passkey credentials
```

Those stay in Keycloak.

---

## 5. Recommended DynamoDB table

One table is enough.

```text
Table: portal-auth-sessions
Partition key: pk (String)
TTL attribute: expiresAt
```

Example items:

### Temporary login state

```json
{
  "pk": "login#8f3a...",
  "kind": "login",
  "state": "b41c...",
  "nonce": "c92f...",
  "codeVerifier": "d83k...",
  "redirectUri": "https://www.vw-baev.de/auth/callback",
  "createdAt": 1764160000,
  "expiresAt": 1764160600
}
```

TTL:

```text
5–10 minutes
```

### Portal app session

```json
{
  "pk": "sess#91ab...",
  "kind": "app",
  "portalUserId": "portal-user-123",
  "keycloakSub": "kc-user-uuid",
  "verimiSub": "verimi-sub-from-token",
  "email": "user@example.de",
  "idToken": "eyJ...",
  "accessToken": "eyJ...",
  "createdAt": 1764160000,
  "idleExpiresAt": 1764188800,
  "expiresAt": 1764200000
}
```

Important:

```text
expiresAt = absolute session expiry
idleExpiresAt = idle timeout
```

DynamoDB TTL cleanup is eventual, so your Lambda must always check expiry itself.

---

## 6. Node.js 24 Lambda example: DynamoDB session store

Install:

```bash
npm install @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb
```

Example `session-store.mjs`:

```js
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const TABLE_NAME = process.env.SESSION_TABLE;

if (!TABLE_NAME) {
  throw new Error("SESSION_TABLE environment variable is missing");
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const nowSeconds = () => Math.floor(Date.now() / 1000);

const newId = () => randomBytes(32).toString("base64url");

export async function createLoginState({ redirectUri, ttlSeconds = 600 }) {
  const loginId = newId();
  const state = newId();
  const nonce = newId();
  const codeVerifier = newId();

  const codeChallenge = createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");

  const createdAt = nowSeconds();

  await ddb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        pk: `login#${loginId}`,
        kind: "login",
        state,
        nonce,
        codeVerifier,
        redirectUri,
        createdAt,
        expiresAt: createdAt + ttlSeconds,
      },
      ConditionExpression: "attribute_not_exists(pk)",
    }),
  );

  return {
    loginId,
    state,
    nonce,
    codeVerifier,
    codeChallenge,
  };
}

export async function consumeLoginState({ loginId, receivedState }) {
  const pk = `login#${loginId}`;

  const result = await ddb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { pk },
      ConsistentRead: true,
    }),
  );

  const item = result.Item;

  if (!item || item.kind !== "login") {
    throw new Error("Invalid login state");
  }

  if (item.expiresAt <= nowSeconds()) {
    throw new Error("Login state expired");
  }

  const expected = Buffer.from(item.state);
  const actual = Buffer.from(receivedState ?? "");

  if (
    expected.length !== actual.length ||
    !timingSafeEqual(expected, actual)
  ) {
    throw new Error("Invalid OAuth state");
  }

  await ddb.send(
    new DeleteCommand({
      TableName: TABLE_NAME,
      Key: { pk },
      ConditionExpression: "attribute_exists(pk)",
    }),
  );

  return item;
}

export async function createAppSession({
  portalUserId,
  keycloakSub,
  verimiSub,
  email,
  idToken,
  accessToken,
  idleSeconds = 8 * 60 * 60,
  absoluteSeconds = 24 * 60 * 60,
}) {
  const sessionId = newId();
  const createdAt = nowSeconds();

  await ddb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        pk: `sess#${sessionId}`,
        kind: "app",
        portalUserId,
        keycloakSub,
        verimiSub,
        email,
        idToken,
        accessToken,
        createdAt,
        idleExpiresAt: createdAt + idleSeconds,
        expiresAt: createdAt + absoluteSeconds,
      },
      ConditionExpression: "attribute_not_exists(pk)",
    }),
  );

  return sessionId;
}

export async function getAppSession({ sessionId }) {
  const result = await ddb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { pk: `sess#${sessionId}` },
      ConsistentRead: true,
    }),
  );

  const item = result.Item;

  if (!item || item.kind !== "app") {
    return null;
  }

  const current = nowSeconds();

  if (
    item.expiresAt <= current ||
    item.idleExpiresAt <= current
  ) {
    return null;
  }

  return item;
}

export async function deleteAppSession({ sessionId }) {
  await ddb.send(
    new DeleteCommand({
      TableName: TABLE_NAME,
      Key: { pk: `sess#${sessionId}` },
    }),
  );
}
```

---

## 7. Cookie handling

Use opaque IDs in cookies, not JWTs.

```js
export function authStateCookie(loginId, maxAge = 600) {
  return [
    `__Host-auth_login=${loginId}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ].join("; ");
}

export function appSessionCookie(sessionId, maxAge = 8 * 60 * 60) {
  return [
    `__Host-portal_session=${sessionId}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ].join("; ");
}

export function clearAppSessionCookie() {
  return [
    "__Host-portal_session=",
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Max-Age=0",
  ].join("; ");
}
```

Important:

```text
Use SameSite=Lax, not Strict.
```

Why?

Because the OIDC callback is a cross-site top-level redirect from Keycloak back to your portal.

```text
SameSite=Strict can break the callback because the cookie is not sent.
SameSite=Lax allows cookies on top-level GET navigation.
```

---

## 8. Do not store tokens in React

Bad:

```js
localStorage.setItem("access_token", token);
localStorage.setItem("id_token", token);
```

Why bad:

```text
Any XSS bug can steal them.
They can be read by JavaScript.
They are hard to revoke cleanly.
```

Better:

```text
React stores nothing sensitive.
Lambda stores tokens server-side.
Browser receives only HttpOnly opaque session cookie.
```

---

## 9. Logout handling

Logout needs two things:

```text
1. Delete your portal session in DynamoDB
2. End the Keycloak SSO session
```

Flow:

```text
Browser → Lambda /auth/logout
        ↓
Lambda deletes DynamoDB session
Lambda clears portal cookie
        ↓
Browser → Keycloak logout endpoint
        ↓
Keycloak clears SSO cookie
```

Example logout redirect:

```http
GET https://kc.gateway-vw.de:8443/realms/<realm>/protocol/openid-connect/logout
    ?post_logout_redirect_uri=https://www.vw-baev.de/logged-out
    &client_id=<portal-client>
    &id_token_hint=<stored-id-token>
```

Store `id_token` in your Lambda session item so you can send `id_token_hint` during logout.

---

## 10. Passkey registration does not need DynamoDB

When the user clicks:

```text
"Create passkey"
```

the flow is:

```text
Portal → Keycloak Account Console / required action
       → WebAuthn registration ceremony
       → credential stored by Keycloak
       → redirect back to portal
```

Your Lambda only needs to know:

```text
The user is already authenticated in the portal.
```

You do not create the passkey yourself.

You do not store the passkey in DynamoDB.

Keycloak stores:

```text
WebAuthn credential ID
public key
sign counter
user handle
transport info
```

in its own database.

---

## 11. Multiple portals

Important cookie rule:

```text
Cookies are scoped by domain.
```

So:

```text
www.vw-baev.de
www.ltkv.de
other-domain.de
```

cannot share the same application session cookie.

But they can share the same Keycloak SSO session if they use:

```text
same Keycloak realm
same browser
same Keycloak domain
```

So this is normal:

```text
Portal A session cookie → portal A only
Portal B session cookie → portal B only
Keycloak SSO cookie    → shared across both portals
```

You do not need one global DynamoDB session unless you intentionally want a central session service.

---

## 12. When you can avoid DynamoDB

You can avoid DynamoDB if you already have another secure session store:

```text
existing PostgreSQL
existing Redis/ElastiCache
existing server-side session mechanism
```

Or if you use encrypted stateless cookies.

For stateless cookies, use a proven library such as:

```text
jose for JWE
AWS Encryption SDK
AWS KMS via AWS SDK
```

Do not invent your own encryption.

However, stateless cookies have disadvantages:

```text
harder instant revocation
larger cookies
key rotation complexity
more careful crypto handling
```

For your use case, I would still choose DynamoDB.

---

## 13. Security rules

Use these rules:

```text
✅ opaque random session IDs
✅ HttpOnly cookies
✅ Secure cookies
✅ SameSite=Lax
✅ __Host- cookie prefix
✅ short login-state TTL, 5–10 min
✅ absolute app-session TTL, e.g. 24 h
✅ idle app-session TTL, e.g. 8 h
✅ check expiry in code, not only DynamoDB TTL
✅ rotate session ID after login
✅ validate state and nonce
✅ use PKCE
✅ never put tokens in localStorage
✅ never log tokens or session IDs
✅ delete session on logout
```

DynamoDB configuration:

```text
✅ encryption at rest enabled
✅ on-demand capacity
✅ TTL enabled on expiresAt
✅ least-privilege IAM policy
✅ point-in-time recovery optional but recommended
```

---

## 14. My recommendation for your architecture

Use this split:

```text
Keycloak/PostgreSQL:
  - Verimi broker session
  - SSO session
  - passkeys
  - WebAuthn challenges
  - federated identity links

DynamoDB:
  - temporary OIDC login state
  - portal app session
  - id_token / access_token if Lambda needs them
  - mapping data: keycloakSub, verimiSub, portalUserId

React:
  - no tokens
  - no passkey secrets
  - only calls Lambda with HttpOnly cookie
```

So the direct answer is:

> **You need session handling, but not DynamoDB for everything. DynamoDB is best used only for your Lambda/portal application session and temporary OIDC state. Keycloak already handles the identity, broker, SSO, and passkey sessions.**
