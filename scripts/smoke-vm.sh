#!/usr/bin/env bash
#
# Tugra real-VM smoke test. Drives a REAL Tugra hub + REAL agent + REAL Docker containers on an
# already-enrolled server, end to end:
#
#   1. create a Postgres database, wait for it to come up RUNNING
#   2. insert known rows directly into it (psql — there is no generic SQL-exec API endpoint)
#   3. take a backup and wait for SUCCESS
#   4. destroy the data (DROP TABLE)
#   5. restore from the backup
#   6. verify the known rows are back — FAILS LOUDLY if not (this is the whole point)
#   7. deploy a tiny real app (IMAGE source) and curl its live URL for a 200
#   8. do one MCP round-trip: tools/list, then tools/call get_database
#
# Why this exists: the CI e2e suite exercises the hub against an in-process agent for fast,
# deterministic coverage. This script complements it by running the full flow (provision, backup,
# restore, deploy, MCP) against a real, already-enrolled host — by hand or from a job that has a real
# server available.
#
# It talks to the REST API directly with curl (apps/hub-api/openapi.json is the source of truth for
# every path/body used below) rather than through `tugra login` + a persisted CLI profile, so it is a
# single, stateless, CI-friendly invocation driven purely by env vars. Where the `tugra` CLI
# (packages/cli) already wraps an endpoint used here, that's noted inline — this script still calls
# the API directly so every step, including provision, restore,
# create and mcp, goes through the same request/poll/verify machinery.
#
# Usage:
#   TUGRA_URL=https://hub.example.com \
#   TUGRA_TOKEN=tugra_pat_xxx \
#   TUGRA_SERVER=my-hetzner-box \
#     ./scripts/smoke-vm.sh
#
# Required env vars:
#   TUGRA_URL     Hub base URL, e.g. https://hub.example.com (no trailing /api/v1).
#   TUGRA_TOKEN   A personal access token (Settings -> API tokens) minted with scopes:
#                   write, deploy, read:secrets
#                 (write: create the db/app; deploy: provision/backup/restore/deploy; read:secrets:
#                 see the db's real password/connection fields — see docs/api.md's Scopes table).
#   TUGRA_SERVER  The id OR name of an already-enrolled server whose status is ONLINE
#                 (`tugra servers ls` or GET /api/v1/servers to find one).
#
# Optional env vars:
#   TUGRA_DB_ENGINE      Database engine (default: POSTGRES — the only engine this script speaks).
#   TUGRA_DB_VERSION     Engine version/tag (default: 16).
#   TUGRA_DB_HOST_PORT   Host port to publish Postgres on so this script can reach it from outside the
#                        server (default: a random 20000-39999 port). Make sure nothing in front of the
#                        server (Hetzner Cloud Firewall, etc.) blocks it, or run this script from
#                        inside the server's network.
#   TUGRA_APP_IMAGE      Docker image to deploy for the app-smoke step (default: traefik/whoami:latest
#                        — a few-MB binary that answers 200 on / with no config).
#   TUGRA_APP_DOMAIN     A real domain you already point at the server's IP. When set, the app is
#                        exposed on it (exposeMode "custom", https:true — a real Let's-Encrypt HTTPS
#                        cert). When unset (the default), the app gets a free auto-generated
#                        "magic"/sslip.io subdomain instead — zero config, but plain HTTP unless the
#                        server already has a wildcard domain + DNS-01 cert mode configured (see the
#                        note near APP_URL below).
#   TUGRA_CLEANUP        Set to 1 to delete the smoke-test database and app on a SUCCESSFUL run
#                        (needs the `admin` scope too — DELETE is admin-only). Default: off, so you
#                        can inspect what was created.
#
# Exit code: 0 only if every step below passed. Non-zero (with a FAIL: line explaining why) otherwise.

set -euo pipefail

# ── preflight: required tools ────────────────────────────────────────────────────────────────────
for c in curl jq psql; do
  command -v "$c" >/dev/null 2>&1 || { printf 'FAIL: "%s" is required but not installed\n' "$c" >&2; exit 1; }
done

