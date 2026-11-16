#!/usr/bin/env bash
# L3 (mechanics only): the throttled link. CI proves the machinery on loopback: the migrator's --speedtest-mib measures a
# rate close to the proxy's configured rate, estimateSeconds follows size / rate, and a part larger than a few minutes of
# link time still completes. The REAL numbers (WAN, a Cloudflare body cap) need Tier B, see docs/runbooks/migration-lab.md.
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
trap lab_proxy_stop EXIT

lab_scenario_begin l3
"$LAB_SELF_DIR/fixture.sh" "$SRC_VOLUME" "${L3_MIB:-1024}" random

for rate in ${L3_RATES:-100 25 10}; do
  lab_proxy_start "$rate"
  lab_run "speed$rate" --hub "$LAB_PROXY_URL" --arms all --speedtest-mib 256 --dry-run
  [ "$LAB_RC" = 0 ] || { tail -20 "$LAB_DIR/run.speed$rate.log" >&2; lab_die "speedtest at $rate MB/s: exit $LAB_RC"; }
  got="$(lab_item "speed$rate" speedMBps)"
  est="$(lab_item "speed$rate" estimateSeconds)"
  lab_log "link ${rate} MB/s -> measured ${got:-none} MB/s (raw), estimate ${est:-none} s"
  lab_check "a speed was measured at $rate MB/s" test -n "$got"
  # the proxy throttles the COMPRESSED upload; incompressible data makes raw ~ wire. The upper bound always holds. The lower
  # bound (0.35x) only applies up to 25 MB/s: above that the hub, the relay and the target's curl on a shared runner can be
  # the bottleneck, which is a finding to read in the log, not a mechanics failure.
  lab_check "measured $got MB/s does not exceed 1.5x the ${rate} MB/s link" node -e '
    const [m, r] = process.argv.slice(1).map(Number); process.exit(m <= r * 1.5 ? 0 : 1)' "$got" "$rate"
  if [ "$rate" -le 25 ]; then
    lab_check "measured $got MB/s is at least 0.35x the ${rate} MB/s link" node -e '
      const [m, r] = process.argv.slice(1).map(Number); process.exit(m >= r * 0.35 ? 0 : 1)' "$got" "$rate"
  fi
  size=$(( ${L3_MIB:-1024} * 1048576 ))
  lab_check "estimate follows size / rate + fixed overhead (within +-40%)" node -e '
    const [e, size, rate] = process.argv.slice(1).map(Number); const base = size / (rate * 1e6) + 15 * 60; process.exit(e >= base * 0.6 && e <= base * 1.4 ? 0 : 1)' "$est" "$size" "$got"
  lab_proxy_stop
done

# boundary: a single ~30 MiB part at 0.25 MB/s takes ~2 min and must still complete (the relay's 120 s idle limit applies to
# a stalled socket, not to a slow one). A 30 MiB archive is one part under the 32 MiB policy.
# Nothing renews the transfer's lease while a part is being PUT (the hub bumps lastBeatAt on begin, commit, finish and beat
# only, and the migrator beats only while skipping), so the hub's stale-copy sweep, which runs every 60 s, fails any COPYING
# transfer whose last commit is older than MIGRATION_VX_STALE_MS and cancels the part in flight. The lab's 30 s default would
# kill this ~126 s PUT on the first sweep: the window must exceed the part's whole transfer time. That is a product finding
# (docs/runbooks/migration-lab.md, "Findings the lab surfaced"), not something this scenario can paper over.
if [ "${L3_BOUNDARY:-1}" = 1 ]; then
  "$LAB_SELF_DIR/hub.sh" restart MIGRATION_VX_PART_MIB=32 MIGRATION_VX_STALE_MS=900000
  lab_scenario_begin l3-boundary
  "$LAB_SELF_DIR/fixture.sh" "$SRC_VOLUME" 30 random   # one part (the whole archive is < 32 MiB)
  lab_proxy_start 0.25
  lab_run boundary --hub "$LAB_PROXY_URL" --arms all --part-mib 32 --hub-outage-wait 2m
  [ "$LAB_RC" = 0 ] || { tail -20 "$LAB_DIR/run.boundary.log" >&2; lab_die "a 30 MiB part at 0.25 MB/s failed: exit $LAB_RC"; }
  lab_expect_item boundary volume-applied
  lab_proxy_stop
  "$LAB_SELF_DIR/hub.sh" reset-extra
  "$LAB_SELF_DIR/hub.sh" restart
fi
lab_pass "L3 throttle mechanics"
