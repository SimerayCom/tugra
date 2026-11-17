#!/usr/bin/env bash
# L13: discovery against a Coolify shaped like the real estate (coolify-fleet.mjs: invented names, no real instance), in two profiles.
# A mock API on the docker host address serves eight teams with one token each, an UNFILTERED /teams, 78 apps, 29 databases, 19
# services and 24 servers with comma-list `fqdn`s and service sub-apps on :8080. For every team token the hub must connect, and its
# import plan must count exactly that team's applications and databases (a token's scope is the token, never /teams), with every
# item named after the team.
#   4.1.2  the version the owner's inventory was taken on (GET-only API, full rows)
#   4.7.5  list rows without members or sensitive fields, settings nested on the detail GET, POST start/stop (400 "already
#          stopped/running", GET answers 405), a per-user 429 with Retry-After, and application containers named
#          `<uuid>-YYYYMMDDTHHMMSS`. After discovery the scenario names a RUNNING source container after the first application
#          of team 0 in that form and runs the volume copy against it: the migrator must resolve it, see it running (dry run),
#          stop it (--stop-source) and copy its volume. A burst against a second mock with a small budget proves the 429.
# L13_RATE_LIMIT sets the 4.7.5 discovery mock's per-minute budget (default 0 = no 429, so the discovery plan does not depend on the
# importer's Retry-After handling; 200 is the real default and makes the discovery run face the throttle).
# This is the CI part of the "pinned lab instance" rows; the real instance is the Tier B step 1 of the runbook (the mock cannot tell what
# a real Coolify does, only that the hub reads the shape the owner's inventory and the 4.7.5 source show).
set -euo pipefail
# shellcheck source=fleet.sh
. "$(dirname "${BASH_SOURCE[0]}")/fleet.sh"

PORT="${L13_PORT:-4010}"
lab_guard_destructive
lab_load
MOCK_PID_FILE="$LAB_DIR/coolify-mock.pid"
# stop_pid <pid>: kill it and wait until it is gone, so the next mock can bind the same port
stop_pid() { local i; kill "$1" 2>/dev/null || return 0; for i in $(seq 1 50); do kill -0 "$1" 2>/dev/null || return 0; sleep 0.1; done; kill -9 "$1" 2>/dev/null || true; }
stop_mock() { [ ! -f "$MOCK_PID_FILE" ] || { stop_pid "$(cat "$MOCK_PID_FILE")"; rm -f "$MOCK_PID_FILE"; }; }
trap stop_mock EXIT
: >"$LAB_DIR/l13.summary"

# code <method> <path> <token> [port]: the HTTP status only (curl -f would hide the 4xx the profile is about); body: the same call's body
code() { curl -sS -o /dev/null -w '%{http_code}' -X "$1" -H "Authorization: Bearer $3" "http://127.0.0.1:${4:-$PORT}/api/v1$2"; }
body() { curl -sS -X "$1" -H "Authorization: Bearer $3" "http://127.0.0.1:${4:-$PORT}/api/v1$2"; }
# jchk <json> <js expression over j>: true when the expression holds
jchk() { node -e 'const j=JSON.parse(process.argv[1]); process.exit(eval(process.argv[2]) ? 0 : 1)' "$1" "$2"; }
first() { node -e 'const a=JSON.parse(require("fs").readFileSync(0,"utf8")); console.log(process.argv[1]==="json"?JSON.stringify(a[0]):a[0].uuid)' "$1"; }

