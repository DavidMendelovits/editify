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
  --submit-selector '[aria-label="sign in"]' >/dev/null
"$AB" auth login editify-qa
"$AB" auth delete editify-qa >/dev/null 2>&1 || true

# Hard gate: the run must not continue on a video that merely looks signed in.
for i in $(seq 1 20); do
  state=$("$AB" eval '(()=>{const t=document.body.innerText;return t.includes("sign out")?"in":(t.includes("password")?"form":"other")})()' 2>/dev/null | tr -d '"')
  [[ "$state" == "in" ]] && { echo "signed in as $EMAIL (verified: 'sign out' rendered, sign-in form gone)"; exit 0; }
  sleep 2
done
echo "LOGIN FAILED — page state is '$state' after 40s. Do not record or open a PR claiming a signed-in demo." >&2
"$AB" screenshot .bot/login-failed.png >/dev/null 2>&1 || true
exit 1
