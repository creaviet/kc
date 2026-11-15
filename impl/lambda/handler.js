// AWS Lambda (Node.js) handler.
// WHO calls WHOM:
//   Portal SPA -> POST /auth/callback { code }  (Lambda)
//   Lambda -> Keycloak token endpoint (code exchange)
//   Lambda -> Keycloak JWKS (validate id_token)
//   Lambda -> DynamoDB/RDS (store portal_account_id <-> keycloak_sub)
//
// NOTE: No Keycloak Admin credentials anywhere in this path.

const { createRemoteJWKSet, jwtVerify } = require("jose");

const KC_BASE = process.env.KC_BASE || "https://kc.gateway-vw.de:8443";
const REALM = process.env.KC_REALM || "vw-beav";
const CLIENT_ID = process.env.KC_CLIENT_ID || "portal-spa";
const JWKS = createRemoteJWKSet(new URL(`${KC_BASE}/realms/${REALM}/protocol/openid-connect/certs`));

exports.handler = async (event) => {
  try {
    const body = JSON.parse(event.body || "{}");
    const { code } = body;
    if (!code) return resp(400, { error: "missing_code" });

    // 1. Exchange authorization code for tokens (PKCE verifier from client)
    const tokenRes = await fetch(`${KC_BASE}/realms/${REALM}/protocol/openid-connect/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code,
        redirect_uri: body.redirect_uri,
        code_verifier: body.code_verifier,
      }),
    });
    if (!tokenRes.ok) return resp(401, { error: "token_exchange_failed" });
    const tokens = await tokenRes.json();

    // 2. Validate ID token signature + claims
    const { payload } = await jwtVerify(tokens.id_token, JWKS, {
      issuer: `${KC_BASE}/realms/${REALM}`,
      audience: CLIENT_ID,
    });

    const keycloakSub = payload.sub;
    const portalAccountId = body.portal_account_id; // from existing Verimi session context
    if (!portalAccountId) return resp(400, { error: "missing_portal_account_id" });

    // 3. Persist mapping (portal owns this mapping; Keycloak owns the credential)
    // await db.put({ portal_account_id: portalAccountId, keycloak_sub: keycloakSub });
    console.log("LINK", { portalAccountId, keycloakSub });

    return resp(200, { ok: true, sub: keycloakSub, kc_action_status: body.kc_action_status });
  } catch (e) {
    console.error(e);
    return resp(500, { error: "internal_error" });
  }
};

function resp(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