discover_profile() { # <profile> [mock args...]
  local profile="$1"; shift
  stop_mock
  local summary tok0
  summary="$(node "$LAB_SELF_DIR/coolify-mock.mjs" --summary --profile "$profile")"
  tok0="$(node -e 'console.log(JSON.parse(process.argv[1])[0].token)' "$summary")"
  node "$LAB_SELF_DIR/coolify-mock.mjs" --listen "$PORT" --bind 0.0.0.0 --profile "$profile" "$@" 2>>"$LAB_DIR/coolify-mock.log" &
  echo $! >"$MOCK_PID_FILE"
  lab_wait 20 "the Coolify $profile mock on :$PORT" curl -fsS -H "Authorization: Bearer $tok0" "http://127.0.0.1:${PORT}/api/v1/version"
  BASE="http://${LAB_HOST}:${PORT}"
  lab_log "mock Coolify at $BASE (version $(curl -fsS -H "Authorization: Bearer $tok0" "http://127.0.0.1:${PORT}/api/v1/version"))"
  lab_check "the mock answers as Coolify $profile" test "$(curl -fsS -H "Authorization: Bearer $tok0" "http://127.0.0.1:${PORT}/api/v1/version")" = "$profile"
  lab_check "/teams is unfiltered: a team 0 token lists all 8 teams" test "$(curl -fsS -H "Authorization: Bearer $tok0" "http://127.0.0.1:${PORT}/api/v1/teams" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).length)')" = 8

  node -e 'for (const t of JSON.parse(process.argv[1])) console.log(`${t.index} ${t.token} ${t.apps} ${t.databases} ${t.services}`)' "$summary" |
  while read -r idx tok apps dbs svcs; do
    sid="$(lab_api POST /import/connect "{\"sourceKind\":\"coolify\",\"teamId\":\"$TEAM_ID\",\"baseUrl\":\"$BASE\",\"token\":\"$tok\",\"scopeLabel\":\"lab-$profile-team-$idx\"}" | node "$LAB_SELF_DIR/jget.mjs" sessionId)"
    [ -n "$sid" ] || lab_die "$profile team $idx: no session id"
    plan="$(lab_api POST /import/plan "{\"sourceKind\":\"coolify\",\"sessionId\":\"$sid\"}")"
    printf '%s' "$plan" >"$LAB_DIR/l13.plan.$profile.$idx.json"
    got_apps="$(printf '%s' "$plan" | node "$LAB_SELF_DIR/jget.mjs" totals.apps || echo 0)"
    got_dbs="$(printf '%s' "$plan" | node "$LAB_SELF_DIR/jget.mjs" totals.databases || echo 0)"
    lab_log "$profile team $idx: plan counts $got_apps apps, $got_dbs databases (token scope: $apps apps, $dbs databases, $svcs services)"
    lab_check "$profile team $idx: the plan counts the token's applications ($apps)" test "$got_apps" = "$apps"
    lab_check "$profile team $idx: the plan counts the token's databases ($dbs)" test "$got_dbs" = "$dbs"
    lab_check "$profile team $idx: every application and database item is named after the team (no other team's resource leaked in)" \
      node -e 'const p=JSON.parse(process.argv[1]); const bad=p.items.filter(i=>(i.kind==="app"||i.kind==="database")&&!i.name.startsWith(`t${process.argv[2]}-`)); process.exit(bad.length?1:0)' "$plan" "$idx"
    echo "L13_${profile}_TEAM_$idx apps=$got_apps databases=$got_dbs items=$(printf '%s' "$plan" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).items.length)')" >>"$LAB_DIR/l13.summary"
  done

  if lab_api POST /import/connect "{\"sourceKind\":\"coolify\",\"teamId\":\"$TEAM_ID\",\"baseUrl\":\"$BASE\",\"token\":\"9|not-a-token\"}" >/dev/null 2>&1; then
    lab_die "a token the Coolify $profile API answers 401 to was accepted as a connection"
  fi
  PROFILE_SUMMARY="$summary"; PROFILE_TOKEN="$tok0"
}

# ---- 4.1.2 -----------------------------------------------------------------------------------------------------------------------
discover_profile 4.1.2
lab_check "4.1.2: a start is not an API call (GET-only)" test "$(code POST "/applications/x/start" "$PROFILE_TOKEN")" = 405

# ---- 4.7.5 -----------------------------------------------------------------------------------------------------------------------
discover_profile 4.7.5 --rate-limit "${L13_RATE_LIMIT:-0}"
T="$PROFILE_TOKEN"
APP0="$(node -e 'console.log(JSON.parse(process.argv[1])[0].firstApp.uuid)' "$PROFILE_SUMMARY")"
ISO_NAME="$(node -e 'console.log(JSON.parse(process.argv[1])[0].firstApp.container)' "$PROFILE_SUMMARY")"
DB0="$(body GET /databases "$T" | first uuid)"
SVC0="$(body GET /services "$T" | first uuid)"
lab_check "4.7.5: a service LIST row has no members, server or compose" jchk "$(body GET /services "$T" | first json)" 'j.applications===undefined&&j.databases===undefined&&j.server===undefined&&j.docker_compose_raw===undefined'
lab_check "4.7.5: the service DETAIL carries the members" jchk "$(body GET "/services/$SVC0" "$T")" 'Array.isArray(j.applications)&&j.applications.length>0&&j.docker_compose_raw===undefined'
LISTED_APP="$(body GET /applications "$T" | first json)"
DETAIL_APP="$(body GET "/applications/$APP0" "$T")"
lab_check "4.7.5: an application LIST row has no settings" jchk "$LISTED_APP" 'j.settings===undefined&&j.is_static===undefined'
lab_check "4.7.5: the application DETAIL nests the settings" jchk "$DETAIL_APP" 'j.settings&&"is_static" in j.settings&&"custom_container_name_prefix" in j.settings'
lab_check "4.7.5: GET start answers 405 (POST only)" test "$(code GET "/applications/$APP0/start" "$T")" = 405
lab_check "4.7.5: POST stop of a running database is queued" test "$(code POST "/databases/$DB0/stop" "$T")" = 200
lab_check "4.7.5: POST stop of a stopped database is 400 (already stopped)" test "$(code POST "/databases/$DB0/stop" "$T")" = 400
lab_check "4.7.5: POST start of the stopped database is queued" test "$(code POST "/databases/$DB0/start" "$T")" = 200
lab_check "4.7.5: POST start of a running database is 400 (already running)" test "$(code POST "/databases/$DB0/start" "$T")" = 400

