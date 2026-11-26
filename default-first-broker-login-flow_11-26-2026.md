# Default First Broker Login Flow with Verimi

**Date:** 2026-11-26  
**Project:** keycloak-passkey-3  
**Scope:** How to use Keycloak's built-in `first broker login` flow for Verimi brokering, automatic Keycloak user creation, and later passkey registration.

---

## 1. Core answer

Keycloak already ships with a built-in top-level authentication flow named:

```text
first broker login
```

You use it by assigning it to the Verimi identity provider. You usually do **not** need to create a custom flow.

By default, after a user authenticates successfully at Verimi and redirects back to Keycloak:

```text
If no matching Keycloak user exists:
  → Keycloak creates a local Keycloak user automatically.
  → Keycloak links that user to the Verimi identity.

If a matching Keycloak user exists:
  → Keycloak does NOT silently link by default.
  → Keycloak asks the user to confirm linking, verify by email, or re-authenticate.
```

This is done by Keycloak itself, not by React and not by AWS Lambda.

---

## 2. Flow precedence

Modern Keycloak versions have two levels:

```text
1. Realm-level default first broker login flow
2. Identity-provider-level override: firstBrokerLoginFlowAlias
```

Precedence:

```text
IdP override > realm default > built-in "first broker login"
```

Therefore:

| Option | When to use |
|---|---|
| Leave `First Login Flow` unset | If your realm default is the built-in flow |
| Explicitly set `first broker login` | Safer and clearer for production |

Recommendation: explicitly set it on the Verimi IdP.

---

## 3. Admin Console steps

Open the admin console:

```text
https://kc-admin.gateway-vw.de:8444/admin/
```

Then go to:

```text
Select your application realm        ← not "master"
→ Identity providers
→ verimi
→ First Login Flow / First Login Flow Override
→ choose: first broker login
→ Save
```

Conceptual configuration:

```text
Alias: verimi
Provider: OpenID Connect v1.0
Enabled: ON
First Login Flow: first broker login
Trust Email: ON    ← recommended only if Verimi emails are verified
Sync Mode: Import / Force
```

Important: do this in your application realm, not in `master`.

---

## 4. What the built-in flow contains

Go to:

```text
Authentication
→ Flows
→ first broker login
```

Expected structure:

```text
first broker login
 ├── Review Profile
 ├── Create User If Unique
 └── Handle Existing Account
      ├── Confirm Link Existing Account
      ├── Verify Existing Account by Email
      └── Verify Existing Account by Re-authentication
```

Meaning:

```text
Review Profile
  → optionally asks the user to confirm profile data

Create User If Unique
  → if no matching Keycloak user exists:
       create local Keycloak user
       link it to Verimi identity
       finish login

Handle Existing Account
  → if a Keycloak user with same email/username exists:
       ask user to confirm linking
       or verify by email
       or re-authenticate
```

---

## 5. Recommended production settings for the migration

Because Verimi is a controlled external IdP and users already exist there, use:

```text
Identity Provider: verimi
  First Login Flow: first broker login
  Trust Email: ON
  Hide on Login Page: optional
  Sync Mode: Import or Force
```

In the flow:

```text
Review Profile:
  Update Profile On First Login = MISSING or OFF

Create User If Unique:
  Requirement = ALTERNATIVE

Handle Existing Account:
  Requirement = ALTERNATIVE
```

Rationale:

```text
Trust Email = ON
  → If Verimi guarantees verified email, Keycloak marks the email as verified.

Review Profile = MISSING
  → User sees a profile page only if required data is missing.

Create User If Unique = ALTERNATIVE
  → New users are created automatically.

Handle Existing Account = ALTERNATIVE
  → Existing accounts are not silently linked.
```

Do **not** enable AutoLink unless you are intentionally doing a controlled migration with pre-provisioned users.

---

## 6. What the user sees on first login

### Case A: no existing Keycloak user

```text
User logs in at Verimi
        ↓
Verimi redirects to Keycloak
        ↓
first broker login runs
        ↓
Create User If Unique creates Keycloak user
        ↓
Keycloak links Verimi sub to Keycloak user
        ↓
Keycloak redirects to portal
```

Usually the user may see a short Keycloak-branded page if `Review Profile` is active. If you set `Review Profile = OFF`, this can be skipped, but only if Verimi reliably sends all required profile data.

### Case B: a Keycloak user with the same email already exists

```text
User logs in at Verimi
        ↓
Keycloak finds an existing local account
        ↓
Keycloak does NOT auto-link by default
        ↓
User sees:
   "An account with this email already exists.
    Do you want to link it?"
```

This is intentional. It prevents account takeover through untrusted email claims.

---

## 7. Portal login URL should force Verimi

To avoid showing Keycloak's IdP selection page, the portal should redirect to Keycloak with `kc_idp_hint=verimi`:

```http
GET https://kc.gateway-vw.de:8443/realms/<realm>/protocol/openid-connect/auth
    ?client_id=<portal-client>
    &response_type=code
    &scope=openid profile email
    &redirect_uri=https://www.vw-baev.de/auth/callback
    &state=<random-state>
    &nonce=<random-nonce>
    &code_challenge=<pkce-challenge>
    &code_challenge_method=S256
    &kc_idp_hint=verimi
```

This tells Keycloak:

```text
Do not show "Choose IdP".
Go directly to Verimi.
```

The user still technically leaves the portal domain, but Keycloak can be branded to visually look like the portal.

---

## 8. Repeatable setup with kcadm.sh

Log in:

