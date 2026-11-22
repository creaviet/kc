# Login-Button → Keycloak → Verimi: URL und Body

**Project:** keycloak-passkey-3
**Date:** 2026-11-19
**Scope:** Exakte URL, Parameter und Body für den Login-Button; vollständiger Redirect-Kettenverlauf.

---

## Kurzantwort

Der Login-Button **schickt keinen Body**. Er macht im Browser einen **GET-Redirect mit Query-Parametern** an den Keycloak-**Authorize-Endpoint**. Keycloak antwortet mit einem `302` auf die Verimi-URL — die Verimi-URL baust **du nicht**, die kommt aus der IdP-Konfiguration (`identityProviders[alias=verimi].config.authorizationUrl`).

Mit den echten Werten aus `impl/portal/app.js` und `impl/keycloak/realm-export.json`:

```
https://kc.gateway-vw.de:8443/realms/vw-beav/protocol/openid-connect/auth
  ?client_id=portal-spa
  &redirect_uri=https%3A%2F%2Fvw-baev.de%2Fauth%2Fcallback
  &response_type=code
  &scope=openid%20profile%20email
  &state=<zufällig>
  &nonce=<zufällig>
  &code_challenge=<base64url(SHA256(verifier))>
  &code_challenge_method=S256
  &kc_idp_hint=verimi
```

**Der entscheidende Parameter ist `kc_idp_hint=verimi`.** Der muss exakt zum IdP-`alias` passen — bei euch ist das `verimi`. ✅

---

## Der komplette Kettenverlauf (wer wen aufruft)

| Schritt | Wer → Wen | Methode | URL / Body |
|---|---|---|---|
| 1 | Browser → Keycloak | **GET** (Redirect) | obenstehende `/auth?...` — **kein Body** |
| 2 | Keycloak → Browser | `302` | `Location: https://verimi.example.com/oauth/authorize?client_id=…&redirect_uri=https://kc.gateway-vw.de:8443/realms/vw-beav/broker/verimi/endpoint&state=…` |
| 3 | Browser → Verimi | GET | Login-Formular, User authentifiziert sich (unveränderter Verimi-Code) |
| 4 | Verimi → Browser → Keycloak | `302` | `/realms/vw-beav/broker/verimi/endpoint?code=…&state=…` |
| 5 | Keycloak → Browser → Portal | `302` | `https://vw-baev.de/auth/callback?code=…&state=…` |
| 6 | Portal → Lambda | **POST + JSON-Body** | `{ "code": "…", "redirect_uri": "…", "code_verifier": "…", "portal_account_id": "…" }` |
| 7 | Lambda → Keycloak | **POST + Form-Body** | `/realms/vw-beav/protocol/openid-connect/token` mit `grant_type=authorization_code&client_id=portal-spa&code=…&redirect_uri=…&code_verifier=…` (genau so in deinem `handler.js`) |

Merksatz: **Body erst ab Schritt 6.** Der Button selbst ist ein reiner GET.

---

## Fertiger Button-Code (mit echten Werten, PKCE korrekt)

```js
const KC_BASE     = "https://kc.gateway-vw.de:8443";
const REALM       = "vw-beav";
const CLIENT_ID   = "portal-spa";
const REDIRECT_URI = "https://vw-baev.de/auth/callback"; // ⚠ exakt wie in Keycloak eingetragen
const AUTH_URL    = `${KC_BASE}/realms/${REALM}/protocol/openid-connect/auth`;

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function login() {
  const verifier  = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(verifier)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(32)));

  // für den Callback merken (Lambda braucht den verifier)
  sessionStorage.setItem("pkce_verifier", verifier);
  sessionStorage.setItem("oidc_state", state);
  sessionStorage.setItem("oidc_nonce", nonce);

  const p = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: "openid profile email",
    state, nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
    kc_idp_hint: "verimi",   // <-- zwingt Keycloak, direkt zu Verimi weiterzuleiten
  });

  window.location.assign(`${AUTH_URL}?${p}`); // GET, kein Body
}

document.getElementById("login").addEventListener("click", login);
```

Im Callback zuerst `state` vergleichen (CSRF-Schutz), dann `code` + `code_verifier` an Lambda schicken.

---

## Drei Dinge in eurer aktuellen Konfiguration, die dabei auffallen

1. **`kc_action` gehört nicht an den Login-Button.** In eurem `app.js` steckt `kc_action=webauthn-register-passwordless:skip_if_exists` in `buildAuthorizeUrl()`. Das ist der *Enrolment*-Redirect (Schritt 8 aus dem Diagramm), nicht der Login. Wenn du das beim Login mitträgst, startet Keycloak sofort nach dem Verimi-Login die Passkey-Registrierung — für die reine Frage „Login → Verimi" ist das nicht nötig und vermischt die zwei Schritte. (Für die Migrationskampagne kann es gewollt sein — dann aber bewusst als „forced enrolment" dokumentieren.)

2. **`redirectUris` in `realm-export.json` ist noch Platzhalter**: `https://portal.example.com/auth/callback`. Für echte Portale müssen da die 9 echten URIs stehen, z. B. `https://vw-baev.de/auth/callback`, `https://ltkv.de/auth/callback`, ... Sonst lehnt Keycloak mit `invalid_request: Invalid redirect_uri` ab.

3. **`code_challenge: "CHALLENGE_PLACEHOLDER"`** muss durch echten PKCE-Code ersetzt werden (wie oben) — sonst schlägt der Token-Austausch in Lambda fehl.

---

## Siehe auch

- `architecture_11-19-2026.md` — Phasenmodell und korrigierte C4-Diagramme
- `architecture_11-15-2026.md` §10 — drei Phasen (A heute / B Übergang / C nach Abschaltung)
