# infra — staging and production

One Linux VM per environment runs the stack with Docker Compose. GitHub Actions builds the images,
holds the secrets (GitHub Environment secrets), and deploys over SSH.

```
push to main ─► deploy-staging.yml
                  build commerce-api, agent-service, edge ─► ghcr.io/<owner>/<repo>/<name>:<sha>
                  _deploy.yml (environment: staging): pin digests → write VM .env → migrate → up --wait → smoke
manual run   ─► deploy-production.yml
                  pick a SHA that passed staging ─► reviewer approves ─► _deploy.yml (environment: production)
```

| File | What |
|---|---|
| `compose.yml` | The stack on the VM: commerce-api, agent-service, edge (Caddy), optional postgres/redis, one-shot migrate |
| `edge/Dockerfile`, `edge/Caddyfile` | TLS and routing (`API_DOMAIN` → commerce-api, `CHAT_DOMAIN` → agent-service), plus `/v1/widget.js` built in |
| `deploy.sh` | Runs on the VM: pull → migrate → `up --wait` |
| `smoke.sh` | Runs from the runner against the public URLs |
| `setup-github-env.sh` | Creates a GitHub Environment and fills in its secrets and variables |
| `monitoring/` | Grafana dashboard, alert rules, kill switch and rollout runbooks |

## Secrets

Kept as **GitHub Environment secrets**, separately for `staging` and `production`. They are
readable only by a job that declares the environment, and only on `main`. Production jobs also
wait for a reviewer. Each deploy writes them to `~/shop/.env` on the VM (mode 600, over SSH
stdin), and Compose passes them to the containers. They never go into an image.

| Secret | Used by | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | agent-service | DeepSeek key by default (`ANTHROPIC_BASE_URL`). Use a different key from CI's eval key |
| `JWT_SECRET` | both | Same value for both services, different per environment, 32+ chars. Generated |
| `SERVICE_TOKEN` | both | agent-service → commerce-api `X-Service-Token`, 32+ chars. Generated |
| `DATABASE_URL` | commerce-api, migrate | Managed Postgres 16, or `postgres:5432` if bundled |
| `REDIS_URL` | agent-service | Managed Redis, or `redis:6379` if bundled |
| `POSTGRES_PASSWORD` | postgres | Only with `BUNDLED_DATASTORES=true` |
| `DEPLOY_SSH_KEY` | workflow | Private half of a deploy-only key. Generated |

Variables (not secret): `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_KNOWN_HOSTS`, `API_DOMAIN`,
`CHAT_DOMAIN`, `ACME_EMAIL`, `STOREFRONT_URL`, `API_CORS_ORIGINS`, `CHAT_CORS_ORIGINS`,
`BUNDLED_DATASTORES`. Optional: `AGENT_ENABLED` (default `true`), `ROLLOUT_PERCENT` (default
production `0`, staging `100`), `OTEL_EXPORTER_OTLP_ENDPOINT` with the secret
`OTEL_EXPORTER_OTLP_HEADERS` ([monitoring](./monitoring/README.md)).

To rotate a secret, `gh secret set NAME --env <env>` and run the deploy again. Rotating
`JWT_SECRET` signs every shopper out.

## First-time setup

1. **VM** (each environment): Ubuntu 24.04 or similar with Docker Engine and the Compose plugin.
   Open only 22, 80 and 443. Create a deploy user in the `docker` group. That group is
   root-equivalent, so the user should have no other use.
2. **DNS**: point `API_DOMAIN` and `CHAT_DOMAIN` at the VM. Caddy gets the certificates on the
   first deploy.
3. **Datastores**: for production, use managed Postgres 16 and Redis with backups. Bundled
   containers (`BUNDLED_DATASTORES=true`) are fine for staging; their data lives in Docker volumes
   on the VM, without backups.
4. **Environments and secrets**: `infra/setup-github-env.sh staging`, then `… production`. Add
   the printed public key to the deploy user's `~/.ssh/authorized_keys`.
   Required reviewers on a private repo need a paid GitHub plan. Without one, the environment
   still limits deploys to `main`, but nobody has to approve.
5. **Branch protection on `main`**: require the `commerce-api`, `agent-service` and `widget`
   checks (including evals). Staging deploys whatever lands on `main`, so this is the gate.
6. **Packages**: after the first staging build, the GHCR packages appear under the repo.
   Keep them private. The deploy pulls with the job's own `GITHUB_TOKEN`.

## Day to day

- **Staging**: merge to `main`.
- **Production**: Actions → deploy-production → Run workflow. Leave the SHA blank to promote the
  latest staging deploy. A reviewer then approves the `production` job.
- **Rollback**: run deploy-production with an earlier SHA. Migrations aren't rolled back, so
  they must stay backward compatible: add columns or tables, and drop them in a later release.
- **Logs on the VM**: `cd ~/shop && docker compose logs -f agent-service`.
- **Seed data** never runs here (`seed` refuses `NODE_ENV=production`).

## Known gaps

- One VM per environment: a deploy restarts containers in place (seconds of downtime) and
  nothing is redundant. Fine for the staff and 5% rollout steps; revisit before 100%.
- The smoke test doesn't call the model or check that the service token works (agent-service
  `/health` checks only that commerce-api is reachable; see NOTES.md).
- Images are tagged by SHA and pinned by digest at deploy time, but not signed.
