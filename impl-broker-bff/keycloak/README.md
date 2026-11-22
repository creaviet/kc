# Keycloak 26.8 configuration (no Java, no Verimi changes)

One realm per portal. Repeat these steps for each of the 9 portals, replacing
`vw-beav` / `vw-baev.de` with the portal's values.

## 1. Generate and import the realms

`realm-vw-beav.json` is an example with Verimi placeholders. In production,
generate all 9 realms from `realm-template.json`:

```bash
cd ../backend
PORTALS_FILE="$PWD/ops/portals.json" \
VERIMI_AUTHORIZATION_URL='https://<real>/authorize' \
VERIMI_TOKEN_URL='https://<real>/token' \
VERIMI_USERINFO_URL='https://<real>/userinfo' \
VERIMI_JWKS_URL='https://<real>/jwks' \
VERIMI_ISSUER='https://<real>' \
VERIMI_CLIENT_ID='<real-client-id>' \
npm run ops:generate:realms
```

The generated files land in `keycloak/generated/` and are mounted by
`docker-compose.yml` at `/opt/keycloak/data/import`. On first start:

```bash
cd ..
docker compose up -d --build
```

For an already running Keycloak, import one realm explicitly:

```bash
docker cp generated/realm-vw-beav.json keycloak:/opt/keycloak/data/import/realm-vw-beav.json
docker exec keycloak /opt/keycloak/bin/kc.sh import \
  --file /opt/keycloak/data/import/realm-vw-beav.json --override true
```

Then in the Admin Console (`kc-admin.gateway-vw.de:8444`) verify:

| Setting | Value | Where |
|---|---|---|
| `webAuthnPolicyPasswordlessPasskeysEnabled` | **ON** | Realm Settings → Login → Login screen customization → Enable Passkeys |
| Passkey Mediation | `optional` | next to the toggle |
| WebAuthn Passwordless Policy → RP ID | `gateway-vw.de` | Authentication → Policies |
| User Verification | `required` | Authentication → Policies |
| Discoverable/Resident key | `required` | Authentication → Policies |
| Required action `Webauthn Register Passwordless` | **Enabled**, *not* Default Action | Authentication → Required actions |

> **Why `optional`?** Your portal has an explicit **“Mit Passkey anmelden”**
> button. That starts a normal OIDC login without `kc_idp_hint`. With
> `optional`, Keycloak opens the passkey chooser immediately on page load; the
> themed *Sign in with Passkey* button remains as a fallback. There is **no**
> `kc_action` for passkey login — `kc_action` is only for enrolment/registration.

> **Why not Default Action?** A default required action forces enrolment and
> blocks users who cannot or do not want a passkey. We use AIA instead: ask,
> let them decline, keep the app usable. The BFF re-asks on the next login.

> ⚠️ **Known Keycloak 26.6–26.8 quirk:** a partial Admin REST update of
> `webAuthnPolicyPasswordlessPasskeysEnabled` can silently revert to `false`.
> After import, open the Admin Console, toggle it off/on, Save, and re-export
> the realm to confirm it persisted.

**RP ID rationale:** passkeys are bound to a RP ID. It must be the Keycloak
host's registrable parent. `kc.gateway-vw.de` → `gateway-vw.de` ✅. The portal
domains are never WebAuthn RPs; they only redirect. **Freeze this value now** —
changing it later invalidates every enrolled passkey.

## 2. Configure the Verimi broker

Realm → Identity providers → `verimi`. The generated realm contains the real
Verimi endpoints and this vault reference:

```json
"clientSecret": "${vault.<realm>_verimi-client-secret}"
```

On the VPS, create one file per realm in the mounted vault directory:

```bash
printf '%s' '<Verimi client secret>' > keycloak/vault/vw-beav_verimi-client-secret
printf '%s' '<portal-spa client secret>' > keycloak/vault/vw-beav_portal-spa-secret
chmod 600 keycloak/vault/*
```

Keycloak's file vault is enabled in `keycloak/docker/Dockerfile`
(`kc.sh build --vault=file`). File names are realm-scoped by design:
`<realm>_<secret-name>`.

Also verify:

- Authorization URL, Token URL, UserInfo URL, JWKS URL, issuer
- Client ID / Client secret (the OIDC client registration Verimi gave you)
- `defaultScope = openid profile email`
- `validateSignature = true`

`"hideOnLoginPage": true` means users never see a "Verimi" button. The BFF
reaches Verimi only via `kc_idp_hint=verimi` during Phase B.

If Verimi signs its `id_token`, obtain its JWKS URL and set:

```json
"validateSignature": "true",
"jwksUrl": "https://<verimi-host>/.well-known/jwks.json"
```

Production requires `validateSignature=true` and a real `jwksUrl`. BFF
preflight fails if either is missing. If Verimi cannot provide a JWKS URL, treat
that as a formal risk acceptance, not an implementation detail.

## 3. Grant the Account API role

The BFF verifies enrolment via `GET /realms/{realm}/account/credentials` using
the **user's** access token. That endpoint requires `view-profile` (or
`manage-account`) from the `account` client.

1. Realm → Clients → `account` → Roles → `view-profile` exists.
2. Realm → Roles → `default-roles-vw-beav` → "Assigned roles" → add `view-profile` from `account`.
3. Client `portal-spa` → Client scopes → `roles` must be in "Default client scopes" (already in the export).

The generated client also has an `oidc-audience-mapper` named
`account-audience-for-credential-check`. It adds the `account` audience to the
**access token**, which the Account API requires. Without that mapper and the
`view-profile` role, the Account API returns 403, the BFF logs
`account_api_denied`, and the banner never disappears.

## 4. Deploy the white-label theme

```bash
docker cp theme/vw keycloak:/opt/keycloak/themes/vw
docker restart keycloak
```

Realm Settings → Login → Theme → `vw`. The WebAuthn registration page then
carries your branding instead of Keycloak's.

## 5. Other portals

Do not hand-copy the example. Fill `backend/ops/portals.json`, then run
`npm --prefix backend run ops:generate:realms`. The generator changes:

- `realm`, `displayName`
- `redirectUris`, `webOrigins`, `post.logout.redirect.uris`
- Verimi endpoints/client ID from environment variables
- vault references per realm for both client secrets

Keep `RP ID = gateway-vw.de` identical in all realms.

## 6. Phase C (after 2026-12-31)

1. Set `PHASE=C` in the Lambda environment (stops sending `kc_idp_hint`).
2. Delete the `verimi` identity provider and its mappers in all 9 realms.
3. Delete the Verimi client secret from SSM/Secrets Manager.
4. Verify recovery-code and support flows for users who never enrolled.
