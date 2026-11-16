#!/usr/bin/env bash
# L4: tar fidelity into the REAL apply extractor. The migrator's stream (agent-image GNU tar: --sort=name --numeric-owner
# --format=gnu) is applied on the target with the pinned alpine busybox tar (BACKUP_HELPER_IMAGE), exactly as
# safeWipeExtract does (validate with `tar -tf -`, wipe, `tar -xf -` with NO --no-same-owner). No hub, no agent: only docker.
# Pass: owners 999/70/1000, modes 0600/0700/0750, hard link, symlinks, long and unicode names, the FIFO and every content hash
# survive; a truncated archive is refused. Holes in a sparse file are NOT preserved (GNU tar without -S stores zeros): that is
# recorded as a documented limit, never a failure. The same extraction is also a `dockerit` Go test (agent-docker-it in CI).
# Usage: scripts/lab/vx-tar-fidelity.sh   (builds $LAB_IMAGE from this checkout when it is not present)
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

lab_need docker
SRC=lab-l4-src
DST=lab-l4-dst
HELPER="$(lab_helper_image)"
ARCHIVE="$LAB_DIR/l4.tar"
SPARSE_MIB="${L4_SPARSE_MIB:-512}"
trap 'docker volume rm -f "$SRC" "$DST" >/dev/null 2>&1 || true; rm -f "$ARCHIVE" "$ARCHIVE.2"' EXIT

if ! docker image inspect "$LAB_IMAGE" >/dev/null 2>&1; then
  lab_log "building the agent image $LAB_IMAGE"
  docker build -q -f "$LAB_ROOT/deploy/Dockerfile.agent" -t "$LAB_IMAGE" "$LAB_ROOT" >/dev/null
fi
docker pull -q "$HELPER" >/dev/null

docker volume rm -f "$SRC" "$DST" >/dev/null 2>&1 || true
"$LAB_SELF_DIR/fixture.sh" "$SRC" 8 random
# a sparse file with data at the start, in the middle and at the very end
docker run --rm -v "$SRC":/data "$HELPER" sh -c '
  cd /data
  truncate -s "$1"M sparse.bin
  printf HEAD | dd of=sparse.bin bs=1 seek=0 conv=notrunc 2>/dev/null
  printf MIDDLE | dd of=sparse.bin bs=1 seek=$(( $1 * 524288 )) conv=notrunc 2>/dev/null
  printf TAIL | dd of=sparse.bin bs=1 seek=$(( $1 * 1048576 - 4 )) conv=notrunc 2>/dev/null
  echo setuid > suid.sh && chmod 4755 suid.sh && chown 1000:1000 suid.sh' _ "$SPARSE_MIB"

tar_stream() {
  docker run --rm -v "$SRC":/data:ro --entrypoint tar "$LAB_IMAGE" --sort=name --numeric-owner --format=gnu -C /data -cf - .
}
tar_stream >"$ARCHIVE"
tar_stream >"$ARCHIVE.2"
lab_check "the archive is deterministic (resume compares raw slice hashes)" cmp -s "$ARCHIVE" "$ARCHIVE.2"
rm -f "$ARCHIVE.2"
lab_log "archive: $(wc -c <"$ARCHIVE" | tr -d ' ') bytes"

# 1. validate (safeWipeExtract step 1-3)
docker run --rm -i "$HELPER" tar -tf - <"$ARCHIVE" >"$LAB_DIR/l4.list" || lab_die "busybox rejects the migrator archive (the apply would exit 72)"
lab_check "the listing is not empty" test -s "$LAB_DIR/l4.list"
lab_check "no absolute or .. entry" bash -c "! LC_ALL=C grep -Eq '^/|(^|/)[.][.](/|\$)' '$LAB_DIR/l4.list'"
LONGNAME="$(printf 'n%.200d' 0)"
LONGDIR="$(printf 'd%.60d' 0)/$(printf 'e%.60d' 0)/$(printf 'f%.60d' 0)"
lab_check "the 200 character name is listed" grep -qF -- "$LONGNAME" "$LAB_DIR/l4.list"
lab_check "the 3 x 61 character path is listed" grep -qF -- "$LONGDIR/f.txt" "$LAB_DIR/l4.list"

# 2. wipe + extract, byte for byte the command the target runs (drain mode: tar's own exit code is kept)
docker volume create "$DST" >/dev/null
docker run --rm -v "$DST":/data "$HELPER" sh -c 'mkdir -p /data/old/deep && echo junk > /data/old/deep/x && echo j > /data/.hidden'
docker run --rm -i -v "$DST":/data "$HELPER" sh -c 'cd /data && find . -mindepth 1 -delete; tar -xf -; r=$?; cat >/dev/null; exit $r' <"$ARCHIVE" \
  || lab_die "busybox extract failed (the apply would exit 71 and roll back)"
lab_check "the wipe removed the old content" bash -c "! docker run --rm -v $DST:/data:ro $HELPER sh -c 'test -e /data/old || test -e /data/.hidden'"

# 3. field-level comparison (owner, mode, type, size, hard links, file mtimes, symlink targets, content hashes)
"$LAB_SELF_DIR/compare.sh" "$SRC" "$DST"

# 4. the entries the runbook names, so a regression says which one
st() { docker run --rm -v "$DST":/data:ro "$HELPER" stat -c "$2" "/data/$1"; }
lab_check "secret is 999:999 0700" test "$(st secret '%u:%g %a')" = "999:999 700"
lab_check "secret/f is 999:999 0600" test "$(st secret/f '%u:%g %a')" = "999:999 600"
lab_check "empty is 70:70 0750" test "$(st empty '%u:%g %a')" = "70:70 750"
lab_check "run.sh is owned by 1000:1000" test "$(st run.sh '%u:%g')" = "1000:1000"
lab_check "hard link, symlinks and FIFO exist" docker run --rm -v "$DST":/data:ro "$HELPER" sh -c '[ /data/a -ef /data/a.hardlink ] && [ "$(readlink /data/a.symlink)" = a ] && [ -L /data/dangling ] && [ -p /data/fifo ]'
lab_check "the unicode and spaced names survive" docker run --rm -v "$DST":/data:ro "$HELPER" sh -c 'cat "/data/ünï-dir/ü.txt" >/dev/null && cat "/data/dir with spaces/x y.txt" >/dev/null'
lab_log "setuid file on the target: $(st suid.sh '%u:%g %a') (source 1000:1000 4755; a lost setuid bit is recorded, not failed)"

# 5. the documented sparse limit
du_of() { docker run --rm -v "$1":/data:ro "$HELPER" sh -c 'echo "$(du -k /data/sparse.bin | cut -f1) KiB on disk, $(stat -c %s /data/sparse.bin) bytes"'; }
lab_log "sparse.bin source: $(du_of "$SRC")"
lab_log "sparse.bin target: $(du_of "$DST") (holes are not preserved: GNU tar without -S stores zeros; content is identical)"

# 6. a truncated archive must FAIL, never apply half a volume
docker volume rm -f "$DST" >/dev/null; docker volume create "$DST" >/dev/null
total="$(wc -c <"$ARCHIVE" | tr -d ' ')"
if head -c $(( total / 2 + 7 )) "$ARCHIVE" | docker run --rm -i -v "$DST":/data "$HELPER" sh -c 'cd /data && tar -xf -; r=$?; cat >/dev/null; exit $r' 2>/dev/null; then
  lab_die "a truncated archive extracted cleanly"
fi
lab_pass "L4 tar fidelity into busybox"