# the 429: a second mock with a budget of 5 requests a minute; the 6th answers 429 with a Retry-After the client can honour
BURST_PORT=$((PORT + 1))
node "$LAB_SELF_DIR/coolify-mock.mjs" --listen "$BURST_PORT" --bind 127.0.0.1 --profile 4.7.5 --rate-limit 5 2>>"$LAB_DIR/coolify-mock.log" &
BURST_PID=$!
trap 'stop_pid "$BURST_PID"; stop_mock' EXIT
lab_wait 20 "the burst mock on :$BURST_PORT" curl -sS -o /dev/null "http://127.0.0.1:${BURST_PORT}/api/v1/version"
for _ in 1 2 3 4 5; do code GET /servers "$T" "$BURST_PORT" >/dev/null; done
BURST_REPLY="$(curl -sS -i -H "Authorization: Bearer $T" "http://127.0.0.1:${BURST_PORT}/api/v1/servers" | tr -d '\r')"
lab_check "4.7.5: the 6th request in a minute is 429" bash -c 'printf "%s\n" "$1" | head -n 1 | grep -q " 429"' _ "$BURST_REPLY"
lab_check "4.7.5: the 429 carries a numeric Retry-After" bash -c 'printf "%s\n" "$1" | grep -qi -E "^retry-after: [0-9]+$"' _ "$BURST_REPLY"
stop_pid "$BURST_PID"
trap stop_mock EXIT

# source-container resolution: a running application container named the 4.7.5 way, resolved by the migrator from the uuid alone
lab_log "4.7.5 container resolution: $ISO_NAME for application $APP0"
fleet_cleanup
export SRC_VOLUME=lab-fleet-coolify-iso
LAB_SKIP_SOURCE=1 lab_scenario_begin l13-iso --source "$APP0"
"$LAB_SELF_DIR/fixture.sh" "$SRC_VOLUME" 16 random
SNAP="$(fleet_snapshot_others)"
fleet_run --name "$ISO_NAME" -v "$SRC_VOLUME:/var/www/data" alpine:3.21 sleep 86400
lab_check "the source container is named <uuid>-YYYYMMDDTHHMMSS" bash -c "[[ $ISO_NAME =~ ^[a-z0-9]{24}-[0-9]{8}T[0-9]{6}\$ ]] && docker inspect -f '{{.State.Running}}' $ISO_NAME | grep -qx true"
lab_run iso-dry --arms all --dry-run
lab_expect_item iso-dry volume-skipped-running
lab_check "the dry run left it running" fleet_running "$ISO_NAME"
lab_run iso-plan --arms all --dry-run --stop-source
lab_expect_item iso-plan planned would-stop-source
lab_run iso-copy --arms all --stop-source --part-mib 128
[ "$LAB_RC" = 0 ] || { tail -30 "$LAB_DIR/run.iso-copy.log" >&2; lab_die "migrator exit $LAB_RC"; }
lab_expect_item iso-copy volume-applied
lab_check "the migrator stopped the source" bash -c "! docker inspect -f '{{.State.Running}}' $ISO_NAME | grep -qx true"
lab_check "nothing else on the host was stopped, started or removed" test "$SNAP" = "$(fleet_snapshot_others "$ISO_NAME")"
"$LAB_SELF_DIR/compare.sh" "$SRC_VOLUME" "$DEST_VOLUME"
echo "L13_ISO_NAME_RESOLVED=1" >>"$LAB_DIR/l13.summary"
fleet_cleanup
lab_pass "L13 discovery against a Coolify 4.1.2 and a 4.7.5 shaped like the real estate: 8 team tokens each, scoped by token; the 4.7.5 container name resolves"