# ── preflight: required env vars ─────────────────────────────────────────────────────────────────
: "${TUGRA_URL:?set TUGRA_URL to the hub base URL, e.g. https://hub.example.com}"
: "${TUGRA_TOKEN:?set TUGRA_TOKEN to a tugra_pat_... personal access token (scopes: write, deploy, read:secrets)}"
: "${TUGRA_SERVER:?set TUGRA_SERVER to an already-enrolled ONLINE server id or name}"

TUGRA_DB_ENGINE="${TUGRA_DB_ENGINE:-POSTGRES}"
TUGRA_DB_VERSION="${TUGRA_DB_VERSION:-16}"
TUGRA_DB_HOST_PORT="${TUGRA_DB_HOST_PORT:-$((20000 + RANDOM % 20000))}"
TUGRA_APP_IMAGE="${TUGRA_APP_IMAGE:-traefik/whoami:latest}"
[[ "$TUGRA_DB_HOST_PORT" =~ ^[0-9]+$ ]] || { echo "FAIL: TUGRA_DB_HOST_PORT must be numeric" >&2; exit 1; }

RUN_ID="$(date +%Y%m%d%H%M%S)-${RANDOM}"
MARKER="tugra-smoke-${RUN_ID}"

# ── output helpers ───────────────────────────────────────────────────────────────────────────────
STEP_LOG=()
step() { printf '\n\033[36m== %s ==\033[0m\n' "$*"; }
pass() { printf '\033[32mPASS:\033[0m %s\n' "$*"; STEP_LOG+=("PASS: $*"); }
fail() { printf '\033[31mFAIL:\033[0m %s\n' "$*" >&2; STEP_LOG+=("FAIL: $*"); exit 1; }

on_exit() {
  local ec=$?
  step "smoke-vm summary (run ${RUN_ID})"
  local line
  for line in "${STEP_LOG[@]:-}"; do [[ -n "$line" ]] && printf '  %s\n' "$line"; done
  if [[ $ec -eq 0 ]]; then
    printf '\033[32mRESULT: ALL STEPS PASSED\033[0m\n'
  else
    printf '\033[31mRESULT: FAILED (exit %s)\033[0m\n' "$ec"
  fi
  exit "$ec"
}
trap on_exit EXIT

# ── REST helper: api METHOD /path [json-body] → sets LAST_STATUS / LAST_BODY ───────────────────────
# Never lets a curl-level failure (DNS, connection refused, timeout) trip `set -e` mid-step; every
# call site checks LAST_STATUS explicitly and fails loudly with the real hub error body attached.
LAST_STATUS=""
LAST_BODY=""
api() {
  local method="$1" path="$2" data="${3:-}"
  local url="${TUGRA_URL%/}/api/v1${path}"
  local tmp status
  tmp="$(mktemp)"
  set +e
  if [[ -n "$data" ]]; then
    status=$(curl -sS --max-time 330 -o "$tmp" -w '%{http_code}' \
      -H "authorization: Bearer ${TUGRA_TOKEN}" -H 'content-type: application/json' \
      -X "$method" -d "$data" "$url" 2>"$tmp.err")
  else
    status=$(curl -sS --max-time 330 -o "$tmp" -w '%{http_code}' \
      -H "authorization: Bearer ${TUGRA_TOKEN}" \
      -X "$method" "$url" 2>"$tmp.err")
  fi
  local curl_ec=$?
  set -e
  if [[ $curl_ec -ne 0 ]]; then
    LAST_STATUS="000"
    LAST_BODY="curl could not reach ${url}: $(cat "$tmp.err" 2>/dev/null)"
  else
    LAST_STATUS="$status"
    LAST_BODY="$(cat "$tmp")"
  fi
  rm -f "$tmp" "$tmp.err"
}

# ── psql helper: run_psql "SQL" → sets PSQL_OUT / PSQL_EC against the smoke-test database ──────────
run_psql() {
  set +e
  PSQL_OUT=$(PGPASSWORD="$DB_PASS" psql -h "$SERVER_IP" -p "$TUGRA_DB_HOST_PORT" \
    -U "$DB_USER" -d "$DB_DATABASE" -v ON_ERROR_STOP=1 -qtA -c "$1" 2>&1)
  PSQL_EC=$?
  set -e
}