```bash
export KC_SERVER="https://kc-admin.gateway-vw.de:8444"
export KC_REALM="<your-realm>"
export KC_ADMIN_USER="<admin-user>"
export KC_ADMIN_PASSWORD="<admin-password>"

kcadm.sh config credentials \
  --server "$KC_SERVER" \
  --realm master \
  --user "$KC_ADMIN_USER" \
  --password "$KC_ADMIN_PASSWORD"
```

Check the current IdP:

```bash
kcadm.sh get identity-provider/instances/verimi \
  -r "$KC_REALM"
```

Set the default first broker login flow explicitly:

```bash
kcadm.sh update identity-provider/instances/verimi \
  -r "$KC_REALM" \
  -s "firstBrokerLoginFlowAlias=first broker login" \
  -s "trustEmail=true"
```

Verify:

```bash
kcadm.sh get identity-provider/instances/verimi \
  -r "$KC_REALM" \
  --fields alias,enabled,trustEmail,firstBrokerLoginFlowAlias
```

Expected:

```json
{
  "alias": "verimi",
  "enabled": true,
  "trustEmail": true,
  "firstBrokerLoginFlowAlias": "first broker login"
}
```

---

## 9. Add a mapper for the original Verimi `sub`

This is important for the portal migration.

The Keycloak token should contain the original Verimi subject, for example as `verimi_sub`.

Create an identity-provider mapper:

```bash
kcadm.sh create identity-provider/instances/verimi/mappers \
  -r "$KC_REALM" \
  -s name="verimi-sub-importer" \
  -s identityProviderMapper="oidc-user-attribute-idp-mapper" \
  -s "config.claim=sub" \
  -s "config.user.attribute=verimi_sub" \
  -s "config.syncMode=FORCE"
```

Then add a normal user-attribute protocol mapper to the portal client or client scope so `verimi_sub` appears in the access token/id token.

Conceptually, the Keycloak token should later contain:

```json
{
  "iss": "https://kc.gateway-vw.de:8443/realms/<realm>",
  "sub": "<keycloak-user-id>",
  "email": "user@example.de",
  "verimi_sub": "<original-verimi-sub>"
}
```

The Lambda can then map:

```text
verimi_sub → existing portal account
keycloak_sub → store for future logins
```

---

## 10. Make sure Keycloak uses the correct public URL

Because public and admin hostnames are separate, set these in the Keycloak container environment:

```yaml
environment:
  KC_HOSTNAME_URL: "https://kc.gateway-vw.de:8443"
  KC_HOSTNAME_ADMIN_URL: "https://kc-admin.gateway-vw.de:8444"
```

Otherwise Keycloak may generate redirect URLs with the wrong hostname and Verimi will reject the callback.

The Verimi callback URL must be:

```text
https://kc.gateway-vw.de:8443/realms/<realm>/broker/verimi/endpoint
```

---

## 11. Enable passkeys after the broker flow works

After the default first broker login flow works, enable passkeys:

```text
Authentication
→ Policies
→ WebAuthn Passwordless Policy
→ Enable Passkeys: ON
```

Also enable the required action:

```text
Authentication
→ Required Actions
→ WebAuthn Register Passwordless
→ Enabled: ON
```

Do **not** necessarily set it as `Default Action`, because the desired UX is:

```text
User logs in with Verimi
→ sees portal
→ clicks "Create passkey"
→ Keycloak asks to register passkey
→ back to portal
```

If `WebAuthn Register Passwordless` is set as a default action, users are forced to create a passkey immediately after first login. That may be useful later, but it changes the described flow.

---

## 12. Test procedure

Use a fresh test user who does not yet exist in Keycloak.

```text
1. Open portal
2. Click Login
3. Redirect goes to Keycloak with kc_idp_hint=verimi
4. Authenticate at Verimi
5. Redirect back to Keycloak
6. Keycloak runs first broker login
7. Check Admin Console:

   Users
   → find test user
   → Identity Providers tab
   → should show verimi
```

Check the user attributes:

```text
Users → test user → Attributes
→ verimi_sub = <Verimi sub>
```

Then:

```text
Portal → Create passkey
→ Keycloak WebAuthn registration
→ back to portal
→ logout
→ login again with passkey
```

---

## 13. Summary

To use the default first broker login flow:

```text
Admin Console
→ your realm
→ Identity providers
→ verimi
→ First Login Flow
→ first broker login
→ Save
```

Or via `kcadm.sh`:

```bash
kcadm.sh update identity-provider/instances/verimi \
  -r "$KC_REALM" \
  -s "firstBrokerLoginFlowAlias=first broker login"
```

That gives you:

```text
✅ automatic Keycloak user creation for new Verimi users
✅ secure handling of duplicate emails
✅ federated identity link between Verimi and Keycloak
✅ a persistent Keycloak user that can store a passkey
```

---

## 14. Important constraints

```text
Transient users / "Do Not Store Users" = ❌ not suitable for passkeys
Persistent local Keycloak users      = ✅ required
```

Reason:

```text
WebAuthn/passkey credentials are stored against a persistent Keycloak user.
Transient users exist only inside a session and cannot have additional authentication factors.
```

Also:

```text
The OIDC redirect flow cannot be made literally invisible.
It can only be branded to look like the portal.
Embedding Keycloak in an iframe is not recommended and is usually broken by browser security policies.
```

---

## 15. References

- Keycloak Server Administration Guide — First login flow:  
  https://www.keycloak.org/docs/latest/server_admin/index.html

- Keycloak source documentation — first-login-flow.adoc:  
  https://github.com/keycloak/keycloak/blob/main/docs/documentation/server_admin/topics/identity-broker/first-login-flow.adoc
