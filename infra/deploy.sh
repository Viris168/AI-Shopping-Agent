#!/usr/bin/env bash
# Runs on the VM, from the deploy workflow:  ssh … 'bash shop/deploy.sh <ghcr-user>' <<< "$GHCR_TOKEN"
# Expects compose.yml and a fresh .env (images pinned by digest + secrets) next to it.
#
# Order: pull → datastores up → migrations → services up and healthy. Migrations run while the
# old containers still serve traffic, so they must be backward compatible (add, don't drop/rename).
set -euo pipefail
cd "$(dirname "$0")"

ghcr_user=${1:?usage: deploy.sh <ghcr-user>  (registry token on stdin)}

[ -f .env ] || { echo "deploy: missing $(pwd)/.env" >&2; exit 1; }
[ "$(stat -c %a .env)" = 600 ] || { echo "deploy: .env must be mode 600" >&2; exit 1; }

# shellcheck disable=SC1091
bundled=$(set -a; . ./.env; echo "${BUNDLED_DATASTORES:-false}")
profiles=()
if [ "$bundled" = true ]; then
  # shellcheck disable=SC1091
  [ -n "$(set -a; . ./.env; echo "${POSTGRES_PASSWORD:-}")" ] \
    || { echo "deploy: BUNDLED_DATASTORES=true needs POSTGRES_PASSWORD" >&2; exit 1; }
  profiles=(--profile datastores)
fi
compose() { docker compose -f compose.yml "${profiles[@]}" "$@"; }

# The registry token is the workflow's GITHUB_TOKEN: valid for this job only. Log out anyway.
docker login ghcr.io -u "$ghcr_user" --password-stdin >/dev/null
trap 'docker logout ghcr.io >/dev/null 2>&1 || true' EXIT

compose pull --quiet commerce-api agent-service edge
if [ "$bundled" = true ]; then
  compose pull --quiet postgres redis
  compose up -d --wait postgres redis
fi

echo "deploy: running migrations"
compose --profile migrate run --rm migrate

echo "deploy: starting services"
compose up -d --wait --wait-timeout 180 --remove-orphans

compose ps
docker image prune -f >/dev/null
echo "deploy: done"
