# keycloak-passkey-3 — impl-passkey-prod DCP

> Last Updated: 22.11.2026
> Project: keycloak-passkey-3
> Folder: `impl-passkey-prod/`
> Purpose: separate DCP summary for the production-only passkey migration implementation.
> User confirmation: DCP content confirmed correct on 22.11.2026.

---

## Current state

### Architecture

- `impl-passkey-prod/architecture_11-22-2026.md` is the active architecture document.
- Root copy: `architecture_11-22-2026.md`.
- Contains evaluation, DDD domains, robustness, scalability, security/threat model,
  C4 ASCII diagrams and open tasks.
- Decision confirmed by user: **one Keycloak realm per portal**.
  - Consequence: passkeys are portal-local; no cross-portal SSO.
  - Chosen for strict tenant isolation.
  - Changing to shared realm later requires one realm with 9 confidential clients
    and a `realm` mapping change.

### Implementation folders

- `frontend/` — React 18 + TypeScript + Vite SPA.
- `backend/` — AWS Lambda Node.js 24 BFF, API Gateway HTTP API, DynamoDB,
  Secrets Manager, `openid-client`, `jose`, no hand-rolled crypto.
- `vps/` — Docker Compose with nginx `:8443`/`:8444`, Keycloak 26.8.2, PostgreSQL,
  file vault, German `vw` white-label theme, real Admin REST provisioning script.
- `production-inputs/` — new: real-value templates + local validator, no mocks.

### Flow coverage (steps 1–11)

| Step | Status | Notes |
|---|---|---|
| 1–3 User starts login via SPA and BFF | Implemented | `GET /api/auth/login?method=verimi` |
| 4–6 Keycloak brokers to Verimi | Implemented | `kc_idp_hint=verimi` only for Verimi/auto bootstrap |
| 7 Callback and portal session | Implemented | PKCE/state/nonce/JWKS via `openid-client`; encrypted `__Host-` session cookie |
| 8 Show passkey banner | Implemented | `GET /api/me`, authoritative credential check via Account API |
| 9–10 Passkey enrolment | Implemented | AIA `webauthn-register-passwordless:skip_if_exists`; expected `realm:sub` binding |
| 11 Later passkey login | Implemented | `method=passkey`; no `kc_idp_hint`; Verimi is never contacted |

---

## Latest changes (2026-11-22)

### Added `impl-passkey-prod/production-inputs/`

Purpose: let the user fill real production values locally without pasting secrets into chat.

Files added:

- `README.md`
  - Fill/copy checklist.
  - Secret generation commands.
  - Validation command.
  - Mapping from filled templates to deployment paths.
  - Note: send only broker redirect URIs to Verimi.
- `portals.template.json`
  - 9 portal entries with placeholder hosts, API hosts, realms and secret keys.
- `domains.template.json`
  - 9 ACM certificate ARN / Route53 zone entries.
- `verimi.template.json`
  - Real Verimi OIDC metadata fields and client secret placeholder.
- `verimi-redirect-uris.txt.template`
  - 9 broker redirect URIs for Verimi registration.
- `vps.env.template`
  - DB/admin credentials and trusted proxy CIDR placeholders.
- `admin-allow.template.conf`
  - Fail-closed admin allowlist template.
- `aws-deploy.template.env`
  - Region, table suffix, Secrets Manager ARN, cookie key JSON, Keycloak URL.
- `frontend.env.template`
  - Per-portal frontend build variables.
- `.gitignore`
  - Ignores all filled files; templates remain tracked.
- `validate-inputs.js`
  - Local, no-network, fail-closed schema validation.
  - Checks 9 portals, uniqueness, HTTPS URLs, host/redirect consistency,
    Verimi metadata, cookie key length, admin allowlist, Route53/ACM ARNs,
    frontend allowlist and exact 9 broker redirect URIs.
  - Never prints secret values.

### Updated docs

- `impl-passkey-prod/README.md`
  - Added `production-inputs/` to file map.
  - Section 6 now points to the templates and local validator.
- `architecture_11-22-2026.md` and impl copy
  - Added confirmed realm decision and consequence.

---

## Verification performed

- `node --check production-inputs/validate-inputs.js` → pass.
- Validator against placeholder-filled temp copy → exit code 1, placeholders detected.
- Validator against synthetic structurally valid temp inputs → `OK`, no secrets printed.
- `cd impl-passkey-prod/backend && npm test` → 8/8 pass.
- `cd impl-passkey-prod/frontend && npm run build` → pass.
- `git status` → new work still uncommitted.

No real external endpoint was contacted during validation. No mocks/emulators were added to shipped code.

---

## Blocked / open

- User must fill the templates with real values:
  - 9 portal hosts, API hosts, realm names.
  - Verimi metadata, client ID, client secret.
  - Verimi registration of 9 broker redirect URIs.
  - Real TLS certs for `kc.gateway-vw.de:8443` and `kc-admin.gateway-vw.de:8444`.
  - Admin IP allowlist.
  - AWS account/region-dependent ARNs, cookie key, Secrets Manager ARN.
- After filling:
  1. `node production-inputs/validate-inputs.js`
  2. Copy filled files to deployment paths as documented.
  3. Run VPS realm provisioning against real Keycloak Admin API.
  4. Deploy SAM + API custom domains.
  5. Build/deploy frontend per portal.
  6. Run real preflight and verification scripts.

---

## How to resume

```bash
cd impl-passkey-prod

cp production-inputs/portals.template.json production-inputs/portals.json
cp production-inputs/domains.template.json production-inputs/domains.json
cp production-inputs/verimi.template.json production-inputs/verimi.json
cp production-inputs/vps.env.template production-inputs/vps.env
cp production-inputs/admin-allow.template.conf production-inputs/admin-allow.conf
cp production-inputs/aws-deploy.template.env production-inputs/aws-deploy.env
cp production-inputs/frontend.env.template production-inputs/frontend.env
cp production-inputs/verimi-redirect-uris.txt.template production-inputs/verimi-redirect-uris.txt

# fill locally, then:
node production-inputs/validate-inputs.js
```

Full runbook: `impl-passkey-prod/README.md`.
