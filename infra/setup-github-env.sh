#!/usr/bin/env bash
# Sets up one GitHub Environment (staging or production) as the secrets store for a deploy.
# Run it once per environment from your machine, logged in with `gh auth login` as a repo admin:
#
#   infra/setup-github-env.sh staging
#   infra/setup-github-env.sh production
#
# It creates the environment (deploys from `main` only; production also gets you as required
# reviewer), generates JWT_SECRET, SERVICE_TOKEN and an SSH deploy key, asks for the rest, and
# stores them with `gh secret set` / `gh variable set`. No value is printed or written to disk
# except the deploy key pair, which stays in a temp dir until you add the public half to the VM.
# Re-running regenerates JWT_SECRET/SERVICE_TOKEN: every shopper is signed out on the next deploy.
set -euo pipefail

env=${1:?usage: setup-github-env.sh staging|production}
[[ $env == staging || $env == production ]] || { echo "environment must be staging or production" >&2; exit 1; }
for cmd in gh openssl ssh-keygen ssh-keyscan; do
  command -v "$cmd" >/dev/null || { echo "needs $cmd" >&2; exit 1; }
done
repo=$(gh repo view --json nameWithOwner -q .nameWithOwner)
echo "Setting up the '$env' environment of $repo"

ask() { local v; read -r -p "$1: " v; [ -n "$v" ] || { echo "required" >&2; exit 1; }; printf '%s' "$v"; }
ask_secret() { local v; read -r -s -p "$1 (hidden): " v; echo >&2; [ -n "$v" ] || { echo "required" >&2; exit 1; }; printf '%s' "$v"; }
secret() { printf '%s' "$2" | gh secret set "$1" --env "$env" --repo "$repo"; }
var() { gh variable set "$1" --env "$env" --repo "$repo" --body "$2"; }

# --- Environment: main only; production waits for a reviewer -------------------------------
if [ "$env" = production ]; then
  me=$(gh api user -q .id)
  body="{\"reviewers\":[{\"type\":\"User\",\"id\":$me}],\"prevent_self_review\":false,
         \"deployment_branch_policy\":{\"protected_branches\":false,\"custom_branch_policies\":true}}"
else
  body='{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}'
fi
gh api -X PUT "repos/$repo/environments/$env" --input - <<<"$body" >/dev/null
gh api -X POST "repos/$repo/environments/$env/deployment-branch-policies" -f name=main >/dev/null 2>&1 || true

# --- Generated secrets ----------------------------------------------------------------------
# Different per environment, and never the one that leaked in git history (NOTES.md).
secret JWT_SECRET "$(openssl rand -hex 32)"
secret SERVICE_TOKEN "$(openssl rand -hex 32)"

# --- Model key ------------------------------------------------------------------------------
secret ANTHROPIC_API_KEY "$(ask_secret "ANTHROPIC_API_KEY for $env (the DeepSeek key; separate from CI's)")"

# --- Datastores -----------------------------------------------------------------------------
read -r -p "Run Postgres and Redis on the VM instead of managed services? [y/N] " bundled
if [[ $bundled =~ ^[Yy] ]]; then
  pg=$(openssl rand -hex 24)
  secret POSTGRES_PASSWORD "$pg"
  secret DATABASE_URL "postgresql://shop:$pg@postgres:5432/shop"
  secret REDIS_URL "redis://redis:6379/0"
  var BUNDLED_DATASTORES true
else
  secret DATABASE_URL "$(ask_secret "DATABASE_URL (postgresql://user:pass@host:5432/db?sslmode=require)")"
  secret REDIS_URL "$(ask_secret "REDIS_URL (rediss://:pass@host:6379/0)")"
  var BUNDLED_DATASTORES false
fi

# --- Domains and origins --------------------------------------------------------------------
var API_DOMAIN "$(ask "API domain, e.g. api.$( [ "$env" = staging ] && echo staging. )yourstore.com")"
var CHAT_DOMAIN "$(ask "Chat domain, e.g. chat.$( [ "$env" = staging ] && echo staging. )yourstore.com")"
var ACME_EMAIL "$(ask "Email for Let's Encrypt expiry notices")"
storefront=$(ask "Storefront URL, e.g. https://$( [ "$env" = staging ] && echo staging. )yourstore.com")
var STOREFRONT_URL "$storefront"
var API_CORS_ORIGINS "$storefront"
var CHAT_CORS_ORIGINS "$storefront"

# --- Monitoring (optional; infra/monitoring/README.md) --------------------------------------
read -r -p "OTLP endpoint for traces and metrics (blank to skip), e.g. https://otlp-gateway-prod-eu-west-2.grafana.net/otlp: " otlp
if [ -n "$otlp" ]; then
  var OTEL_EXPORTER_OTLP_ENDPOINT "$otlp"
  secret OTEL_EXPORTER_OTLP_HEADERS "$(ask_secret "OTLP headers, e.g. Authorization=Basic%20<base64 of instanceId:token>")"
fi

# --- VM access ------------------------------------------------------------------------------
host=$(ask "VM host name or IP")
var DEPLOY_HOST "$host"
var DEPLOY_USER "$(ask "SSH user on the VM (in the docker group)")"

keys=$(ssh-keyscan -T 10 "$host" 2>/dev/null)
[ -n "$keys" ] || { echo "ssh-keyscan $host returned nothing; is the VM up?" >&2; exit 1; }
echo "Host key fingerprints for $host (compare with the VM console: ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub):"
ssh-keygen -lf - <<<"$keys"
read -r -p "Do they match? [y/N] " ok
[[ $ok =~ ^[Yy] ]] || { echo "Stopped: host key not confirmed" >&2; exit 1; }
var DEPLOY_KNOWN_HOSTS "$keys"

tmp=$(mktemp -d)
ssh-keygen -q -t ed25519 -N '' -C "github-deploy-$env" -f "$tmp/key"
gh secret set DEPLOY_SSH_KEY --env "$env" --repo "$repo" < "$tmp/key"
echo
echo "Add this line to ~/.ssh/authorized_keys of that user on $host:"
echo
cat "$tmp/key.pub"
rm -rf "$tmp"
echo
echo "Done. '$env' has: ANTHROPIC_API_KEY JWT_SECRET SERVICE_TOKEN DATABASE_URL REDIS_URL DEPLOY_SSH_KEY"
echo "Check: gh secret list --env $env && gh variable list --env $env"
