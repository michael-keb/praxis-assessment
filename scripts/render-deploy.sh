#!/usr/bin/env bash
# Trigger and watch a production deploy on Render.
#
#   ./scripts/render-deploy.sh list            # show services
#   ./scripts/render-deploy.sh deploy <srv-id> # trigger deploy + follow status
#   ./scripts/render-deploy.sh status <srv-id> # recent deploys
#
# Reads RENDER_API_KEY from .env (gitignored).
set -euo pipefail
cd "$(dirname "$0")/.."

set -a; . ./.env; set +a
: "${RENDER_API_KEY:?RENDER_API_KEY missing from .env}"

api() {
  curl -s --max-time 30 -H "Authorization: Bearer $RENDER_API_KEY" \
    -H "Content-Type: application/json" "$@"
}

cmd="${1:-list}"
srv="${2:-}"

case "$cmd" in
  list)
    api "https://api.render.com/v1/services?limit=20" | python3 -c '
import json,sys
for it in json.load(sys.stdin):
    s=it["service"]
    d=s.get("serviceDetails",{})
    print(s["id"], "|", s["name"], "|", s.get("type"), "| suspended:", s.get("suspended"),
          "| autoDeploy:", d.get("autoDeploy", s.get("autoDeploy")), "|", d.get("url",""))'
    ;;
  status)
    api "https://api.render.com/v1/services/$srv/deploys?limit=5" | python3 -c '
import json,sys
for it in json.load(sys.stdin):
    d=it["deploy"]
    c=d.get("commit") or {}
    print(d["id"], "|", d.get("status"), "|", d.get("createdAt"), "|", (c.get("id") or "")[:9], (c.get("message") or "").splitlines()[0][:60] if c.get("message") else "")'
    ;;
  deploy)
    out=$(api -X POST "https://api.render.com/v1/services/$srv/deploys" -d '{}')
    echo "$out" | python3 -c '
import json,sys
d=json.load(sys.stdin)
print("deploy id:", d.get("id"), "status:", d.get("status"))'
    ;;
  *)
    echo "unknown command: $cmd" >&2; exit 1;;
esac