# ── http_code URL → prints a status code, or "000" on any connection-level failure ────────────────
http_code() {
  local out
  set +e
  # -k: during the cert-issuance window a magic domain's TLS handshake can be flaky; we're proving
  # the app answers 200, not auditing its certificate chain.
  out=$(curl -sS -k -o /dev/null -w '%{http_code}' --max-time 15 "$1" 2>/dev/null)
  local ec=$?
  set -e
  [[ $ec -eq 0 ]] && echo "$out" || echo "000"
}

echo "Tugra real-VM smoke test — run ${RUN_ID}"
echo "hub: ${TUGRA_URL}  server: ${TUGRA_SERVER}  db host port: ${TUGRA_DB_HOST_PORT}"

# ── 0. resolve the target server (equivalent to `tugra servers ls`) ────────────────────────────────
step "0/10: resolve server '${TUGRA_SERVER}'"
api GET /servers
[[ "$LAST_STATUS" == "200" ]] || fail "GET /servers: HTTP $LAST_STATUS: $LAST_BODY"
SERVER_JSON=$(echo "$LAST_BODY" | jq -c --arg s "$TUGRA_SERVER" \
  '[.[] | select(.id == $s or .name == $s)] | .[0] // empty')
[[ -n "$SERVER_JSON" ]] || fail "no server matches id/name '${TUGRA_SERVER}' — see \`GET /api/v1/servers\`"
SERVER_ID=$(echo "$SERVER_JSON" | jq -r '.id')
SERVER_STATUS=$(echo "$SERVER_JSON" | jq -r '.status')
SERVER_IP=$(echo "$SERVER_JSON" | jq -r '.publicIp')
[[ "$SERVER_STATUS" == "ONLINE" ]] || fail "server ${SERVER_ID} is ${SERVER_STATUS}, not ONLINE — enroll/start the agent first"
[[ -n "$SERVER_IP" && "$SERVER_IP" != "null" ]] || fail "server ${SERVER_ID} has no publicIp — cannot reach it from here"
pass "server ${SERVER_ID} (${SERVER_IP}) is ONLINE"

# ── a. create a real Postgres database (POST /databases) ───────────────────────────────────────────
step "1/10 (a): create database"
DB_NAME="smoke-${RUN_ID}"
api POST /databases "$(jq -n \
  --arg name "$DB_NAME" --arg server "$SERVER_ID" --arg engine "$TUGRA_DB_ENGINE" \
  --arg version "$TUGRA_DB_VERSION" --argjson hostPort "$TUGRA_DB_HOST_PORT" \
  '{name: $name, serverId: $server, engine: $engine, version: $version, hostPort: $hostPort}')"
[[ "$LAST_STATUS" == "201" ]] || fail "POST /databases: HTTP $LAST_STATUS: $LAST_BODY"
DB_ID=$(echo "$LAST_BODY" | jq -r '.id')
DB_USER=$(echo "$LAST_BODY" | jq -r '.username')
DB_PASS=$(echo "$LAST_BODY" | jq -r '.password')
DB_DATABASE=$(echo "$LAST_BODY" | jq -r '.database')
[[ "$DB_USER" != "null" && -n "$DB_USER" ]] || \
  fail "database ${DB_ID} came back with no connection credentials — TUGRA_TOKEN needs the read:secrets scope"
pass "database ${DB_ID} created (${DB_DATABASE})"

# ── b. provision it and wait until RUNNING ──────────────────────────────────────────────────────────
# POST /databases/{id}/provision is synchronous on the hub (it awaits the agent's `docker run` over
# the agent WebSocket and returns the resulting status), so this normally returns RUNNING/FAILED
# directly — the poll loop below is defense-in-depth against a slow hub response, not the primary
# wait mechanism.
step "2/10 (b): provision + wait for RUNNING"
api POST "/databases/${DB_ID}/provision"
[[ "$LAST_STATUS" == "200" ]] || fail "POST /databases/${DB_ID}/provision: HTTP $LAST_STATUS: $LAST_BODY"
DB_STATUS=$(echo "$LAST_BODY" | jq -r '.status')
if [[ "$DB_STATUS" != "RUNNING" ]]; then
  for _ in $(seq 1 10); do
    sleep 3
    api GET "/databases/${DB_ID}"
    DB_STATUS=$(echo "$LAST_BODY" | jq -r '.status')
    [[ "$DB_STATUS" == "RUNNING" ]] && break
  done
