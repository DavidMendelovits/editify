#!/usr/bin/env bash
# Sign the agent-browser session in as the QA user without the password ever entering a model context.
# The password flows from ~/.config/editify-qa/credentials.json into agent-browser's auth vault over stdin.
# Usage: qa-login.sh [web-url]   (default http://localhost:8090)
set -euo pipefail
AB=${AGENT_BROWSER:-$HOME/.nvm/versions/node/v24.8.0/bin/agent-browser}
URL=${1:-http://localhost:8090}
CREDS=$HOME/.config/editify-qa/credentials.json
[[ -f "$CREDS" ]] || { echo "missing $CREDS" >&2; exit 1; }
EMAIL=$(python3 -c "import json;print(json.load(open('$CREDS'))['email'])")
python3 -c "import json;print(json.load(open('$CREDS'))['password'],end='')" | "$AB" auth save editify-qa \
  --url "$URL/sign-in" --username "$EMAIL" --password-stdin \
  --username-selector 'input[aria-label="email"]' --password-selector 'input[aria-label="password"]' \
  --submit-selector '[role=button]' >/dev/null
"$AB" auth login editify-qa
"$AB" auth delete editify-qa >/dev/null 2>&1 || true
echo "signed in as $EMAIL"
