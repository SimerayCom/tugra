#!/usr/bin/env bash
# L13: discovery against a Coolify 4.1.2 shaped like the real estate (coolify-fleet.mjs: invented names, no real instance). A mock
# API on the docker host address serves eight teams with one read-only token each, an UNFILTERED /teams, 78 apps, 29 databases, 19
# services and 24 servers with comma-list `fqdn`s and service sub-apps on :8080. For every team token the hub must connect, and its
# import plan must count exactly that team's applications and databases (a token's scope is the token, never /teams), with every
# item named after the team. This is the CI part of the "pinned 4.1.2 lab instance" row; the real instance is the Tier B step 1
# of the runbook (the mock cannot tell what a real 4.1.2 does, only that the hub reads the shape the owner's inventory shows).
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

PORT="${L13_PORT:-4010}"
lab_guard_destructive
lab_load
MOCK_PID_FILE="$LAB_DIR/coolify-mock.pid"
stop_mock() { [ ! -f "$MOCK_PID_FILE" ] || { kill "$(cat "$MOCK_PID_FILE")" 2>/dev/null || true; rm -f "$MOCK_PID_FILE"; }; }
trap stop_mock EXIT

summary="$(node "$LAB_SELF_DIR/coolify-mock.mjs" --summary)"
tok0="$(node -e 'console.log(JSON.parse(process.argv[1])[0].token)' "$summary")"
node "$LAB_SELF_DIR/coolify-mock.mjs" --listen "$PORT" --bind 0.0.0.0 2>>"$LAB_DIR/coolify-mock.log" &
echo $! >"$MOCK_PID_FILE"
lab_wait 20 "the Coolify mock on :$PORT" curl -fsS -H "Authorization: Bearer $tok0" "http://127.0.0.1:${PORT}/api/v1/version"
BASE="http://${LAB_HOST}:${PORT}"
lab_log "mock Coolify at $BASE (version $(curl -fsS -H "Authorization: Bearer $tok0" "http://127.0.0.1:${PORT}/api/v1/version"))"

lab_check "/teams is unfiltered: a team 0 token lists all 8 teams" test "$(curl -fsS -H "Authorization: Bearer $tok0" "http://127.0.0.1:${PORT}/api/v1/teams" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).length)')" = 8

: >"$LAB_DIR/l13.summary"
node -e 'for (const t of JSON.parse(process.argv[1])) console.log(`${t.index} ${t.token} ${t.apps} ${t.databases} ${t.services}`)' "$summary" |
while read -r idx tok apps dbs svcs; do
  sid="$(lab_api POST /import/connect "{\"sourceKind\":\"coolify\",\"teamId\":\"$TEAM_ID\",\"baseUrl\":\"$BASE\",\"token\":\"$tok\",\"scopeLabel\":\"lab-team-$idx\"}" | node "$LAB_SELF_DIR/jget.mjs" sessionId)"
  [ -n "$sid" ] || lab_die "team $idx: no session id"
  plan="$(lab_api POST /import/plan "{\"sourceKind\":\"coolify\",\"sessionId\":\"$sid\"}")"
  printf '%s' "$plan" >"$LAB_DIR/l13.plan.$idx.json"
  got_apps="$(printf '%s' "$plan" | node "$LAB_SELF_DIR/jget.mjs" totals.apps || echo 0)"
  got_dbs="$(printf '%s' "$plan" | node "$LAB_SELF_DIR/jget.mjs" totals.databases || echo 0)"
  lab_log "team $idx: plan counts $got_apps apps, $got_dbs databases (token scope: $apps apps, $dbs databases, $svcs services)"
  lab_check "team $idx: the plan counts the token's applications ($apps)" test "$got_apps" = "$apps"
  lab_check "team $idx: the plan counts the token's databases ($dbs)" test "$got_dbs" = "$dbs"
  lab_check "team $idx: every application and database item is named after the team (no other team's resource leaked in)" \
    node -e 'const p=JSON.parse(process.argv[1]); const bad=p.items.filter(i=>(i.kind==="app"||i.kind==="database")&&!i.name.startsWith(`t${process.argv[2]}-`)); process.exit(bad.length?1:0)' "$plan" "$idx"
  echo "L13_TEAM_$idx apps=$got_apps databases=$got_dbs items=$(printf '%s' "$plan" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).items.length)')" >>"$LAB_DIR/l13.summary"
done

if lab_api POST /import/connect "{\"sourceKind\":\"coolify\",\"teamId\":\"$TEAM_ID\",\"baseUrl\":\"$BASE\",\"token\":\"9|not-a-token\"}" >/dev/null 2>&1; then
  lab_die "a token the Coolify API answers 401 to was accepted as a connection"
fi
lab_pass "L13 discovery against a Coolify 4.1.2 shaped like the real estate: 8 team tokens, scoped by token"
