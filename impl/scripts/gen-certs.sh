#!/bin/sh
# ============================================================================
#  Generate the demo CA + one TLS server certificate for all demo hostnames.
# ============================================================================
#  Creates (in ../certs by default):
#     ca.crt / ca.key       local root CA  (trust this in browser/OS, and
#                                            Keycloak trusts it via
#                                            KC_TRUSTSTORE_PATHS)
#     server.crt / server.key  used by nginx (:8443, :8444) and mock-verimi (:3443)
#
#  Re-run with FORCE=1 to regenerate (invalidates the trust you installed).
# ============================================================================
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
CERT_DIR=${CERT_DIR:-"$PROJECT_DIR/certs"}
DAYS=${DAYS:-825}
CN=${CN:-kc.gateway-vw.de}
DOMAINS=${DOMAINS:-"kc.gateway-vw.de kc-admin.gateway-vw.de portal.gateway-vw.de verimi.gateway-vw.de localhost"}

if ! command -v openssl >/dev/null 2>&1; then
  echo "ERROR: openssl not found" >&2
  exit 1
fi

if [ -f "$CERT_DIR/server.crt" ] && [ -f "$CERT_DIR/ca.crt" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "certificates already present in $CERT_DIR (FORCE=1 to regenerate)"
  openssl x509 -in "$CERT_DIR/server.crt" -noout -enddate | sed 's/^/  /'
  exit 0
fi

mkdir -p "$CERT_DIR"
umask 077

echo "==> CA"
openssl req -x509 -newkey rsa:3072 -sha256 -days "$DAYS" -nodes \
  -keyout "$CERT_DIR/ca.key" -out "$CERT_DIR/ca.crt" \
  -subj "/C=DE/O=VW Demo/CN=VW Demo Local CA" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null

echo "==> server certificate (SANs: $DOMAINS, 127.0.0.1, ::1)"
CNF="$CERT_DIR/server.cnf"
{
  echo "[req]"
  echo "prompt = no"
  echo "distinguished_name = dn"
  echo "[dn]"
  echo "C = DE"
  echo "O = VW Demo"
  echo "CN = $CN"
  echo "[ext]"
  echo "basicConstraints = critical,CA:FALSE"
  echo "keyUsage = critical,digitalSignature,keyEncipherment"
  echo "extendedKeyUsage = serverAuth"
  echo "subjectKeyIdentifier = hash"
  echo "authorityKeyIdentifier = keyid,issuer"
  echo "subjectAltName = @alt"
  echo "[alt]"
  i=1
  for d in $DOMAINS; do
    echo "DNS.$i = $d"
    i=$((i + 1))
  done
  echo "IP.1 = 127.0.0.1"
  echo "IP.2 = ::1"
} > "$CNF"

openssl req -new -newkey rsa:2048 -sha256 -nodes \
  -keyout "$CERT_DIR/server.key" -out "$CERT_DIR/server.csr" \
  -config "$CNF" 2>/dev/null

openssl x509 -req -in "$CERT_DIR/server.csr" -CA "$CERT_DIR/ca.crt" -CAkey "$CERT_DIR/ca.key" \
  -CAcreateserial -days "$DAYS" -sha256 \
  -extfile "$CNF" -extensions ext -out "$CERT_DIR/server.crt" 2>/dev/null

rm -f "$CERT_DIR/server.csr" "$CERT_DIR/server.cnf" "$CERT_DIR/ca.srl"

chmod 644 "$CERT_DIR/ca.crt" "$CERT_DIR/server.crt"
chmod 600 "$CERT_DIR/ca.key"
# Readable by the containers that mount it (nginx master runs as root, the mock
# IdP is a throwaway demo process).
chmod 640 "$CERT_DIR/server.key"

echo "==> done"
ls -l "$CERT_DIR"

cat <<'EOS'

Next steps
----------
1) Hostnames (once, needs sudo):
     ./scripts/hosts.sh --print
2) Trust the CA in your browser/OS:
     Linux (Debian/Ubuntu): sudo cp certs/ca.crt /usr/local/share/ca-certificates/vw-demo-ca.crt && sudo update-ca-certificates
     Fedora/RHEL:           sudo cp certs/ca.crt /etc/pki/ca-trust/source/anchors/vw-demo-ca.crt && sudo update-ca-trust
     macOS:                 sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain certs/ca.crt
     Firefox only:          Settings -> Privacy & Security -> Certificates -> View Certificates -> Authorities -> Import
     Chrome/Chromium:       uses the OS store (Linux: NSS db may be separate)
3) docker compose up -d --build
EOS
