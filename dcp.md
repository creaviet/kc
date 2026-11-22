# Keycloak Passkey Broker — Dynamic Context Pruning (DCP)

> Last Updated: 20.11.2026
> Project: keycloak-passkey-3
> Status: production-shaped BFF + SPA + Keycloak deployment config implemented;
> real deployment blocked only on user-supplied values.

---

## Current State

### Architecture Document
- **File**: `architecture_11-20-2026.md`
- **Status**: Active; includes final production-hardening addendum.
- Contains: evaluation, DDD domains, robustness/scalability/security, C4 ASCII
  diagrams, threat model, explicit passkey-login addendum, separate-port
  emulator addendum, Verimi upstream-parameter notes, production hardening.

### Main Implementation
- **Folder**: `impl-broker-bff/`
- No Java, no Keycloak extension, no Verimi code changes, no Admin API in user journey.
- Frontend: React 18 + TypeScript + Vite, CSP, production-origin build guard.
- Backend: AWS Lambda Node 24 ESM BFF with local server.
- OIDC protocol: `openid-client` 6.9.1 (discovery, authorize, code grant, state/nonce/PKCE, ID token claims + JWS).
- Crypto: `jose` (encrypted cookies only), Node `crypto` CSPRNG/timing-safe compare, `cookie`, `zod` 4.6.7.
- Secrets: Secrets Manager dynamic references; no plaintext in template/git.
- Deployment: `PRODUCTION.md` + generators + preflight + verifier.

### Implemented Flows
| Flow | Status | Notes |
|---|---|---|
| Verimi login | ✅ | `GET /api/auth/login?method=verimi` → `kc_idp_hint=verimi` |
| Explicit passkey login | ✅ | `GET /api/auth/login?method=passkey` → no `kc_idp_hint` |
| Passkey enrolment | ✅ | AIA `kc_action=webauthn-register-passwordless:skip_if_exists` |
| Phase B/C switch | ✅ | `/api/me` exposes `phase`; C rejects `method=verimi` |
| BFF session | ✅ | JWE cookie + revocable DynamoDB record; logout revokes |
| Callback security | ✅ | state, PKCE, nonce, issuer/audience/azp, JWKS, sub rebind |
| Enrolment truth | ✅ | Account API with user token; `kc_action_status` ignored |
| Admin plane policy | ✅ | real nginx `include admin-allow.conf; deny all;` |
| 9-portal generation | ✅ | realm generator + API domain generator, fail-closed |
| Deployment checks | ✅ | preflight + Keycloak read-only verifier |

---

## Production-hardening pass (latest work)

### Runtime/code
- `backend/src/config.js` requires exactly 9 portals in AWS, unique realms,
  HTTPS redirect URIs, 32-byte keys, and rejects dev flags in AWS.
- `backend/src/http.js` uses `requestContext.domainName` as authoritative host
  in AWS; adds security headers and request IDs.
- `backend/src/router.js` normalizes `/api/...` and `/...` paths.
- `backend/src/oidc.js` uses `openid-client` with `enableNonRepudiationChecks`.
  `KC_PUBLIC_URL` drives discovery, browser URLs and issuer; `KC_BASE_URL` is only
  for server-side Account API calls. `ALLOW_INSECURE_OIDC` is local-only.
- `backend/src/store.js` has two DynamoDB tables: user cache + revocable sessions.
  `verimiSub` is never overwritten with null by passkey-only logins.
- `backend/src/session.js` reads/rotates three independent JWE key classes.
- `backend/src/handlers/callback.js` rebinds `claims.sub === tx.sub` for enrolment.
- `backend/src/handlers/logout.js` revokes the session before Keycloak logout.

### AWS
- `backend/template.yaml`: `nodejs24.x`, KMS-encrypted DynamoDB with PITR and
  TTL, HttpApi with disabled execute endpoint, throttling, access logs,
  optional WAF association, least-privilege IAM, X-Ray.
- All secrets are Secrets Manager dynamic references. Previous-key secrets
  enable zero-downtime rotation.

### Keycloak / IONOS
- `keycloak/realm-template.json`: vault refs, `validateSignature=true`,
  `jwksUrl`, `issuer`, account audience mapper, passkey policy.
- `keycloak/docker/Dockerfile`: builds file-vault provider.
- `docker-compose.yml`: production `start`, no default passwords, hostname v2,
  trusted proxy CIDR required, generated realm import, vault mount.
