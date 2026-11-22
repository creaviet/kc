# Local mock of the IONOS VPS

This is a **Node.js-only** stand-in for the public part of your IONOS VPS. It lets
you click through all 11 steps without Docker, Java, Keycloak, Postgres, or access
to the production server.

There are two modes:

- **Simple mock** (described below): `127.0.0.1:9443` only. Keycloak and Verimi
  share that origin and are distinguished by path.
- **Emulated VPS**: separate ports for nginx, Keycloak, Postgres and external
  Verimi — see [`emulated/EMULATED.md`](emulated/EMULATED.md).

## What the simple mock mocks

| Mock endpoint | Real equivalent |
|---|---|
| `GET /realms/vw-beav/.well-known/openid-configuration` | OIDC discovery document |
| `GET /realms/vw-beav/protocol/openid-connect/auth` | Keycloak authorization endpoint |
| `GET /mock-verimi/authorize`, `POST /mock-verimi/login` | Verimi login UI |
| `GET /realms/vw-beav/broker/verimi/endpoint` | Keycloak broker callback |
| `POST /realms/vw-beav/protocol/openid-connect/token` | Keycloak token endpoint |
| `GET /realms/vw-beav/protocol/openid-connect/certs` | Keycloak JWKS |
| `GET /realms/vw-beav/account/credentials` | Keycloak Account API |
| `GET /realms/vw-beav/protocol/openid-connect/logout` | Keycloak logout |
| `GET /mock/reset` | test-only reset |

The token endpoint signs **real RS256 JWTs** with a key generated at startup.
The BFF uses `openid-client` against this mock: discovery, authorization URL,
PKCE code exchange, claim checks and JWKS signature validation with
`enableNonRepudiationChecks`. This is the same security code path as production;
`jose` is used only for encrypted BFF cookies.

## What it deliberately does NOT mock

- **Admin console `:8444`** — intentionally absent in the *simple* mock. In the
  *emulated* mode it exists with an IP allow/deny rule. In production it must be
  restricted to office/VPN/bastion IPs (see `../nginx/conf.d/20-keycloak-admin.conf`).
- Real WebAuthn. The enrolment page only simulates QR/USB/biometrics and flips
  an in-memory flag.
- nginx, TLS, Postgres, AWS Lambda, DynamoDB.
- Real Verimi. Any email/password is accepted.

## Run all three services

```bash
# Terminal 1 — mock IONOS VPS (public endpoints only)
cd impl-broker-bff/mock-vps
npm install
npm start                 # http://127.0.0.1:9443

# Terminal 2 — BFF against the mock
cd impl-broker-bff/backend
npm install
npm run start:mock        # http://localhost:3001, loads backend/.env.mock

# Terminal 3 — React SPA
cd impl-broker-bff/frontend
npm install
npm run dev               # http://localhost:5173
```

Open **http://localhost:5173** and click through:

1. **Mit Verimi anmelden** → mock Verimi login appears.
   There is also **Mit Passkey anmelden**; it opens the mock passkey page directly.
2. Enter anything → you return to the portal; banner appears.
3. **Passkey jetzt erstellen** → simulated WebAuthn page.
4. Click **Passkey jetzt simulieren** → `?passkey=created`, banner disappears.
5. Log out and log in again → mock Keycloak shows **Anmelden mit Passkey**;
   Verimi is not contacted.

Reset the simulated passkey:

```bash
curl http://localhost:9443/mock/reset
```

## Configuration

`backend/.env.mock` points the BFF at the mock:

```env
KC_BASE_URL=http://localhost:9443
KC_PUBLIC_URL=http://localhost:9443
ALLOW_INSECURE_OIDC=true
PORTALS_JSON={"vw-baev.de":{"realm":"vw-beav","clientId":"portal-spa","clientSecret":"dev-secret","redirectUri":"http://localhost:5173/api/auth/callback"}}
DEV_PORTAL_HOST=vw-baev.de
INSECURE_COOKIES=true
STORE=memory
```

`ALLOW_INSECURE_OIDC=true` permits HTTP discovery in this local mock only.
The backend rejects it at cold start in AWS.

`frontend/.env.local` points the SPA’s safety check at the mock:

```env
VITE_KC_SCHEME=http
VITE_KC_HOST=localhost:9443
```

Production values remain the defaults in `frontend/src/config.ts`:
`https://kc.gateway-vw.de:8443`.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Login still goes to `kc.gateway-vw.de:8443` | BFF was started with `npm start` instead of `npm run start:mock`, or Vite did not reload `frontend/.env.local` |
| `unexpected_authorization_url` in browser | `VITE_KC_HOST` does not match the `KC_PUBLIC_URL` used by the BFF |
| `allowInsecureRequests` / discovery TLS error in BFF | `ALLOW_INSECURE_OIDC=true` is missing from the local mock env |
| `invalid_grant (PKCE)` in mock log | You restarted the mock but not the BFF; restart both so state aligns |
| Session cookie not stored | `INSECURE_COOKIES=true` must be set for local HTTP |
| "Passkey aktiv" appears before I enrolled | The mock uses ONE global user (`mock-user-1`). A previous browser session or an automated smoke test may already have enrolled it. Run `curl http://localhost:9443/mock/reset` **and** clear cookies for `localhost:5173` / use an incognito window. The BFF memory cache also needs a restart if you want a completely fresh demo. |
| Admin port should be there | No — admin stays restricted in production and is absent in the mock by design |