fi
[[ "$DB_STATUS" == "RUNNING" ]] || fail "database ${DB_ID} never reached RUNNING (last status: ${DB_STATUS})"
# The container can take a moment to accept connections even after `docker run` exits 0 (Postgres init).
DB_READY=0
for _ in $(seq 1 20); do
  run_psql "select 1"
  [[ $PSQL_EC -eq 0 ]] && { DB_READY=1; break; }
  sleep 3
done
[[ "$DB_READY" == "1" ]] || fail "could not reach postgres at ${SERVER_IP}:${TUGRA_DB_HOST_PORT} — check that the host port is open through any firewall in front of the server: $PSQL_OUT"
pass "database ${DB_ID} is RUNNING and reachable at ${SERVER_IP}:${TUGRA_DB_HOST_PORT}"

# ── c. insert known rows ────────────────────────────────────────────────────────────────────────────
# There is no generic SQL-exec API endpoint (see apps/hub-api/openapi.json) — this connects straight
# to the database the API just handed us credentials for, exactly like any other client would.
step "3/10 (c): insert known rows"
run_psql "create table smoke_test (id serial primary key, note text not null);"
[[ $PSQL_EC -eq 0 ]] || fail "CREATE TABLE failed: $PSQL_OUT"
run_psql "insert into smoke_test (note) values ('${MARKER}-1'), ('${MARKER}-2'), ('${MARKER}-3');"
[[ $PSQL_EC -eq 0 ]] || fail "INSERT failed: $PSQL_OUT"
run_psql "select count(*) from smoke_test where note like '${MARKER}%';"
BEFORE_COUNT=$(echo "$PSQL_OUT" | tr -d '[:space:]')
[[ "$BEFORE_COUNT" == "3" ]] || fail "expected 3 known rows right after insert, counted ${BEFORE_COUNT}"
pass "inserted 3 known rows (marker: ${MARKER})"

# ── d. trigger a backup and wait for SUCCESS ────────────────────────────────────────────────────────
# POST /databases/{id}/backups is also synchronous (it awaits the real pg_dump over the agent
# WebSocket before responding), so — like provision — the poll loop is a defensive fallback.
step "4/10 (d): backup + wait for SUCCESS"
api POST "/databases/${DB_ID}/backups"
[[ "$LAST_STATUS" == "201" ]] || fail "POST /databases/${DB_ID}/backups: HTTP $LAST_STATUS: $LAST_BODY"
BACKUP_ID=$(echo "$LAST_BODY" | jq -r '.id')
BACKUP_STATUS=$(echo "$LAST_BODY" | jq -r '.status')
if [[ "$BACKUP_STATUS" != "SUCCESS" && "$BACKUP_STATUS" != "FAILED" ]]; then
  for _ in $(seq 1 20); do
    sleep 5
    api GET "/databases/${DB_ID}/backups"
    [[ "$LAST_STATUS" == "200" ]] || fail "GET /databases/${DB_ID}/backups: HTTP $LAST_STATUS: $LAST_BODY"
    BACKUP_STATUS=$(echo "$LAST_BODY" | jq -r --arg id "$BACKUP_ID" '.[] | select(.id == $id) | .status')
    [[ "$BACKUP_STATUS" == "SUCCESS" || "$BACKUP_STATUS" == "FAILED" ]] && break
  done
fi
[[ "$BACKUP_STATUS" == "SUCCESS" ]] || fail "backup ${BACKUP_ID} ended in status ${BACKUP_STATUS}, expected SUCCESS"
pass "backup ${BACKUP_ID} SUCCESS"

# ── e. wipe the data ─────────────────────────────────────────────────────────────────────────────────
step "5/10 (e): wipe the data (DROP TABLE)"
run_psql "drop table smoke_test;"
[[ $PSQL_EC -eq 0 ]] || fail "DROP TABLE failed: $PSQL_OUT"
run_psql "select to_regclass('smoke_test');"
[[ "$(echo "$PSQL_OUT" | tr -d '[:space:]')" == "" ]] || fail "smoke_test still exists after DROP TABLE"
pass "smoke_test dropped — database is now missing the known rows"