- nginx: default servers return 444, HSTS `includeSubDomains`, rate limits,
  canonical proxy headers, admin allow include + `deny all`, public `/admin` blocked.

### Frontend
- `vite.config.ts` refuses production build with non-production Keycloak origin.
- `index.html` has CSP.
- Stale localhost build artifact removed; `frontend/dist` gitignored.

### Ops tooling
- `backend/ops/portals.js` validates the 9-portal manifest.
- `backend/ops/generate-realms.js` generates all realm exports.
- `backend/ops/generate-api-domains.js` generates CloudFormation commands for
  per-portal `/api` custom-domain mappings and Verimi redirect URIs.
- `backend/ops/create-secrets.example.sh` creates/updates all Secrets Manager values.
- `backend/ops/preflight.js` fails closed on placeholders/insecure config.
- `backend/ops/verify-keycloak.sh` checks discovery, issuer, JWKS, admin exposure.

---

## Verification performed
- Backend: `npm test` → **21/21 pass** (includes wrong-key and nonce-mismatch
  rejection through `openid-client`).
- `npm audit --audit-level=high` → 0 vulnerabilities (`zod` pinned to 4.6.7).
- Frontend: `npm run build:production` → pass.
- YAML syntax for both CloudFormation templates → pass.
- Generator smoke test with 9 test portals → pass; realm JSON parses.
- Preflight with placeholders → fails on portal placeholders as designed.
- Preflight with synthetic 9 non-placeholder portals → 20/20 checks pass.
- Emulator full flow → pass:
  - Verimi login → `passkeyEnrolled:false`
  - enrolment → `passkeyEnrolled:true`
  - explicit passkey login → `kc_idp_hint` absent
  - logout → unauthenticated
- Admin mock: external IP → 403; loopback allowlisted → 200.
- `sam validate` skipped: `sam` CLI not installed.

---

## Key Decisions
| Decision | Choice | Why |
|---|---|---|
| Broker pattern | Keycloak as IdP broker | Verimi stays untouched; passkeys are native Keycloak WebAuthn |
| Token exposure | BFF-only, httpOnly encrypted cookies | No tokens in browser JS, reduces XSS impact |
| Session revocation | DynamoDB session record | Logout and incident response must really invalidate cookies |
| Passkey login | Normal OIDC, no `kc_action` | `kc_action` is enrolment-only; WebAuthn login is Keycloak's form |
| Passkey mediation | `optional` | Chooser opens after portal passkey button; themed button remains fallback |
| Phase B | Verimi bootstrap once, then passkey | Cannot register credential before authentication |
| Phase C | Remove Verimi IdP/hint | Verimi shuts down end of 2026 |
| RP ID | `gateway-vw.de` | Registrable parent of the Keycloak host; freeze forever |
| Admin console | `deny all` + trusted IPs only | Admin plane must never be public |
| Secrets | Secrets Manager dynamic refs | No plaintext secrets in templates/git; rotation via AWSCURRENT |
| Local emulator | separate Node processes | Real origin boundaries without Docker/Java |
| OIDC library | `openid-client`, not hand-built OIDC | Maintained server-side RP library; `jose` stays cookie-only |

---

## Blocked / Open
- Real IONOS VPS not accessible from this workspace.
  `kc.gateway-vw.de:8443` previously returned nginx static 404 for
  `/realms/vw-beav`; production nginx must be verified after deployment.
- Real Verimi host/endpoints and client IDs/secrets are still placeholders.
- Real TLS cert, ACM ARN, KMS ARN, optional WAF ARN, and admin IP allowlist
  are user-supplied inputs.
- Seven of nine portal domains/realms are still unknown; `portals.json` contains
  placeholders and preflight therefore fails until replaced.
- Real WebAuthn ceremony and Postgres wire protocol cannot be validated locally.
- Enrolment coverage dashboard and real Keycloak event forwarding remain open.
- Direct-Verimi fallback was considered and deliberately not implemented.

---

## How to resume

```bash
# Local emulator
cd impl-broker-bff/mock-vps && npm run start:emulated
cd ../backend && npm run start:emulated
cd ../frontend && npm run dev:emulated
open http://localhost:5173
curl http://localhost:8443/mock/reset

# Production preparation
cd impl-broker-bff
$EDITOR backend/ops/portals.json
$EDITOR backend/ops/portal-secrets.json
node ops/generate-keys.js
bash backend/ops/create-secrets.example.sh
npm --prefix backend run ops:preflight
npm --prefix backend run ops:generate:realms
npm --prefix backend run ops:generate:domains
```

