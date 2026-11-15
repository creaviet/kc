#!/bin/sh
# ============================================================================
#  Show (or verify) the /etc/hosts entries the demo needs.
# ============================================================================
#  The demo uses real-world-looking hostnames instead of *.localhost so that the
#  WebAuthn RP ID (kc.gateway-vw.de) and the cookie scopes match production.
#
#    ./scripts/hosts.sh            # verify current resolution
#    ./scripts/hosts.sh --print    # print the line to append
# ============================================================================
set -eu

HOSTS=${HOSTS:-"kc.gateway-vw.de kc-admin.gateway-vw.de portal.gateway-vw.de verimi.gateway-vw.de"}
LINE="127.0.0.1 $HOSTS"

if [ "${1:-}" = "--print" ] || [ "${1:-}" = "-p" ]; then
  echo "Append this to /etc/hosts (requires sudo):"
  echo
  echo "    $LINE"
  echo
  echo "    echo '$LINE' | sudo tee -a /etc/hosts"
  exit 0
fi

echo "Expected:"
echo "    $LINE"
echo

if ! command -v getent >/dev/null 2>&1; then
  echo "getent not available - cannot verify automatically."
  exit 0
fi

status=0
for h in $HOSTS; do
  addr=$(getent hosts "$h" | awk '{print $1; exit}' || true)
  if [ -z "$addr" ]; then
    printf '  MISSING  %-28s (not resolvable)\n' "$h"
    status=1
  elif [ "$addr" = "127.0.0.1" ] || [ "$addr" = "::1" ]; then
    printf '  ok       %-28s -> %s\n' "$h" "$addr"
  else
    printf '  WRONG    %-28s -> %s (expected 127.0.0.1)\n' "$h" "$addr"
    status=1
  fi
done

if [ "$status" -ne 0 ]; then
  echo
  echo "Fix with: $LINE" '| sudo tee -a /etc/hosts'
fi
exit "$status"
