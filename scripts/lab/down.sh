#!/usr/bin/env bash
# Tear the lab down (hub process, agent containers, registry, hub postgres/redis and every lab volume).
set -uo pipefail
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
"$LAB_SELF_DIR/hub.sh" stop 2>/dev/null || true
for c in $(docker ps -aq --filter 'name=tugra-migrator-' --filter 'label=tugra.vx=1' 2>/dev/null); do docker rm -f "$c" >/dev/null 2>&1; done
docker rm -f lab-agent lab-agent-b lab-registry labsrc lab-pgsrc >/dev/null 2>&1
docker compose -p tugralab -f "$LAB_ROOT/docker-compose.dev.yml" down -v >/dev/null 2>&1
for v in $(docker volume ls -q | grep -E '^(lab-|tugra_appv_|tugra_dbv_|tugra_restore_rb_|tugra_vx)' 2>/dev/null); do docker volume rm -f "$v" >/dev/null 2>&1; done
rm -rf /etc/tugra/app-moves 2>/dev/null || sudo rm -rf /etc/tugra/app-moves 2>/dev/null || true
[ "${1:-}" = "--keep-state" ] || rm -rf "$LAB_DIR"
lab_log "lab is down"