Full runbook: `impl-broker-bff/PRODUCTION.md`.

---

## 2026-11-21 — Production-only implementation added

Created new project folder:

```text
impl-broker-production/
```

Purpose: production-only Keycloak IdP broker + passkey bootstrap for 9 portals,
with React frontend, AWS Lambda Node.js 24 BFF, Keycloak 26.8 on IONOS VPS,
PostgreSQL, nginx and DynamoDB.

Major files written/updated:

- `impl-broker-production/README.md`
  - Evaluation: task is reasonable.
  - Explicit limitation: Keycloak redirects cannot be hidden at protocol level;
    white-label theme hides branding only.
  - Full click-to-callback flow for steps 1–11.
  - Frontend/backend code walkthrough and deployment checklist.
- `impl-broker-production/architecture_11-21-2026.md`
  - DDD domains, robustness, scalability, security, C4 context/container/component/
    dynamic diagrams, attack vectors and improvements.
- `impl-broker-production/backend/src/config.js`
  - Rewritten production-only fail-closed config.
  - Forbids `INSECURE_COOKIES`, `ALLOW_INSECURE_OIDC`, `DEV_PORTAL_HOST`,
    memory store, non-HTTPS Keycloak URLs, localhost Keycloak URLs and portal
    counts other than 9.
  - Strict HTTPS portal `redirectUri` validation.
- `impl-broker-production/backend/src/cookies.js`
  - Fixed `__Host-`, `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, no Domain.
- `impl-broker-production/backend/src/http.js`
  - Portal resolved only from API Gateway `requestContext.domainName`.
  - Callback URL reconstructed with `/api` base path so `openid-client` sends
    the exact registered `redirect_uri` in the token request.
- `impl-broker-production/backend/src/oidc.js`
  - Removed insecure OIDC escape hatch.
  - Keeps `openid-client` for discovery, PKCE, token exchange, nonce/state and
    JWKS validation.
- `impl-broker-production/backend/src/store.js`
  - DynamoDB only; no in-memory fallback.
- `impl-broker-production/backend/src/handlers/login.js`
  - Portal cache failures degrade safely instead of blocking Keycloak login.
- `impl-broker-production/backend/src/handlers/me.js`
  - Cache failure shows enrolment banner rather than hiding it.
- `impl-broker-production/backend/package.json`
  - Removed all local/mock/emulated start scripts.
- `impl-broker-production/backend/tests/production.test.js`
  - New deterministic production tests; no network, no mock services.
  - Old `flow.test.js` removed.
- `impl-broker-production/frontend/vite.config.ts`
  - No dev `/api` proxy; hard-pinned production Keycloak origin.
- `impl-broker-production/frontend/src/config.ts`
  - No env/localhost comments; compile-time production origin allowlist.
- `impl-broker-production/frontend/package.json`
  - Removed `dev` and `dev:emulated` scripts.
- `impl-broker-production/keycloak/README.md`
  - Production realm import, vault, WebAuthn policy, Account API role, theme,
    Phase C runbook; no mock/emulator references.
- `impl-broker-production/nginx/README.md`
  - Production-only nginx/TLS/admin allowlist runbook.
- `impl-broker-production/backend/ops/preflight.js`
  - Added checks for production-only code, no local server, no dev proxy,
    hardcoded production Keycloak origin, no stale local/dist URLs.
- Added gitignored runtime folders:
  - `keycloak/generated/`, `keycloak/vault/`, `certs/`, `backend/ops/generated/`.
- Removed `backend/ops/portals.json` default so placeholder manifests cannot be
  deployed accidentally. `portals.example.json` and `portal-secrets.example.json`
  remain as templates.

Validation performed:

- `npm --prefix impl-broker-production/backend test` → 15/15 passing.
- `npm --prefix impl-broker-production/frontend run build` → TypeScript + Vite
  production build passed.
- Deployment preflight with valid temporary 9-portal manifest and random keys →
  32/32 checks passed.
- Grep audit found no mock/emulator/local runtime strings in shipped source;
  remaining matches are intentional fail-closed validation checks/comments.

Current open items:

- Real Verimi endpoint/client values still required.
- Seven real portal domains/realms still required.
- Real KMS ARN, ACM certificate ARNs, WAF ARN, admin IP allowlist and TLS certs
  are user-supplied deployment inputs.
- IONOS VPS still a single point of failure; HA/recovery plan documented as improvement.
