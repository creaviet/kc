#!/usr/bin/env bash
# Start the emulated IONOS VPS topology. Node-only; no Docker required.
set -euo pipefail

cd "$(dirname "$0")"

export PUBLIC_BASE="${PUBLIC_BASE:-http://localhost:8443}"
export VERIMI_BASE="${VERIMI_BASE:-http://localhost:3443}"
export KEYCLOAK_UPSTREAM="${KEYCLOAK_UPSTREAM:-http://127.0.0.1:8080}"
export PG_URL="${PG_URL:-http://127.0.0.1:55432}"
export ADMIN_TRUSTED_IPS="${ADMIN_TRUSTED_IPS:-127.0.0.1,::1}"

pids=()

cleanup() {
  trap - EXIT INT TERM
  echo "[emulated-vps] stopping services..."
  for pid in "${pids[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "[emulated-vps] starting mock Postgres :55432"
node postgres.js &
pids+=("$!")
sleep 0.4

echo "[emulated-vps] starting mock Keycloak internal :8080"
node keycloak.js &
pids+=("$!")
sleep 0.4

echo "[emulated-vps] starting external mock Verimi :3443"
node verimi.js &
pids+=("$!")
sleep 0.4

echo "[emulated-vps] starting mock nginx public :8443 / admin :8444"
node nginx.js &
pids+=("$!")

for _ in $(seq 1 40); do
  if curl -fsS http://127.0.0.1:55432/healthz >/dev/null 2>&1 \
    && curl -fsS http://127.0.0.1:8080/healthz >/dev/null 2>&1 \
    && curl -fsS http://127.0.0.1:3443/healthz >/dev/null 2>&1 \
    && curl -fsS http://127.0.0.1:8443/healthz >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

cat <<'EOF'

[emulated-vps] READY

  public nginx   http://localhost:8443   -> Keycloak :8080
  admin  nginx   http://localhost:8444   -> IP-restricted
  Keycloak int.  http://127.0.0.1:8080    (browser should NOT use this)
  Verimi ext.    http://localhost:3443
  Postgres mock  http://127.0.0.1:55432

  In another terminal:
    cd ../../backend  && npm run start:emulated
    cd ../../frontend && npm run dev:emulated
    open http://localhost:5173

  Reset:
    curl http://localhost:8443/mock/reset

  Test admin deny:
    curl -i http://localhost:8444/admin
  Test admin allow:
    curl -i -H 'X-Mock-Remote-IP: 127.0.0.1' http://localhost:8444/admin
EOF

wait
