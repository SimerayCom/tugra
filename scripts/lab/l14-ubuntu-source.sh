#!/usr/bin/env bash
# L14 (R31): a source host on Ubuntu 26.04. Three of the real estate's hosts run it; the installer, the agent and the migrator had
# only ever run on 24.04. A GitHub runner is an Ubuntu 24.04 host with no 26.04 image to run the job on, so the closest thing that
# runs here is the 26.04 USERLAND: the installers run inside an `ubuntu:26.04` container (its sh, its coreutils (26.04 ships the
# uutils rewrite), its curl) with a docker CLI, against the runner's docker socket. What that proves: the installer scripts parse and
# run under that sh and coreutils, the agent installer brings a real agent ONLINE, and the migrator the installer starts moves a
# volume (a stopped source, then a RUNNING uuid-named one with --stop-source). What it cannot prove: the 26.04 kernel (7.x), its
# docker engine and cgroup configuration. That is Tier B (a real 26.04 VM, the runbook). If `ubuntu:26.04` cannot be pulled the job
# falls back to `ubuntu:24.04`, says so in a workflow warning and records `L14_UBUNTU=fallback` in l14.summary.
set -euo pipefail
# shellcheck source=fleet.sh
. "$(dirname "${BASH_SOURCE[0]}")/fleet.sh"

lab_guard_destructive
lab_load
TOOLS=lab-u2604-tools
: >"$LAB_DIR/l14.summary"

read -r BASE_IMAGE KIND <<<"$("$LAB_SELF_DIR/ubuntu-pick.sh" "${L14_UBUNTU_IMAGE:-ubuntu:26.04}" "${L14_UBUNTU_FALLBACK:-ubuntu:24.04}")"
[ -n "${BASE_IMAGE:-}" ] || lab_die "no ubuntu image could be pulled"
if [ "$KIND" = fallback ]; then
  echo "::warning title=Ubuntu 26.04 not tested::ubuntu:26.04 could not be pulled, this run used $BASE_IMAGE instead (R31 stays open)" >&2
  lab_log "FALLBACK: ubuntu:26.04 is not available, testing $BASE_IMAGE instead"
fi
echo "L14_UBUNTU=$KIND L14_IMAGE=$BASE_IMAGE" >>"$LAB_DIR/l14.summary"

# the userland: the distribution image plus ca-certificates, curl and a static docker client
dir="$(mktemp -d)"
cat >"$dir/Dockerfile" <<DOCKERFILE
FROM $BASE_IMAGE
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
COPY --from=${LAB_DOCKER_CLI_IMAGE:-docker:27-cli} /usr/local/bin/docker /usr/local/bin/docker
DOCKERFILE
docker build -q -t "$TOOLS" "$dir" >/dev/null
rm -rf "$dir"
inside() { docker run --rm -i --network host -v /var/run/docker.sock:/var/run/docker.sock "$TOOLS" "$@"; }

# what this userland is
{
  echo "L14_OS=$(inside sh -c '. /etc/os-release; echo "$PRETTY_NAME"')"
  echo "L14_SH=$(inside sh -c 'readlink -f /bin/sh')"
  echo "L14_STAT=$(inside sh -c 'stat --version 2>&1 | head -1')"
  echo "L14_CURL=$(inside sh -c 'curl --version | head -1')"
  echo "L14_DOCKER=$(inside docker --version)"
} | tee -a "$LAB_DIR/l14.summary" >&2
if [ "$KIND" = exact ]; then
  lab_check "the userland is Ubuntu 26.04" bash -c "grep -q 'L14_OS=Ubuntu 26.04' '$LAB_DIR/l14.summary'"
fi

# 1. both installer scripts parse under that sh
for s in migrator agent; do
  curl -fsSL "http://127.0.0.1:${LAB_HUB_PORT}/install/$s.sh" | inside sh -n || lab_die "$s.sh does not parse under the ${BASE_IMAGE} sh"
  lab_log "ok: $s.sh parses under the $BASE_IMAGE sh"
done

# 2. the agent installer brings a real agent ONLINE
lab_seed server --name lab-u2604 --prefix U >"$LAB_DIR/u.env"
# shellcheck disable=SC1091
. "$LAB_DIR/u.env"
docker rm -f tugra-agent >/dev/null 2>&1 || true
curl -fsSL "http://127.0.0.1:${LAB_HUB_PORT}/install/agent.sh" |
  inside sh -s -- --hub "ws://${LAB_HOST}:${LAB_HUB_PORT}/agent" --token "$U_ENROLL_TOKEN" --image "$LAB_IMAGE" >"$LAB_DIR/u-agent-install.log" 2>&1 ||
  { cat "$LAB_DIR/u-agent-install.log" >&2; lab_die "the agent installer failed under the $BASE_IMAGE userland"; }
lab_wait 90 "the agent installed from $BASE_IMAGE to go ONLINE" bash -c "[ \"\$(node $LAB_SELF_DIR/seed.mjs server-status $U_SERVER_ID)\" = ONLINE ]"
lab_log "ok: the agent installed from the $BASE_IMAGE userland is ONLINE"
echo "L14_AGENT=online" >>"$LAB_DIR/l14.summary"

# 3. the migrator the installer starts: a stopped source, then a running uuid-named one with --stop-source
export LAB_INSTALLER_IMAGE="$TOOLS"
lab_scenario_begin l14-stopped
"$LAB_SELF_DIR/fixture.sh" "$SRC_VOLUME" "${L14_MIB:-256}" random
lab_run stopped --arms all
[ "$LAB_RC" = 0 ] || { tail -30 "$LAB_DIR/run.stopped.log" >&2; lab_die "migrator exit $LAB_RC"; }
lab_expect_item stopped volume-applied
lab_no_leftovers
lab_compare

REF="$(fleet_uuid)"; NAME="$REF-$(fleet_stamp)"; export SRC_VOLUME=lab-fleet-u2604
LAB_SKIP_SOURCE=1 lab_scenario_begin l14-running --source "$REF"
"$LAB_SELF_DIR/fixture.sh" "$SRC_VOLUME" 64 random
fleet_run --name "$NAME" -v "$SRC_VOLUME:/var/www/data" alpine:3.21 sleep 86400
lab_run running --arms all
lab_expect_item running volume-skipped-running
lab_run stop --arms all --stop-source
[ "$LAB_RC" = 0 ] || { tail -30 "$LAB_DIR/run.stop.log" >&2; lab_die "migrator exit $LAB_RC"; }
lab_expect_item stop volume-applied
lab_check "the migrator stopped the running source" bash -c "! docker inspect -f '{{.State.Running}}' $NAME | grep -qx true"
lab_no_leftovers
lab_compare
echo "L14_MIGRATOR=applied" >>"$LAB_DIR/l14.summary"
lab_pass "L14 installers and migrator under the $BASE_IMAGE userland ($KIND)"