# ── f. restore from the backup ──────────────────────────────────────────────────────────────────────
# POST .../restore is synchronous too (pg_restore --clean --if-exists over the agent WebSocket,
# awaited before the hub responds), so by the time this call returns the restore has either fully
# applied or the hub has thrown — no separate "wait" step is needed here.
step "6/10 (f): restore from backup ${BACKUP_ID}"
api POST "/databases/${DB_ID}/backups/${BACKUP_ID}/restore"
[[ "$LAST_STATUS" == "200" ]] || fail "POST /databases/${DB_ID}/backups/${BACKUP_ID}/restore: HTTP $LAST_STATUS: $LAST_BODY"
pass "restore request completed"

# ── g. verify the known rows are back ───────────────────────────────────────────────────────────────
step "7/10 (g): verify restored rows"
run_psql "select count(*) from smoke_test where note like '${MARKER}%';"
[[ $PSQL_EC -eq 0 ]] || fail "smoke_test is unreadable after restore: $PSQL_OUT"
AFTER_COUNT=$(echo "$PSQL_OUT" | tr -d '[:space:]')
[[ "$AFTER_COUNT" == "3" ]] || fail "RESTORE DID NOT RECOVER THE DATA — expected 3 rows, found ${AFTER_COUNT}"
run_psql "select note from smoke_test where note like '${MARKER}%' order by note;"
RESTORED_NOTES=$(echo "$PSQL_OUT" | tr -s '\n' ',')
EXPECTED_NOTES="${MARKER}-1,${MARKER}-2,${MARKER}-3,"
[[ "$RESTORED_NOTES" == "$EXPECTED_NOTES" ]] || fail "restored row content mismatch: got [${RESTORED_NOTES}] want [${EXPECTED_NOTES}]"
pass "backup/restore round-trip verified: 3/3 known rows recovered byte-for-byte"
unset PGPASSWORD 2>/dev/null || true

# ── h. deploy a tiny real app and curl it ───────────────────────────────────────────────────────────
step "8/10 (h): deploy app (${TUGRA_APP_IMAGE})"
APP_NAME="smoke-app-${RUN_ID}"
if [[ -n "${TUGRA_APP_DOMAIN:-}" ]]; then
  APP_BODY=$(jq -n --arg name "$APP_NAME" --arg server "$SERVER_ID" --arg image "$TUGRA_APP_IMAGE" \
    --arg domain "$TUGRA_APP_DOMAIN" \
    '{name: $name, serverId: $server, source: "IMAGE", image: $image, containerPort: 80, domain: $domain, https: true}')
else
  APP_BODY=$(jq -n --arg name "$APP_NAME" --arg server "$SERVER_ID" --arg image "$TUGRA_APP_IMAGE" \
    '{name: $name, serverId: $server, source: "IMAGE", image: $image, containerPort: 80, exposeMode: "magic"}')
fi
api POST /apps "$APP_BODY"
[[ "$LAST_STATUS" == "201" ]] || fail "POST /apps: HTTP $LAST_STATUS: $LAST_BODY"
APP_ID=$(echo "$LAST_BODY" | jq -r '.id')
pass "app ${APP_ID} created"

# equivalent to `tugra apps deploy <id>`, called directly so the response body (deployment status/logs)
# can be checked here rather than only rendered as a table.
api POST "/apps/${APP_ID}/deploy" '{}'
[[ "$LAST_STATUS" == "200" ]] || fail "POST /apps/${APP_ID}/deploy: HTTP $LAST_STATUS: $LAST_BODY"
# NOTE: the POST /apps/{id}/deploy response schema is not in openapi.json, so read .status
# defensively and fall back to GET /apps/{id}.
DEPLOY_STATUS=$(echo "$LAST_BODY" | jq -r '.status // empty')
if [[ -n "$DEPLOY_STATUS" && "$DEPLOY_STATUS" != "SUCCESS" ]]; then
  fail "deploy ended in status ${DEPLOY_STATUS}: $(echo "$LAST_BODY" | jq -r '.logs // "no logs"' | tail -c 2000)"
