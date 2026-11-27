#!/usr/bin/env bash
# Bring the Tier A migration lab up on ONE Linux docker host (the GitHub Actions runner, or any box with docker):
#   registry:2 on localhost:5000 (so the REAL installer line `migrator.sh --image localhost:5000/...` runs, it always
#   pulls) -> agent image built from this checkout -> postgres + redis -> the hub as a restartable node process ->
#   a lab user/team/server -> the target agent container enrolled and ONLINE.
# Usage: scripts/lab/up.sh [--skip-image] [--skip-build]
#   --skip-image  reuse $LAB_IMAGE already in the local registry
#   --skip-build  reuse apps/hub-api/dist (the hub is not rebuilt)
# Everything lands in $LAB_DIR (default /tmp/tugra-lab): lab.env, hub.env, hub.log, hub.pid.
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

SKIP_IMAGE=0
SKIP_BUILD=0
for a in "$@"; do
  case "$a" in
    --skip-image) SKIP_IMAGE=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    *) lab_die "unknown flag $a" ;;
  esac
done

lab_guard_destructive
lab_need docker node pnpm curl openssl
docker info >/dev/null 2>&1 || lab_die "no docker daemon: the lab runs on a Linux docker host (see docs/runbooks/migration-lab.md)"
HOST="$(lab_host_addr)"
HUB_URL="http://${HOST}:${LAB_HUB_PORT}"
lab_log "host address for containers: $HOST  hub: $HUB_URL"

# 1. local registry + the agent image (the migrator IS the agent image)
if ! docker ps --format '{{.Names}}' | grep -qx lab-registry; then
  docker rm -f lab-registry >/dev/null 2>&1 || true
  docker run -d --name lab-registry -p "${LAB_REGISTRY_PORT}:5000" registry:2 >/dev/null
fi
lab_wait 30 "registry on :${LAB_REGISTRY_PORT}" curl -fsS "http://127.0.0.1:${LAB_REGISTRY_PORT}/v2/"
if [ "$SKIP_IMAGE" = 0 ]; then
  lab_log "building the agent image $LAB_IMAGE"
  docker build -q -f "$LAB_ROOT/deploy/Dockerfile.agent" -t "$LAB_IMAGE" "$LAB_ROOT" >/dev/null
  docker push -q "$LAB_IMAGE" >/dev/null
fi
docker pull -q "alpine:3.21" >/dev/null
docker pull -q "$(lab_helper_image)" >/dev/null

# 2. postgres + redis for the hub (the dev compose file: same ports and credentials as CI)
docker compose -p tugralab -f "$LAB_ROOT/docker-compose.dev.yml" up -d >/dev/null
lab_wait 90 "hub postgres" docker compose -p tugralab -f "$LAB_ROOT/docker-compose.dev.yml" exec -T postgres pg_isready -U tugra
lab_wait 30 "hub redis" docker compose -p tugralab -f "$LAB_ROOT/docker-compose.dev.yml" exec -T redis redis-cli ping

# 3. hub environment (stable signing key: an ephemeral one would make the enrolled agent distrust a restarted hub)
[ -s "$LAB_DIR/signing.key" ] || openssl rand -base64 32 >"$LAB_DIR/signing.key"
cat >"$LAB_DIR/hub.env" <<ENV
NODE_ENV=development
DATABASE_URL=postgresql://tugra:tugra@127.0.0.1:${LAB_PG_PORT}/tugra?schema=public
REDIS_URL=redis://127.0.0.1:6379
JWT_ACCESS_SECRET=lab-access-0123456789
JWT_REFRESH_SECRET=lab-refresh-0123456789
SECRETS_ENCRYPTION_KEY=lab-secrets-0123456789
HUB_SIGNING_KEY=$(tr -d '\n' <"$LAB_DIR/signing.key")
HUB_PORT=${LAB_HUB_PORT}
HUB_PUBLIC_URL=${HUB_URL}
AGENT_IMAGE=${LAB_IMAGE}
MIGRATION_VX_STALE_MS=30000
TUGRA_STATS=0
TUGRA_UPDATE_CHECKS=0
ENV

# 4. build + migrate + start the hub
cd "$LAB_ROOT"
if [ "$SKIP_BUILD" = 0 ] || [ ! -f apps/hub-api/dist/main.js ]; then
  lab_log "building the hub"
  pnpm --filter @tugra/shared build >"$LAB_DIR/hub-build.log" 2>&1 || { tail -30 "$LAB_DIR/hub-build.log" >&2; lab_die "shared build failed"; }
  pnpm --filter @tugra/hub-api build >>"$LAB_DIR/hub-build.log" 2>&1 || { tail -30 "$LAB_DIR/hub-build.log" >&2; lab_die "hub build failed"; }
fi
(
  set -a; . "$LAB_DIR/hub.env"; set +a
  pnpm --filter @tugra/hub-api exec prisma migrate deploy >"$LAB_DIR/hub-migrate.log" 2>&1 || { tail -30 "$LAB_DIR/hub-migrate.log" >&2; exit 1; }
) || lab_die "prisma migrate deploy failed"
"$LAB_SELF_DIR/hub.sh" start

# 5. the lab user, team and target server (capabilities include backup + deploy: without backup the agent never gets
#    TUGRA_HUB_ORIGIN and the receive script fails)
cat >"$LAB_DIR/lab.env" <<ENV
LAB_HOST=${HOST}
HUB_URL=${HUB_URL}
LAB_IMAGE=${LAB_IMAGE}
LAB_AGENT=lab-agent
ENV
(
  set -a; . "$LAB_DIR/hub.env"; set +a
  LAB_HUB_LOCAL="http://127.0.0.1:${LAB_HUB_PORT}" node "$LAB_SELF_DIR/seed.mjs" base
) >>"$LAB_DIR/lab.env"
lab_load

# 6. the target agent (what agent.sh does, pointed at the lab hub)
docker rm -f lab-agent >/dev/null 2>&1 || true
docker volume rm -f lab-agent-state >/dev/null 2>&1 || true
mkdir -p /etc/tugra 2>/dev/null || sudo mkdir -p /etc/tugra
docker run -d --name lab-agent --restart unless-stopped \
  --add-host host.docker.internal:host-gateway \
  -v /var/run/docker.sock:/var/run/docker.sock -v lab-agent-state:/root/.tugra -v /etc/tugra:/etc/tugra \
  -e "TUGRA_HUB=ws://${HOST}:${LAB_HUB_PORT}/agent" -e TUGRA_HUB_INSECURE=1 -e "TUGRA_TOKEN=${ENROLL_TOKEN}" -e "TUGRA_AGENT_IMAGE=${LAB_IMAGE}" \
  "$LAB_IMAGE" >/dev/null
lab_wait 90 "the target server to go ONLINE" bash -c '[ "$(node "'"$LAB_SELF_DIR"'/seed.mjs" server-status)" = ONLINE ]'
lab_log "lab is up: hub $HUB_URL, server $SERVER_ID ONLINE. Next: scripts/lab/l0-dry-run.sh (or any l*.sh)"
