// Portal SPA: builds the Keycloak authorize URL with AIA, handles the return.
// WHO calls WHOM:
//   Browser (this) -> Keycloak authorize endpoint (kc.gateway-vw.de)
//   Keycloak -> Verimi (IdP brokering, silent SSO)
//   Keycloak -> Browser: passkey registration ceremony on Keycloak origin
//   Keycloak -> Browser: redirect back with kc_action_status

const KC_BASE = "https://kc.gateway-vw.de:8443";
const REALM = "vw-beav";
const CLIENT_ID = "portal-spa";
const REDIRECT_URI = window.location.origin + "/auth/callback";

const AUTH_URL = `${KC_BASE}/realms/${REALM}/protocol/openid-connect/auth`;

function buildAuthorizeUrl() {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: "openid profile email",
    kc_idp_hint: "verimi",
    // Application Initiated Action: register a passwordless passkey.
    // :skip_if_exists makes this a no-op if the user already has one.
    kc_action: "webauthn-register-passwordless:skip_if_exists",
    // PKCE
    code_challenge: "CHALLENGE_PLACEHOLDER", // replace with real PKCE in production
    code_challenge_method: "S256",
  });
  return `${AUTH_URL}?${params.toString()}`;
}

document.getElementById("createPasskey").addEventListener("click", () => {
  document.getElementById("popup").classList.remove("hidden");
});

document.getElementById("dismiss").addEventListener("click", () => {
  document.getElementById("popup").classList.add("hidden");
});

document.getElementById("startEnrol").addEventListener("click", () => {
  window.location.href = buildAuthorizeUrl();
});

// Handle return from Keycloak
(function handleCallback() {
  const url = new URL(window.location.href);
  const status = url.searchParams.get("kc_action_status");
  if (status) {
    const el = document.getElementById("status");
    el.textContent = status === "success"
      ? "Passkey created successfully. You can now log in with it."
      : "Passkey creation cancelled.";
    // In production: send the `code` to your Lambda to exchange for tokens
    // and persist portal_account_id <-> keycloak_sub mapping.
  }
})();
