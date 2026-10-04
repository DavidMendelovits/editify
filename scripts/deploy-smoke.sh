#!/usr/bin/env bash
# Post-deploy smoke (plan C13), run by ci.yml's deploy job right after
# `flyctl deploy`, from the repo root of the deployed checkout. One script for
# both lines, so main and release/1.1 carry the same file.
#
#   URL      the app's public URL, e.g. https://editify-dm.fly.dev (required)
#   APP      the Fly app, for the secrets check (required)
#   CONFIG   its fly config, where SUPABASE_URL is read from (default fly.toml)
#   LINE     when set, /health must name this line ...
#   COMMIT   ... and this commit (the 1.1 line's /health carries both)
#   SMOKE_EMAIL, SMOKE_PASSWORD
#            a dedicated Supabase smoke user (repo secrets). When both are set,
#            the smoke signs in and checks the authenticated routes; when not,
#            it warns and skips them.
#   FLY_API_TOKEN  for `flyctl secrets list` (the deploy token)
#
# Nothing secret is printed: the password goes to curl on stdin, the access
# token is masked before use, and the secrets check reads names only.
set -euo pipefail

: "${URL:?URL is required}" "${APP:?APP is required}"
CONFIG=${CONFIG:-fly.toml}
fail() { echo "::error::$*"; exit 1; }
warn() { echo "::warning::$*"; }

# 1. /health: retried with backoff while the new machines start (about 6 minutes in all).
want="ok=true${LINE:+, line=$LINE}${COMMIT:+, commit=$COMMIT}"
body=''
for attempt in $(seq 1 20); do
  body=$(curl -fsS --max-time 10 "$URL/health" 2>/dev/null || true)
  if jq -e --arg line "${LINE:-}" --arg commit "${COMMIT:-}" \
      '.ok == true and ($line == "" or .line == $line) and ($commit == "" or .commit == $commit)' \
      >/dev/null 2>&1 <<<"$body"; then
    echo "$URL/health ($want): $body"; break
  fi
  [ "$attempt" = 20 ] && fail "$URL/health never answered $want: ${body:-no response}"
  delay=$((attempt * 5 < 30 ? attempt * 5 : 30))
  echo "Attempt $attempt: /health not yet $want; retrying in ${delay}s"
  sleep "$delay"
done

# 2. /client-config, the app's update gate. Required wherever the checkout has
# the route; a line that has not merged it yet (release/1.1 before main's #141
# flows forward) only warns, and starts failing on its own once it has.
config_file=$(mktemp)
config_status=$(curl -sS --max-time 10 -o "$config_file" -w '%{http_code}' "$URL/client-config" || echo 000)
if [ "$config_status" = 200 ] && jq -e '
    (.minVersion | type == "string" and test("^[0-9]+(\\.[0-9]+){0,2}$")) and
    (.latestVersion | type == "string" and test("^[0-9]+(\\.[0-9]+){0,2}$")) and
    (.storeUrl | type == "string" and test("^https?://")) and
    (.minOs | type == "string" and test("^[0-9]+(\\.[0-9]+){0,2}$"))' "$config_file" >/dev/null; then
  echo "$URL/client-config: $(cat "$config_file")"
elif [ ! -f server/src/routes/client-config.ts ] && [ "$config_status" = 404 ]; then
  warn "$URL/client-config is 404: this line has no /client-config route yet (it arrives when main merges forward)."
else
  fail "$URL/client-config answered $config_status without minVersion, latestVersion, storeUrl and minOs: $(head -c 300 "$config_file" 2>/dev/null)"
fi

# 3. A protected route still demands credentials.
status=$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' -H 'Accept: application/json' "$URL/projects" || echo 000)
[ "$status" = 401 ] || fail "GET $URL/projects without credentials answered $status, not 401"
echo "GET $URL/projects without credentials: 401"

# 4. Signed in as the smoke user: the same Supabase sign-in the app does.
if [ -z "${SMOKE_EMAIL:-}" ] || [ -z "${SMOKE_PASSWORD:-}" ]; then
  warn "SMOKE_EMAIL / SMOKE_PASSWORD are not set: skipped the signed-in checks (GET /projects, /sync/projects)."
else
  supabase_url=$(sed -nE 's/^[[:space:]]*SUPABASE_URL[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' "$CONFIG" | head -1)
  # The publishable key is public: the app ships it (apps/mobile/src/lib/supabase.ts).
  supabase_key=$(grep -oE "sb_publishable_[A-Za-z0-9_-]+" apps/mobile/src/lib/supabase.ts | head -1)
  [ -n "$supabase_url" ] || fail "$CONFIG sets no SUPABASE_URL"
  [ -n "$supabase_key" ] || fail "apps/mobile/src/lib/supabase.ts has no publishable key"
  session=$(jq -n --arg email "$SMOKE_EMAIL" --arg password "$SMOKE_PASSWORD" '{email: $email, password: $password}' |
    curl -sS --max-time 15 -X POST "$supabase_url/auth/v1/token?grant_type=password" \
      -H "apikey: $supabase_key" -H 'Content-Type: application/json' --data-binary @- || true)
  token=$(jq -r '.access_token // empty' <<<"$session" 2>/dev/null || true)
  if [ -z "$token" ]; then
    reason=$(jq -r '.error_description // .msg // .error // "no response"' <<<"$session" 2>/dev/null || echo 'unreadable response')
    fail "The smoke user could not sign in to Supabase: $reason"
  fi
  echo "::add-mask::$token"
  unset session
  status=$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $token" "$URL/projects" || echo 000)
  [ "$status" = 200 ] || fail "GET $URL/projects as the smoke user answered $status, not 200"
  echo "GET $URL/projects as the smoke user: 200"
  # /health says whether this app has Postgres project sync (DATABASE_URL) without naming anything about it.
  if [ "$(jq -r '.sync // false' <<<"$body")" = true ]; then
    status=$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $token" "$URL/sync/projects" || echo 000)
    [ "$status" = 200 ] || fail "GET $URL/sync/projects as the smoke user answered $status, not 200"
    echo "GET $URL/sync/projects as the smoke user: 200"
  else
    echo "$APP has no Postgres sync (/health sync is not true): skipped GET /sync/projects."
  fi
fi

# 5. Secrets parity: the names every line's app needs (values are never read).
# Missing names warn for now, since editify-v11 is still being provisioned.
# To make them fail the deploy, set STRICT_SECRETS: '1' on the deploy job's
# smoke step in ci.yml (or flip the default below to 1).
required=(SUPABASE_SERVICE_ROLE_KEY GITHUB_TOKEN EDITIFY_TOKEN ANTHROPIC_API_KEY)
if names=$(flyctl secrets list -a "$APP" --json 2>/dev/null | jq -r '.[] | (.name // .Name)'); then
  missing=()
  for name in "${required[@]}"; do grep -qx "$name" <<<"$names" || missing+=("$name"); done
  if [ "${#missing[@]}" -eq 0 ]; then
    echo "$APP has every required secret: ${required[*]}"
  elif [ "${STRICT_SECRETS:-0}" = 1 ]; then
    fail "$APP is missing secrets: ${missing[*]} (fly secrets set NAME=... -a $APP)"
  else
    warn "$APP is missing secrets: ${missing[*]} (fly secrets set NAME=... -a $APP)"
  fi
else
  warn "Could not list $APP's secrets with this token: skipped the secrets check."
fi
