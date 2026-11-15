#!/bin/sh
# ============================================================================
#  Smoke test: is the stack reachable and is the brokering configured?
# ============================================================================
#  Read-only HTTP checks against the running stack. No credentials needed.
#
#    ./scripts/smoke-test.sh
# ============================================================================
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
cd "$PROJECT_DIR"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

CA="$PROJECT_DIR/certs/ca.crt"
KC=${KC_HOSTNAME:-https://kc.gateway-vw.de:8443}
KC_ADMIN=${KC_HOSTNAME_ADMIN:-https://kc-admin.gateway-vw.de:8444}
PORTAL=${PORTAL_URL:-https://portal.gateway-vw.de:8443}
VERIMI=${VERIMI_ISSUER:-https://verimi.gateway-vw.de:3443}
REALM=${KEYCLOAK_REALM:-vw-beav}
CLIENT=${KEYCLOAK_CLIENT_ID:-portal-spa}

if [ -f "$CA" ]; then
  CURL_TLS="--cacert $CA"
else
  echo "WARNING: $CA not found - falling back to --insecure" >&2
  CURL_TLS="--insecure"
fi

pass=0
fail=0

check() {
  label=$1
  expected=$2
  actual=$3
  if [ "$actual" = "$expected" ]; then
    printf '  PASS  %-46s %s\n' "$label" "$actual"
    pass=$((pass + 1))
  else
    printf '  FAIL  %-46s got=%s want=%s\n' "$label" "$actual" "$expected"
    fail=$((fail + 1))
  fi
}

contains() {
  label=$1
  needle=$2
  haystack=$3
  case "$haystack" in
    *"$needle"*)
      printf '  PASS  %-46s contains %s\n' "$label" "$needle"
      pass=$((pass + 1))
      ;;
    *)
      printf '  FAIL  %-46s missing %s\n' "$label" "$needle"
      fail=$((fail + 1))
      ;;
  esac
}

echo "Portal  $PORTAL"
check "GET /" 200 "$(curl -s -o /dev/null -w '%{http_code}' $CURL_TLS "$PORTAL/")"
check "GET /auth/callback (SPA route)" 200 "$(curl -s -o /dev/null -w '%{http_code}' $CURL_TLS "$PORTAL/auth/callback")"
contains "GET /styles.css" "text/css" "$(curl -s -o /dev/null -w '%{content_type}' $CURL_TLS "$PORTAL/styles.css")"

echo "Portal API  $PORTAL/api/healthz"
check "GET /api/healthz" 200 "$(curl -s -o /dev/null -w '%{http_code}' $CURL_TLS "$PORTAL/api/healthz")"
contains "healthz body" '"status":"ok"' "$(curl -s $CURL_TLS "$PORTAL/api/healthz")"

echo "Keycloak  $KC"
disco=$(curl -s $CURL_TLS "$KC/realms/$REALM/.well-known/openid-configuration")
contains "oidc discovery issuer" "\"issuer\":\"$KC/realms/$REALM\"" "$disco"
contains "token endpoint" "$KC/realms/$REALM/protocol/openid-connect/token" "$disco"
check "JWKS" 200 "$(curl -s -o /dev/null -w '%{http_code}' $CURL_TLS "$KC/realms/$REALM/protocol/openid-connect/certs")"

echo "Keycloak admin  $KC_ADMIN"
admin_status=$(curl -s -o /dev/null -w '%{http_code}' $CURL_TLS "$KC_ADMIN/admin/master/console/")
case "$admin_status" in
  200|302)
    printf '  PASS  %-46s %s\n' "admin console reachable" "$admin_status"
    pass=$((pass + 1))
    ;;
  *)
    printf '  FAIL  %-46s got=%s want=200|302\n' "admin console reachable" "$admin_status"
    fail=$((fail + 1))
    ;;
esac

echo "Mock Verimi  $VERIMI"
vdisco=$(curl -s $CURL_TLS "$VERIMI/.well-known/openid-configuration")
contains "verimi issuer" "\"issuer\":\"$VERIMI\"" "$vdisco"

echo "Broker redirect"
challenge="smoketest_challenge_0123456789abcdefghijklmn"
auth_url="$KC/realms/$REALM/protocol/openid-connect/auth?response_type=code&client_id=$CLIENT"
auth_url="$auth_url&redirect_uri=$PORTAL/auth/callback&scope=openid&state=smoke"
auth_url="$auth_url&code_challenge=$challenge&code_challenge_method=S256"
auth_url="$auth_url&kc_idp_hint=verimi&kc_action=webauthn-register-passwordless:skip_if_exists"

# Hop 1: Keycloak hands the browser to the brokering endpoint. Keycloak 26
# answers 303 See Other here; older versions used 302. A cookie jar is required
# because the broker endpoint resolves the auth session from it.
cookie_jar=$(mktemp)
trap 'rm -f "$cookie_jar"' EXIT INT TERM
headers=$(curl -s -D - -o /dev/null -c "$cookie_jar" $CURL_TLS "$auth_url" | tr -d '\r')
status=$(printf '%s' "$headers" | awk 'NR==1 {print $2}')
location=$(printf '%s' "$headers" | awk 'tolower($1)=="location:" {print $2; exit}')
case "$status" in
  302|303)
    printf '  PASS  %-46s %s\n' "authorize -> broker login" "$status"
    pass=$((pass + 1))
    ;;
  *)
    printf '  FAIL  %-46s got=%s want=302|303\n' "authorize -> broker login" "$status"
    fail=$((fail + 1))
    ;;
esac
contains "hand-off targets kc_idp_hint" "/realms/$REALM/broker/verimi/login" "$location"

# Hop 2: the broker endpoint redirects to the IdP. %{redirect_url} shows the
# next hop without following it, so this stays a read-only check.
# Keycloak may emit the Location header as an absolute URL or as a path.
case "$location" in
  http://*|https://*) broker_url=$location ;;
  *) broker_url="$KC$location" ;;
esac
if [ -n "$location" ]; then
  idp_url=$(curl -s -o /dev/null -w '%{redirect_url}' -b "$cookie_jar" $CURL_TLS "$broker_url")
else
  idp_url=""
fi
contains "broker login -> Verimi authorize" "$VERIMI/authorize" "$idp_url"
contains "PKCE challenge forwarded" "code_challenge=" "$idp_url"
contains "PKCE method forwarded" "code_challenge_method=S256" "$idp_url"
contains "authorization code flow" "response_type=code" "$idp_url"
contains "state forwarded to IdP" "state=" "$idp_url"

echo
echo "passed: $pass   failed: $fail"
[ "$fail" -eq 0 ] || exit 1
