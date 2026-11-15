# portal-spa public client (PKCE, no secret)
client_id: portal-spa
redirect_uris:
  - https://portal.example.com/auth/callback
  - http://localhost:3000/auth/callback
web_origins:
  - https://portal.example.com
  - http://localhost:3000

# Realm roles
roles:
  - portal-user

# Identity Provider: Verimi (OIDC) — fill in real endpoints
idp: verimi
authorization_url: https://verimi.example.com/oauth/authorize   # REPLACE
token_url: https://verimi.example.com/oauth/token               # REPLACE
client_id: <your-verimi-client-id>                             # REPLACE
client_secret: <your-verimi-client-secret>                      # REPLACE (store in secrets manager, not here)

# WebAuthn passwordless policy (Keycloak 25)
credential: webauthn-register-passwordless
rp_id: kc.gateway-vw.de
rp_name: Gateway VW
acceptable_aags: []   # allow all authenticators
signature_algorithms: [ES256, RS256]
attestation_preference: none
authenticator_attachment: not specified
require_resident_key: required
user_verification: required