fi

api GET "/apps/${APP_ID}"
[[ "$LAST_STATUS" == "200" ]] || fail "GET /apps/${APP_ID}: HTTP $LAST_STATUS: $LAST_BODY"
APP_STATUS=$(echo "$LAST_BODY" | jq -r '.status')
APP_URL=$(echo "$LAST_BODY" | jq -r '.url')
[[ "$APP_STATUS" == "RUNNING" ]] || fail "app ${APP_ID} status is ${APP_STATUS}, expected RUNNING"
[[ -n "$APP_URL" && "$APP_URL" != "null" ]] || fail "app ${APP_ID} has no url — check the server's public IP / magic-domain config"
pass "app ${APP_ID} deployed and RUNNING at ${APP_URL}"

# NOTE: with TUGRA_APP_DOMAIN unset, the app gets a magic domain served over HTTP. Set
# TUGRA_APP_DOMAIN for a guaranteed HTTPS check.
step "9/10 (h): curl ${APP_URL} for 200"
CODE="000"
for _ in $(seq 1 20); do
  CODE=$(http_code "$APP_URL")
  [[ "$CODE" == "200" ]] && break
  sleep 5
done
[[ "$CODE" == "200" ]] || fail "curl ${APP_URL} never returned 200 (last: ${CODE}) — routing/cert issuance can lag right after a deploy; check the server's proxy logs if this persists"
pass "curl ${APP_URL} -> 200"

# ── i. one MCP round-trip ────────────────────────────────────────────────────────────────────────────
step "10/10 (i): MCP round-trip (tools/list + tools/call)"
api POST /mcp "$(jq -n '{jsonrpc: "2.0", id: 1, method: "tools/list"}')"
[[ "$LAST_STATUS" == "200" ]] || fail "POST /mcp tools/list: HTTP $LAST_STATUS: $LAST_BODY"
TOOL_COUNT=$(echo "$LAST_BODY" | jq -r '.result.tools | length // 0')
[[ "$TOOL_COUNT" -gt 0 ]] || fail "MCP tools/list returned no tools: $LAST_BODY"
pass "MCP tools/list: ${TOOL_COUNT} tools advertised"

api POST /mcp "$(jq -n --arg id "$DB_ID" \
  '{jsonrpc: "2.0", id: 2, method: "tools/call", params: {name: "get_database", arguments: {id: $id}}}')"
[[ "$LAST_STATUS" == "200" ]] || fail "POST /mcp tools/call get_database: HTTP $LAST_STATUS: $LAST_BODY"
IS_ERROR=$(echo "$LAST_BODY" | jq -r '.result.isError // false')
MCP_TEXT=$(echo "$LAST_BODY" | jq -r '.result.content[0].text // empty')
[[ "$IS_ERROR" == "false" ]] || fail "MCP tools/call get_database returned an error: ${MCP_TEXT}"
echo "$MCP_TEXT" | grep -q "$DB_ID" || fail "MCP get_database result didn't mention database ${DB_ID}: ${MCP_TEXT}"
pass "MCP tools/call get_database -> our own database, round-trip confirmed"

# ── optional cleanup (opt-in; needs the admin scope — DELETE is admin-only) ────────────────────────
if [[ "${TUGRA_CLEANUP:-0}" == "1" ]]; then
  step "cleanup (TUGRA_CLEANUP=1)"
  api DELETE "/apps/${APP_ID}"
  [[ "$LAST_STATUS" == "200" ]] && pass "deleted app ${APP_ID}" || echo "warning: could not delete app ${APP_ID}: HTTP $LAST_STATUS: $LAST_BODY" >&2
  api DELETE "/databases/${DB_ID}"
  [[ "$LAST_STATUS" == "200" ]] && pass "deleted database ${DB_ID}" || echo "warning: could not delete database ${DB_ID}: HTTP $LAST_STATUS: $LAST_BODY" >&2
else
  echo "left running for inspection: database ${DB_ID}, app ${APP_ID} (${APP_URL}) — set TUGRA_CLEANUP=1 to auto-delete on a green run"
fi
