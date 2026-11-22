# Keycloak 26.8 production configuration (no Java, no Verimi changes)

Keycloak is the identity broker and WebAuthn/passkey authority. One realm is used
per portal. The browser always performs the WebAuthn ceremony on Keycloak's
origin:

```text
https://kc.gateway-vw.de:8443
```

The portal domains only start and finish the OIDC redirect flow. They are never
WebAuthn relying parties. This is why the passkey RP ID is `gateway-vw.de`, not
`vw-baev.de`, `ltkv.de`, etc.

---

## 1. Fill the portal manifest

This production folder deliberately ships **no default `portals.json`**. Create
it from `backend/ops/portals.example.json`:

```bash
cd /home/think/Dev/ai/ideas/Projects/keycloak-passkey-3/impl-broker-production
cp backend/ops/portals.example.json backend/ops/portals.json
# Replace all 7 placeholder hosts with the real 9 portal domains.
```

Shape:

```json
{
  "expectedPortalCount": 9,
  "portals": [
    { "host": "vw-baev.de", "realm": "vw-beav", "displayName": "VW BEAV Portal" },
    { "host": "ltkv.de", "realm": "vw-ltkv", "displayName": "LTKV Portal" }
  ]
}
```

`backend/ops/portals.js` rejects placeholder `.example.*` hosts, duplicates,
invalid realms and counts other than 9.

---

## 2. Generate the 9 realm exports

Set the real Verimi endpoints from Verimi's OIDC metadata. Verimi itself is not
modified. Keycloak is the OIDC Relying Party toward Verimi.

```bash
cd impl-broker-production

PORTALS_FILE="$PWD/backend/ops/portals.json" \
VERIMI_AUTHORIZATION_URL='https://<verimi-host>/authorize' \
VERIMI_TOKEN_URL='https://<verimi-host>/token' \
VERIMI_USERINFO_URL='https://<verimi-host>/userinfo' \
VERIMI_JWKS_URL='https://<verimi-host>/jwks' \
VERIMI_ISSUER='https://<verimi-host>' \
VERIMI_CLIENT_ID='<verimi-client-id>' \
npm --prefix backend run ops:generate:realms
```

Generated files land in `keycloak/generated/`. That folder is gitignored because
it contains environment-specific configuration.

The generator fills:

- `realm` and `displayName`
- `redirectUris`: `https://<portal>/api/auth/callback`
- `webOrigins`: `https://<portal>`
- `post.logout.redirect.uris`: `https://<portal>/?logged_out=1`
- Verimi endpoints and client ID
- realm-scoped vault references for both client secrets

No Java extension or custom authenticator is used.

---

## 3. Vault files

The realm template uses Keycloak vault references:

```json
"secret": "${vault.__REALM___portal-spa-secret}"
"clientSecret": "${vault.__REALM___verimi-client-secret}"
```

Create one file per realm on the VPS:

```bash
cd impl-broker-production

printf '%s' '<portal-spa client secret>' > keycloak/vault/vw-beav_portal-spa-secret
printf '%s' '<Verimi client secret>'     > keycloak/vault/vw-beav_verimi-client-secret
chmod 600 keycloak/vault/*
```

The `portal-spa` secret must be the same value stored in Secrets Manager in
`PORTALS_JSON` for that portal host. Keycloak and the BFF both need it.

---

## 4. Start/import Keycloak

```bash
cd impl-broker-production
docker compose up -d --build
```

For an already running Keycloak:

```bash
docker cp keycloak/generated/realm-vw-beav.json keycloak:/opt/keycloak/data/import/realm-vw-beav.json
docker exec keycloak /opt/keycloak/bin/kc.sh import \
  --file /opt/keycloak/data/import/realm-vw-beav.json --override true
```

Verify from Lambda and from a browser-capable host:

```bash
curl -fsS https://kc.gateway-vw.de:8443/realms/vw-beav | head
curl -fsS https://kc.gateway-vw.de:8443/realms/vw-beav/protocol/openid-connect/certs
```

`npm --prefix backend run ops:verify:keycloak` checks issuer and JWKS for all 9
realms from the portal manifest.

---

## 5. Settings that must remain enabled

| Setting | Value | Why |
|---|---|---|
| `sslRequired` | `all` | OIDC and WebAuthn require HTTPS |
| `loginTheme` | `vw` | White-label pages so users do not see a foreign login screen |
| `webAuthnPolicyPasswordlessPasskeysEnabled` | `true` | Enables passkeys |
| `webAuthnPolicyPasswordlessRpId` | `gateway-vw.de` | Must be a registrable parent of `kc.gateway-vw.de` |
| `webAuthnPolicyPasswordlessUserVerificationRequirement` | `required` | Strong user verification |
| `webAuthnPolicyPasswordlessResidentKey` | `required` | Discoverable credentials for usernameless login |
| Required action `webauthn-register-passwordless` | enabled, not default | BFF triggers it via AIA; no forced enrolment |
| IdP `verimi` → `validateSignature` | `true` | Verimi ID tokens must be signature-verified |
| IdP `verimi` → `jwksUrl` | real URL | Needed for signature validation |
| IdP `verimi` → `hideOnLoginPage` | `true` | Users are routed via `kc_idp_hint=verimi` |

> **Keycloak 26.6–26.8 quirk:** a partial Admin REST update of
> `webAuthnPolicyPasswordlessPasskeysEnabled` can silently revert to `false`.
> After import, open Admin Console → Realm Settings → Login, toggle it off/on,
> save, then re-export and confirm it persisted.

> **Freeze the RP ID now.** Changing `gateway-vw.de` later invalidates every
> enrolled passkey.

---

## 6. Account API role for the passkey check

The BFF checks enrolment using the **user's** access token:

```http
GET https://kc.gateway-vw.de:8443/realms/{realm}/account/credentials?type=webauthn-passwordless
Authorization: Bearer <user access token>
```

Required per realm:

1. `account` client → Roles → `view-profile` exists.
2. `default-roles-{realm}` → assigned roles → add `view-profile` from `account`.
3. `portal-spa` → Client scopes → `roles` must be a default client scope.
4. Keep the `account-audience-for-credential-check` mapper from the template.

Without this, the endpoint returns 403 and the passkey banner never disappears
even though the credential exists.

---

## 7. White-label theme

The theme is copied by `keycloak/docker/Dockerfile` and selected by
`loginTheme: "vw"`.

```bash
docker cp keycloak/theme/vw keycloak:/opt/keycloak/themes/vw
docker restart keycloak
```

This is how you satisfy “the user shouldn't notice Keycloak” as far as is
realistically possible. OIDC still requires real browser redirects to the
Keycloak origin; you cannot hide them with an iframe because of cookie,
WebAuthn and anti-framing rules.

---

## 8. Phase C: after Verimi shutdown

1. Set `PHASE=C` in the Lambda environment. This stops `kc_idp_hint=verimi`.
2. Remove the `verimi` identity provider and its mappers from all 9 realms.
3. Delete Verimi client secrets from the vault and Secrets Manager.
4. Keep the passkey identity provider flow only.
5. Verify recovery/support flows for users who never enrolled.
