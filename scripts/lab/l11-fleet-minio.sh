#!/usr/bin/env bash
# L11: object storage on a host bind mount, as five of the real estate's six MinIO instances run. A RUNNING, uuid-named MinIO whose
# /data is a bind mount of a host directory (not a docker volume), with the 12 bucket size classes of the real store (FLEET_MINIO_DIV
# scales them, default 4, about 2.1 GiB), copied as an application volume:
#   1. docker cannot see it: `docker system df` does not grow with the bind data (C19), and the migrator refuses a bind mount by
#      default (`volume-bind-refused`, no size known), also under --allow-bind when the path is a system path
#   2. --allow-bind makes the dry run measure it: a RUNNING source is `volume-skipped-running`, and with --stop-source the plan
#      reports the real bytes (the number the downtime window is sized from)
#   3. --allow-bind --stop-source copies it: the migrator stops only the source, the volume applies, `compare.sh` is identical,
#      and a second MinIO on the DESTINATION volume lists all 12 buckets with the same objects (`mc diff` is empty)
set -euo pipefail
# shellcheck source=fleet.sh
. "$(dirname "${BASH_SOURCE[0]}")/fleet.sh"

lab_guard_destructive
fleet_cleanup
SRC="$(fleet_uuid)"
DST_MINIO=lab-minio-dst
BIND="$(fleet_bind_dir minio-a)"
LAB_SKIP_SOURCE=1 lab_scenario_begin l11 --source "$SRC" --volume data --path /data
: >"$LAB_DIR/l11.summary"
lab_log "bind mount: $BIND"

V0="$(fleet_local_volumes_bytes)"
fleet_minio_run "$SRC" "$BIND"
fleet_minio_fill "$SRC"
read -r BUCKETS OBJECTS BYTES <"$LAB_DIR/minio.expected"
lab_check "the real shape: 12 buckets" test "$BUCKETS" = 12
V1="$(fleet_local_volumes_bytes)"
ON_DISK="$(fleet_bytes_on_disk "$BIND")"
lab_log "bind data: $ON_DISK B on disk; docker system df Local Volumes: $V0 -> $V1 B"
lab_check "the bind directory holds at least the uploaded bytes" test "$ON_DISK" -ge "$BYTES"
lab_check "docker's volume accounting does not see the bind data (it grew by under a tenth of it)" test $(( V1 - V0 )) -lt $(( BYTES / 10 ))
echo "L11_BUCKETS=$BUCKETS L11_OBJECTS=$OBJECTS L11_BYTES=$BYTES L11_DF_GROWTH=$(( V1 - V0 ))" >>"$LAB_DIR/l11.summary"
OTHERS_BEFORE="$(fleet_snapshot_others "$SRC")"

# 1. the default refuses a bind mount and knows no size; a system path stays refused even with --allow-bind
lab_run refused --arms all --dry-run
lab_expect_item refused volume-bind-refused bind-mount
lab_check "the refused bind mount reports no size (the inventory is blind to it)" test -z "$(lab_item refused rawBytes)"
DENY="$(fleet_uuid)"
fleet_run --name "$DENY" -v /etc/tugra:/data:ro alpine:3.21 sleep 86400
lab_seed op --name "lab-deny-$(date +%s)" --source "$DENY" --volume data --path /data >"$LAB_DIR/op.deny.env"
LAB_OP=deny lab_run deny --arms all --dry-run --allow-bind
(lab_op_load deny; lab_expect_item deny volume-bind-refused)
docker rm -f "$DENY" >/dev/null

# 2. --allow-bind measures it
lab_run running --arms all --dry-run --allow-bind
lab_expect_item running volume-skipped-running
lab_check "the dry run left the MinIO running" fleet_running "$SRC"
lab_run plan --arms all --dry-run --allow-bind --stop-source
lab_expect_item plan planned would-stop-source
lab_log "with --allow-bind the plan sees $(lab_item plan rawBytes) B in $(lab_item plan entries) entries (the objects: $BYTES B)"
lab_check "the inventory counts the bind data" test "$(lab_item plan rawBytes)" -ge "$BYTES"
lab_check "a dry run never stops the source" fleet_running "$SRC"
echo "L11_PLAN_RAW_BYTES=$(lab_item plan rawBytes)" >>"$LAB_DIR/l11.summary"

# 3. the copy
t0=$(date +%s)
lab_run copy --arms all --allow-bind --stop-source --part-mib 128
secs=$(( $(date +%s) - t0 ))
[ "$LAB_RC" = 0 ] || { tail -30 "$LAB_DIR/run.copy.log" >&2; lab_die "migrator exit $LAB_RC"; }
lab_expect_item copy volume-applied
lab_log "L11 copy took ${secs} s ($(lab_item copy parts) parts)"
read -r state _ <<<"$(lab_transfer)"
lab_check "the hub transfer is DONE" test "$state" = DONE
lab_no_leftovers
lab_check "the migrator stopped the MinIO (and only that container)" bash -c "! docker inspect -f '{{.State.Running}}' $SRC | grep -qx true"
lab_check "no other container on the host was stopped, started or removed" test "$OTHERS_BEFORE" = "$(fleet_snapshot_others "$SRC")"
"$LAB_SELF_DIR/compare.sh" "$BIND" "$DEST_VOLUME"

# the proof a MinIO user cares about: a MinIO on the copied volume serves every bucket with the same objects
docker start "$SRC" >/dev/null
FLEET_MC_SRC="$SRC" lab_wait 90 "the source MinIO to answer again" fleet_mc ls src
fleet_minio_run "$DST_MINIO" "$DEST_VOLUME"
export FLEET_MC_SRC="$SRC" FLEET_MC_DST="$DST_MINIO"
lab_check "the destination lists all 12 buckets" test "$(fleet_mc ls dst | wc -l | tr -d ' ')" = 12
while read -r b n; do
  lab_check "bucket $b: $n objects on the destination" test "$(fleet_mc ls --recursive "dst/$b" | wc -l | tr -d ' ')" = "$n"
  lab_check "bucket $b: mc diff of source and destination is empty" test -z "$(fleet_mc diff "src/$b" "dst/$b")"
done <"$LAB_DIR/minio.buckets"
echo "L11_COPY_SECONDS=$secs" >>"$LAB_DIR/l11.summary"
lab_pass "L11 MinIO on a bind mount: 12 buckets, $OBJECTS objects, identical on the destination"
