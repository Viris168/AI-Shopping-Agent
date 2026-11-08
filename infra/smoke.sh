#!/usr/bin/env bash
# Post-deploy smoke test from outside the VM, through DNS, TLS and Caddy.
#   infra/smoke.sh api.staging.yourstore.com chat.staging.yourstore.com
# Retries for a couple of minutes: on a first deploy Caddy is still getting certificates.
set -euo pipefail

api=${1:?usage: smoke.sh <api-domain> <chat-domain>}
chat=${2:?usage: smoke.sh <api-domain> <chat-domain>}
deadline=$((SECONDS + 150))

# check <name> <url> <jq filter that must be true>
check() {
  local name=$1 url=$2 filter=$3 body
  while :; do
    if body=$(curl -fsS --max-time 10 "$url" 2>&1) && jq -e "$filter" <<<"$body" >/dev/null 2>&1; then
      echo "ok   $name"
      return 0
    fi
    if [ $SECONDS -ge $deadline ]; then
      echo "FAIL $name  $url"
      echo "     ${body:0:300}"
      return 1
    fi
    sleep 5
  done
}

fail=0
check "commerce-api health (database up)" "https://$api/health" '.status == "ok"' || fail=1
check "commerce-api serves the catalog" "https://$api/api/v1/products?limit=1" 'type == "object" or type == "array"' || fail=1
# agent-service answers 200 even when degraded, so check the body.
check "agent-service health (redis + commerce-api)" "https://$chat/health" '.status == "ok"' || fail=1

if code=$(curl -fsS --max-time 10 -o /dev/null -w '%{http_code}' "https://$chat/v1/widget.js") && [ "$code" = 200 ]; then
  echo "ok   widget.js served"
else
  echo "FAIL widget.js  https://$chat/v1/widget.js"; fail=1
fi

exit $fail
