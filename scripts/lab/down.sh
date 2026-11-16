#!/usr/bin/env bash
# Tear the lab down (hub process, agent containers, registry, hub postgres/redis and the lab's own volumes). Only what the lab
# created goes: its fixed container and volume names, and the production-shaped volumes (tugra_appv_*, tugra_dbv_*,
# tugra_restore_rb_vx*) and app-moves staging dirs whose ids are in the LAB hub's database (scope.mjs). It refuses to run
# on a host that is not disposable (CI=true, or LAB_I_UNDERSTAND_DESTRUCTIVE=1).
set -uo pipefail
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
lab_guard_destructive
# the lab's ids come from the lab database: read them BEFORE the compose stack goes away
owned_volumes="$(lab_owned volumes 2>/dev/null)"
owned_dirs="$(lab_owned dirs 2>/dev/null)"
"$LAB_SELF_DIR/hub.sh" stop 2>/dev/null || true
lab_proxy_stop
lab_tap_stop
for c in $(docker ps -aq --filter 'name=tugra-migrator-' --filter 'label=tugra.vx=1' 2>/dev/null); do docker rm -f "$c" >/dev/null 2>&1; done
docker rm -f lab-agent lab-agent-b lab-registry labsrc labsrc2 lab-pgsrc >/dev/null 2>&1
docker compose -p tugralab -f "$LAB_ROOT/docker-compose.dev.yml" down -v >/dev/null 2>&1
for v in $owned_volumes; do docker volume rm -f "$v" >/dev/null 2>&1; done
for d in $owned_dirs; do rm -rf "/etc/tugra/app-moves/$d" 2>/dev/null || sudo rm -rf "/etc/tugra/app-moves/$d" 2>/dev/null || true; done
[ "${1:-}" = "--keep-state" ] || rm -rf "$LAB_DIR"
lab_log "lab is down"
