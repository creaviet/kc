# Emulated IONOS VPS — separate ports, realistic topology

This is the **more realistic** local mode. Instead of one process on `:9443`, it
starts four Node processes on separate ports so you can see exactly which
origin is doing what.

> It is a topology emulator, not Docker. Docker/Java are not available in this
> environment. The Keycloak mock still signs real RS256 tokens, and the BFF uses
> `openid-client` with `enableNonRepudiationChecks` to validate discovery, PKCE,
> claims and the JWKS signature. This is the same protocol code path as
> production.

## Ports

| Port | Role | Reachable by browser? | Real equivalent |
|---:|---|---|---|
| `5173` | Portal React SPA | yes | `https://vw-baev.de` |
| `3001` | BFF via Vite `/api` proxy | indirectly | `https://vw-baev.de/api/*` (Lambda) |
| `8443` | **public nginx mock** | yes | `https://kc.gateway-vw.de:8443` |
| `8444` | **admin nginx mock** | only allowlisted IPs | `https://kc-admin.gateway-vw.de:8444` |
| `8080` | Keycloak mock, internal | no — only nginx proxies to it | Keycloak container port |
| `3443` | External mock Verimi | yes | real Verimi IdP (HTTPS/443) |
| `55432` | Mock Postgres | no — only Keycloak uses it | Postgres container |

The important change compared with the old `:9443` mock:

```text
OLD:  browser -> localhost:9443  (Keycloak AND Verimi by path)

NEW:  browser -> localhost:8443  (public nginx -> Keycloak :8080)
                          |
                          +-> localhost:3443 (external Verimi)
                          <-
                          broker callback through :8443
```

## C4-ish view

```text
                                      ┌──────────────────────────┐
                                      │  Browser / Portal :5173   │
                                      │  React SPA + BFF cookies  │
                                      └────────────┬─────────────┘
                                                   │ /api/*
                                                   ▼
                                      ┌──────────────────────────┐
                                      │ BFF :3001 (local Lambda) │
                                      │ openid-client, JWE cookies  │
                                      └────────────┬─────────────┘
                                                   │ authorizationUrl
                                                   ▼
┌────────────────────────────── EMULATED IONOS VPS ──────────────────────────────┐
│                                                                                │
│  ┌──────────────────┐        ┌──────────────────┐        ┌──────────────────┐  │
│  │ public nginx     │:8443   │ Keycloak mock    │:8080   │ mock Postgres    │  │
│  │ reverse proxy    │───────>│ OIDC + broker    │───────>│ :55432 JSON      │  │
│  └────────┬─────────┘        │ WebAuthn mock    │        └──────────────────┘  │
│           │                  └────────┬─────────┘                              │
│           │                           │ 302 /mock-verimi/authorize             │
│           │                           ▼                                        │
│  ┌──────────────────┐        ┌──────────────────┐                               │
│  │ admin nginx      │:8444   │ External Verimi  │:3443  (outside the VPS)      │
│  │ IP allow/deny    │        │ login UI mock    │                               │
│  └──────────────────┘        └──────────────────┘                               │
└────────────────────────────────────────────────────────────────────────────────┘
```

## Run

Stop the old mock/BFF/Vite first if they are still running:

```bash
pkill -f 'node server.js' || true
pkill -f 'local-server.js' || true
pkill -f 'node_modules/.bin/vite' || true
```

Terminal 1 — emulated VPS:

```bash
cd impl-broker-bff/mock-vps
npm install
npm run start:emulated
```

Terminal 2 — BFF pointed at the public nginx origin:

```bash
cd impl-broker-bff/backend
npm install
npm run start:emulated      # loads backend/.env.emulated -> KC_PUBLIC_URL/KC_BASE_URL=http://localhost:8443
```

Terminal 3 — SPA with the matching Keycloak origin check:

```bash
cd impl-broker-bff/frontend
npm install
npm run dev:emulated        # Vite mode "emulated" -> localhost:8443
```

Open **http://localhost:5173**.

## Click-through

1. Click **Mit Verimi anmelden**. The BFF has used `openid-client` discovery via
   `http://localhost:8443/realms/vw-beav/.well-known/openid-configuration`.
2. Browser goes to `localhost:8443/realms/vw-beav/protocol/openid-connect/auth?...`
   — this is the **public nginx**, proxying invisibly to Keycloak `:8080`.
3. Keycloak redirects to the **separate origin** `localhost:3443/mock-verimi/authorize`.
4. You see only the Verimi login page. Submit it.
5. Verimi redirects to `localhost:8443/realms/vw-beav/broker/verimi/endpoint`.
6. Keycloak redirects to `localhost:5173/api/auth/callback`; BFF creates the session.
7. Click **Passkey jetzt erstellen** → AIA page on the Keycloak origin.
8. Click **Passkey jetzt simulieren** → credential stored in mock Postgres `:55432`.
9. Log out. Click **Mit Passkey anmelden** → no `kc_idp_hint`; Verimi is never contacted.

## Admin plane test

The admin listener follows the same **fail-closed** idea as
`../nginx/conf.d/20-keycloak-admin.conf`.

Default in this emulator: only `127.0.0.1` and `::1` are trusted so localhost
testing works. Change with `ADMIN_TRUSTED_IPS`.

```bash
# allowed (default)
curl -i http://localhost:8444/admin

# denied — simulates an arbitrary internet IP
curl -i -H 'X-Mock-Remote-IP: 8.8.8.8' http://localhost:8444/admin
# HTTP/1.1 403 Forbidden
```

`X-Mock-Remote-IP` exists **only in the emulator**. Real nginx uses the TCP
peer address; never trust a client-supplied IP header in production.

## Health and reset

```bash
curl http://127.0.0.1:55432/healthz     # mock Postgres
curl http://127.0.0.1:8080/healthz      # Keycloak internal
curl http://localhost:3443/healthz      # external Verimi
curl http://localhost:8443/healthz      # public nginx
curl -H 'X-Mock-Remote-IP: 127.0.0.1' http://localhost:8444/healthz

curl http://localhost:8443/mock/reset   # reset passkey flag
```

After reset, clear cookies for `localhost:5173` or use an incognito window;
the BFF also caches the passkey state in memory.

## What is intentionally simplified

- No real TLS. Ports are `http://localhost:*`, but the origin boundaries are real.
- No Docker, no Java, no real Postgres wire protocol — the DB mock is an HTTP
  JSON store with persistence in `state.json`.
- No real WebAuthn ceremony — the Keycloak mock flips a boolean after the
  simulated QR/USB/biometrics page.
- No real Verimi — any email/password is accepted.
- `client_secret=dev-secret` is a local-only value.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `unexpected_keycloak_origin:http://localhost:9443` | Vite started with `npm run dev` instead of `npm run dev:emulated` |
| `connect ECONNREFUSED 127.0.0.1:8443` | BFF started with `start:mock` or emulated VPS not running |
| `EADDRINUSE :8443` | old nginx/Vite/other service already uses the port; stop it first |
| Discovery TLS error in BFF | `ALLOW_INSECURE_OIDC=true` missing from `backend/.env.emulated` |
| Admin page shows 403 | expected for untrusted IPs; add header or adjust `ADMIN_TRUSTED_IPS` |
| Passkey flag appears already set | run `curl http://localhost:8443/mock/reset` and clear portal cookies |
| PKCE invalid_grant | Keycloak mock restarted mid-flow; restart from the portal login button |
