#!/usr/bin/env bash
# Start the assessment platform locally with .env loaded.
#
# The server itself does NOT use dotenv — server/index.js reads process.env
# directly — so `node server/index.js` on its own silently ignores .env and
# leaves EXTENSION_API_KEY empty, which makes every /api/integrations/* call
# fail auth. This script exports .env first, so the machine-to-machine surface
# the Recruitment Manager depends on actually works.
#
#   ./start-local.sh
set -euo pipefail
cd "$(dirname "$0")"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

echo "assessment platform → http://localhost:${ASSESSMENT_PORT:-8124}"
# Report only whether the key is present — never its value.
if [ -n "${EXTENSION_API_KEY:-}" ]; then
  echo "  EXTENSION_API_KEY: set (${#EXTENSION_API_KEY} chars)"
else
  echo "  EXTENSION_API_KEY: UNSET — /api/integrations/* will 401"
fi

# better-sqlite3 here is a native module built for Node 22. Running under an
# older node fails with ERR_DLOPEN_FAILED / NODE_MODULE_VERSION mismatch, so
# prefer a v22 from nvm when the current node is older.
NODE_BIN="node"
MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$MAJOR" -lt 20 ]; then
  CAND="$(ls -d "$HOME"/.nvm/versions/node/v2*/bin/node 2>/dev/null | sort -V | tail -1 || true)"
  if [ -n "$CAND" ]; then
    NODE_BIN="$CAND"
    echo "  node: $("$NODE_BIN" -v) (current shell is $(node -v), too old for better-sqlite3)"
  else
    echo "  WARNING: node $(node -v) is too old for this build of better-sqlite3 and no v2x found via nvm."
  fi
fi

exec "$NODE_BIN" server/index.js
