#!/usr/bin/env bash
# Exit gate for one rollout step (ARCHITECTURE.md §12, infra/monitoring/README.md#rollout).
# Run it from your machine at the end of a step's watch window:
#
#   infra/rollout-check.sh deploy@prod-vm            # last 2 days
#   infra/rollout-check.sh deploy@prod-vm 3          # last 3 days
#
# Read-only. Over SSH it queries the VM's Postgres (bundled container or DATABASE_URL, whichever
# the VM's .env says) for cross-user rows and duplicate returns, then downloads a sample of masked
# transcripts to a private temp dir for review. With PROM_URL set it also checks the tool error
# rate:
#
#   PROM_URL=https://prometheus-prod-<n>.grafana.net/api/prom  PROM_AUTH=<instanceId>:<token>
#
# Optional: TRANSCRIPTS (default 20), PROM_JOB (default production/agent-service).
# With PROM_URL it also gates photos (PLAN-20) and voice (PLAN-21) while they're on.
# Exit 0 = gate passed, 1 = a check failed, 2 = tool error rate not checked (no PROM_URL).
# It never changes the rollout flag; that stays a manual `SET flag:rollout_percent`.
set -euo pipefail

target=${1:?usage: rollout-check.sh <user@vm> [days]}
days=${2:-2}
[[ $days =~ ^[1-9][0-9]?$ ]] || { echo "days must be 1-99" >&2; exit 1; }
sample=${TRANSCRIPTS:-20}
[[ $sample =~ ^[1-9][0-9]{0,2}$ ]] || { echo "TRANSCRIPTS must be 1-999" >&2; exit 1; }
job=${PROM_JOB:-production/agent-service}
for cmd in ssh jq; do
  command -v "$cmd" >/dev/null || { echo "needs $cmd" >&2; exit 1; }
done

# Runs on the VM: psql against the same database commerce-api uses. SQL comes on stdin.
# DATABASE_URL is passed to the container by name, so it never appears on a command line.
read -r -d '' remote_psql <<'EOF' || true
set -euo pipefail
cd ~/shop
bundled=$(set -a; . ./.env; echo "${BUNDLED_DATASTORES:-false}")
args=(-X -q -At -v ON_ERROR_STOP=1)
if [ "$bundled" = true ]; then
  docker compose -f compose.yml --profile datastores exec -T postgres psql -U shop -d shop "${args[@]}"
else
  (set -a; . ./.env; docker run --rm -i -e DATABASE_URL postgres:16-alpine \
    sh -c 'psql "$DATABASE_URL" "$@"' sh "${args[@]}")
fi
EOF
sql() { ssh "$target" "bash -c $(printf %q "$remote_psql")"; }

since="now() - interval '$days days'"
fail=0
skipped=0

# check <name> <sql returning one line per offending row>
check() {
  local name=$1 rows
  rows=$(sql <<<"$2")
  if [ -z "$rows" ]; then
    echo "ok   $name"
  else
    echo "FAIL $name ($(wc -l <<<"$rows") rows)"
    sed 's/^/     /' <<<"$rows" | head -20
    fail=1
  fi
}

# prom <query>: the first value of an instant query, or empty when there's no data.
# Credentials go in through a curl config on stdin, not argv.
prom() {
  printf 'user = "%s"\n' "${PROM_AUTH:-}" \
    | curl -fsS --max-time 20 -K - --data-urlencode "query=$1" "$PROM_URL/api/v1/query" \
    | jq -r '.data.result[0].value[1] // empty'
}

echo "Rollout gate for $target, last $days days"

