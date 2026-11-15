# Architecture: Verimi → Keycloak/Passkey Migration (refined)

**Project:** keycloak-passkey
**Date:** 2026-11-15
**Scope:** Answers to (a) workflow feasibility, (b) impersonation, (c) alternatives, plus the recommended production design. Supersedes `architecture_11-14-2026.md` only in emphasis; that document remains the full reference.

---

## 0. Verdicts (TL;DR)

| Q | Verdict |
|---|---------|
| **a) Workflow possible & production-ready?** | **Yes — but redesign step 3.** Do NOT have Lambda create the Keycloak user. Use Identity Brokering + Application Initiated Actions (AIA). |
| **b) Impersonation recommended & secure?** | **No.** It mints a full session from an admin privilege → mass account-takeover primitive. Use only for audited support flows. |
| **c) Best alternative?** | **Identity Brokering + AIA** (`kc_idp_hint=verimi&kc_action=webauthn-register-passwordless:skip_if_exists`). One browser redirect, no admin creds, no Java, no Verimi code changes. |

---

## 1. Why step 3 ("Lambda creates user") is the wrong cut

- It puts **Keycloak Admin API credentials** into Lambda → blast radius = entire realm on Lambda compromise.
- It duplicates provisioning that Keycloak's broker already does automatically on first federated login.
- It forces you to *then* get that user into a browser session → drags in impersonation (b).
- It is not standards-based and adds a hand-rolled identity-linking path that can drift.

**Principle:** identity linking (`portal_account_id ↔ keycloak_sub`) is a *portal* concern (store in DynamoDB/RDS). Credential creation is a *Keycloak* concern. Don't cross the boundary.

---

## 2. The chicken-and-egg problem (why impersonation tempts you)

- Registering a passkey requires a **Keycloak SSO session** in the browser (WebAuthn RP = Keycloak origin).
- The user only has a **Verimi** session.
- Impersonation is the shortcut: mint a Keycloak session for that user from Lambda.
- The clean shortcut is **brokering**: register Verimi as an IdP *inside* Keycloak. Then `kc_idp_hint=verimi` delegates to Verimi; because the user already has a live Verimi SSO session this is usually **silent**, Keycloak auto-provisions/links the user, and runs the passkey action.

**Impersonation risks (why "No"):** over-privileged service account; passkey-registration hijack (attacker registers *their* passkey on a victim account, locking the victim out — worse under a one-passkey policy); full-session token, not a scoped capability; token-in-URL leakage; violates least privilege.

---

## 3. Recommended design: Brokering + AIA

**Flow (who calls whom, with what):**

1. User logged into portal via Verimi (existing path, untouched).
2. Portal SPA shows popup: "Create a passkey to keep access after 2026-12-31."
3. User clicks button. SPA builds Keycloak authorize URL (PKCE) with:
   - `kc_idp_hint=verimi`
   - `kc_action=webauthn-register-passwordless:skip_if_exists`
   - `redirect_uri=https://portal.example.com/auth/callback`
4. Browser → Keycloak (`kc.gateway-vw.de:8443`). Keycloak sees no session → redirects to Verimi (silent SSO) → Verimi vouches → Keycloak creates/links local user → runs passkey registration (QR/USB) in browser.
5. Keycloak redirects back with `kc_action_status=success|cancelled`.
6. SPA reads status, updates UI; Lambda validates Keycloak JWT (JWKS) and stores `portal_account_id ↔ keycloak_sub`.

**After Verimi shutdown (2026-12-31):** disable/remove the Verimi IdP in Keycloak. Passkey login remains. Portal code changes: none (only `kc_idp_hint` removal in the button path).

**Prerequisite to verify immediately:** Verimi must allow registering one more OIDC/SAML client (redirect URI = Keycloak). Verimi has stopped implementing — this is the single biggest external risk. If blocked, fall back to **Option 4** (Admin API + `execute-actions-email`): Lambda creates user, sends email link, user completes registration in browser. No impersonation.

---

## 4. Security rules

- Keycloak domain is final before enrolling anyone (RP ID is origin-bound; changing it invalidates all passkeys).
- Lambda holds **no** Keycloak admin credentials in the enrolment path.
- Enforce "one passkey" at the **Keycloak policy** level (AIA `:skip_if_exists`), not in portal logic.
- Rate-limit and audit the passkey button path (anti-enumeration / anti-hijack).
- Keep admin console on `kc-admin.gateway-vw.de:8444`, separate from public `kc.gateway-vw.de:8443`.

---

## 5. C4 (condensed)

```
User (browser) ──HTTPS──► Portal SPA (React, AWS)
   │                          │ builds authorize URL (PKCE)
   │                          ▼
   │                    Keycloak (IONOS VPS, Docker, nginx TLS)
   │                          │ kc_idp_hint=verimi
   │                          ▼
   │                    Verimi IdP (retired 2026-12)
   │                          │ silent SSO
   │                          ▼
   │                    Keycloak runs WebAuthn registration (RP)
   │                          │
   │                          ▼
   │                    Passkey authenticator (device/USB/QR)
   │
   └── REST ──► Lambda (Node.js) ── validates Keycloak JWT (JWKS)
                   │
                   └── stores portal_account_id ↔ keycloak_sub (DB)
```

---

## 6. Open tasks / improvements

- Verify Verimi allows new OIDC/SAML client registration (blocker check).
- Decide RP domain now and never change it.
- Add recovery path (recovery codes + admin reset) before one-passkey policy.
- Load-test broker redirect + silent SSO under peak.
- Plan IdP removal runbook for 2026-12-31.
- Add observability: AIA status metrics, passkey enrolment funnel, broker error rates.
