# Implementation Demo: Verimi → Keycloak/Passkey via Brokering + AIA

## Setup checklist (do once)
1. **Verify Verimi allows a new OIDC client** (blocker). Request redirect URI `https://kc.gateway-vw.de:8443/realms/vw-beav/broker/verimi/endpoint`, scopes `openid profile email`, confidential client.
2. Place TLS certs in `impl/certs/` (server.crt, server.key) for `kc.gateway-vw.de`.
3. `cp .env.example .env` and fill real secrets (Verimi client id/secret, DB + KC admin passwords). Store production secrets in AWS Secrets Manager.
4. `docker compose up -d` — Keycloak auto-imports `keycloak/realm-export.json`.
5. Open admin console `https://kc-admin.gateway-vw.de:8444`, confirm realm `vw-beav` and IdP `verimi` exist; paste real Verimi endpoints if not already in export.
6. Serve `portal/` on http://localhost:3000.
7. Test: portal → "Create a passkey" → popup → redirect → silent Verimi SSO → passkey ceremony → return with `kc_action_status`.
8. Deploy `lambda/handler.js` (Node.js) behind API Gateway; point portal callback at it.
9. Run recovery + one-passkey policy review before go-live.

## Run
```bash
cd impl
cp .env.example .env   # fill secrets
docker compose up -d
```
- Public Keycloak: https://kc.gateway-vw.de:8443
- Admin console: https://kc-admin.gateway-vw.de:8444
- Portal SPA: serve `portal/` on http://localhost:3000

## Test flow
1. Open portal, click "Create a passkey" → popup.
2. Click "Create passkey" → browser redirects to Keycloak with `kc_idp_hint=verimi&kc_action=webauthn-register-passwordless:skip_if_exists`.
3. Keycloak brokers to Verimi (silent SSO if already logged in), auto-provisions user, runs passkey registration.
4. Browser returns to portal with `kc_action_status=success|cancelled`.
5. Portal posts `code` + `portal_account_id` to Lambda, which validates the JWT and stores the mapping.

## Timeline (realistic)

| Window | Milestone | Owner |
|--------|-----------|-------|
| Day 0 (this week) | Request Verimi OIDC client + TLS certs; confirm Namerial coordination | You |
| Day 1 | Keycloak + Postgres + nginx up; realm `vw-beav` imported; IdP `verimi` wired; silent SSO verified | You |
| Day 2 | SPA popup + AIA redirect; Lambda JWT validation + account↔sub mapping; real-device passkey test | You |
| Day 3 | Hardening, rate limits, monitoring, recovery procedure; pilot on one portal (vw-baev.de) | You |
| Week 2 | Roll out to remaining 8 portals; load + browser/authenticator matrix testing | You |
| Week 3–4 | Full production readiness; disable Verimi IdP post-shutdown (2026-12-31) | You |

**3-day outcome:** working demo + single-portal pilot. Full 9-portal production readiness: 2–4 weeks.

## Security notes
- No Java. No impersonation. No Keycloak admin credentials in Lambda.
- Keycloak domain (`kc.gateway-vw.de`) is the RP ID — finalise before enrolling users.
- Replace placeholder Verimi endpoints and TLS certs. Store secrets in AWS Secrets Manager, not `.env` in prod.
- Add recovery codes + admin reset before enforcing one-passkey policy.