# --- Tool error rate < 5% ------------------------------------------------------------------
# Store failures only (status="error"); "rejected" (not found, login needed) is expected.
if [ -n "${PROM_URL:-}" ]; then
  command -v curl >/dev/null || { echo "needs curl" >&2; exit 1; }
  rate=$(prom "sum(increase(agent_tool_calls_total{job=\"$job\",status=\"error\"}[${days}d]))
     / sum(increase(agent_tool_calls_total{job=\"$job\"}[${days}d]))")
  if [ -z "$rate" ] || [ "$rate" = NaN ]; then
    echo "FAIL tool error rate: no data for job=$job"
    fail=1
  elif awk -v r="$rate" 'BEGIN { exit !(r < 0.05) }'; then
    printf 'ok   tool error rate %.2f%%\n' "$(awk -v r="$rate" 'BEGIN { print r * 100 }')"
  else
    printf 'FAIL tool error rate %.2f%% (gate < 5%%)\n' "$(awk -v r="$rate" 'BEGIN { print r * 100 }')"
    fail=1
  fi
else
  echo "skip tool error rate (set PROM_URL, or read the dashboard's Tool error rate panel)"
  skipped=1
fi

# --- Photos (PLAN-20): describe failures < 5% ---------------------------------------------
# Only while photos are on; no photos described in the window is fine.
if [ -n "${PROM_URL:-}" ]; then
  rate=$(prom "sum(increase(agent_images_total{job=\"$job\",outcome=~\"failed|unparsed\"}[${days}d]))
     / sum(increase(agent_images_total{job=\"$job\"}[${days}d]))")
  if [ -z "$rate" ] || [ "$rate" = NaN ]; then
    echo "ok   photos: none described"
  elif awk -v r="$rate" 'BEGIN { exit !(r < 0.05) }'; then
    printf 'ok   photo describe failures %.2f%%\n' "$(awk -v r="$rate" 'BEGIN { print r * 100 }')"
  else
    printf 'FAIL photo describe failures %.2f%% (gate < 5%%; SET flag:images_enabled 0)\n' \
      "$(awk -v r="$rate" 'BEGIN { print r * 100 }')"
    fail=1
  fi
fi

# --- Voice (PLAN-21): thumbs-up for voice no more than 10 points below typed ---------------
# Needs 30+ rated replies to dictated messages; fewer is too little to judge.
if [ -n "${PROM_URL:-}" ]; then
  rated() { prom "sum(increase(agent_feedback_total{job=\"$job\",via=\"$1\"$2}[${days}d]))"; }
  voice_all=$(rated voice '')
  if [ -z "$voice_all" ] || awk -v n="$voice_all" 'BEGIN { exit !(n < 30) }'; then
    printf 'ok   voice: %.0f rated voice replies (too few to compare)\n' "${voice_all:-0}"
  else
    voice_up=$(awk -v u="$(rated voice ',rating="up"')" -v n="$voice_all" 'BEGIN { print (u + 0) / n }')
    typed_all=$(rated typed '')
    typed_up=$(awk -v u="$(rated typed ',rating="up"')" -v n="${typed_all:-0}" \
      'BEGIN { print (n > 0 ? (u + 0) / n : 1) }')
    line=$(awk -v v="$voice_up" -v t="$typed_up" \
      'BEGIN { printf "thumbs-up voice %.0f%% vs typed %.0f%%", v * 100, t * 100 }')
    if awk -v v="$voice_up" -v t="$typed_up" 'BEGIN { exit !(v >= t - 0.10) }'; then
      echo "ok   $line"
    else
      echo "FAIL $line (gate: within 10 points; SET flag:voice_rollout_percent back, or flag:voice_enabled 0)"
      fail=1
    fi
  fi
fi

# --- No cross-user issues ------------------------------------------------------------------
check "returns filed by the order's owner" "
  SELECT r.id || '  order ' || o.order_number FROM return_requests r JOIN orders o ON o.id = r.order_id
   WHERE r.user_id <> o.user_id AND r.created_at > $since;"

check "agent actions match the conversation's shopper" "
  SELECT l.id || '  ' || l.action || '  conv ' || l.conversation_id
    FROM agent_action_logs l JOIN conversations c ON c.id::text = l.conversation_id
   WHERE l.user_id <> c.user_id AND l.created_at > $since;"

# --- No duplicate returns ------------------------------------------------------------------
check "no duplicate returns" "
  SELECT o.order_number || '  x' || count(*) FROM return_requests r JOIN orders o ON o.id = r.order_id
   WHERE r.created_at > $since GROUP BY o.order_number, r.items HAVING count(*) > 1;"

# --- Transcripts to review -----------------------------------------------------------------
# Thumbs-down first, then handoffs, then random. Already masked by agent-service, but still
# shopper conversations: kept in a private temp dir, outside the repo.
out=$(mktemp -d "${TMPDIR:-/tmp}/rollout-review.XXXXXX")
chmod 700 "$out"
file="$out/transcripts.jsonl"
(umask 077 && sql >"$file" <<SQL
SELECT row_to_json(t) FROM (
  SELECT id, created_at, outcome, summary, feedback, messages,
         EXISTS (SELECT 1 FROM jsonb_array_elements(feedback) f WHERE f->>'rating' = 'down') AS down
    FROM conversations WHERE created_at > $since
   ORDER BY down DESC, (outcome = 'handoff') DESC NULLS LAST, random()
   LIMIT $sample) t;
SQL
)
n=$(wc -l <"$file")
echo "     $n transcripts → $file"
jq -r '[.id[0:8], (.outcome // "-"), (if .down then "thumbs-down" else "" end),
        ((.summary // "") | gsub("\n"; " ") | .[0:80])] | @tsv' "$file" | sed 's/^/       /'
echo "     Add failures to agent-service/evals/golden/ (seed data, not the shopper's),"
echo "     then delete the dir: rm -r $out"

if [ $fail -ne 0 ]; then
  echo "Gate FAILED: roll back with DEL flag:rollout_percent (infra/monitoring/README.md#rollout)"
  exit 1
fi
if [ $skipped -ne 0 ]; then
  echo "SQL checks passed; tool error rate not checked"
  exit 2
fi
echo "Gate passed (after the transcript review)"
