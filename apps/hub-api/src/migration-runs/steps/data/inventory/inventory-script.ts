/**
 * The read-only HOST INVENTORY, as a POSIX-sh function served inside `GET /install/migrator.sh` (`--inventory`). It answers
 * what the Coolify API cannot: which containers, volumes and bind mounts really exist on a source host (R2/C6/R6/C19) and
 * whether the host can reach the hub and with what request-body cap (R8).
 *
 * Properties (all asserted by `inventory-script.spec.ts`, which runs the function for real against a fake docker/du/curl):
 *  - READ-ONLY: it calls only `docker ps`, `docker inspect`, `docker volume ls|inspect`, `docker version`, `du`, `hostname` and
 *    `curl` to the hub. No `rm`, `stop`, `kill` or `prune` of anything on the host, other than its own temp directory.
 *  - SIZES ARE MEASURED, NEVER GUESSED (C19): `docker system df -v` cannot see bind-mounted data, so every bind source and every
 *    volume mountpoint is measured with `du -skx`. A path `du` cannot read (or that takes longer than TUGRA_DU_TIMEOUT seconds,
 *    default 300) is reported as `unknown`, never as 0.
 *  - NO SECRET ON AN ARGV: the migration token is handed to curl as a config file on stdin (`--config -`), built by the `printf`
 *    builtin; it is on no process argument list.
 *  - EVERY LINE IS SELF-LABELLED with the source server it concerns (`--server-ref`, default `_`) and the whole report is
 *    closed by an `end` line carrying the number of lines before it, so the hub can tell a truncated upload from a whole one.
 *  - The reach probe sends a SPARSE file (no disk used) of the hub's configured part size, then smaller sizes, and reports the
 *    largest the hub accepted: a proxy that caps request bodies (100 MB on a common CDN) makes the larger ones fail.
 *
 * The text uses no `${`: it is a `String.raw` template, and the shell it contains avoids brace expansion for that reason.
 */

/** The routes the probe talks to (token-authenticated, see `host-report.controller.ts`). */
export const HOST_PROBE_PING_PATH = "/import/migration/host-probe/ping";
export const HOST_PROBE_SINK_PATH = "/import/migration/host-probe/sink";
export const HOST_REPORT_PATH = "/import/migration/host-report";

/** The largest sink body the hub accepts (bigger than any part: the vx part size tops out at 512 MiB, probes stay at the hub policy). */
export const PROBE_MAX_BYTES = 520 * 1024 * 1024;

const SCRIPT = String.raw`
tugra_du_kib() {
  # print the size of $1 in KiB, or "unknown" when it cannot be measured (never 0 for a failure)
  r=""
  if command -v timeout >/dev/null 2>&1; then r=$(timeout "$DUT" du -skx "$1" 2>/dev/null) || r=""; else r=$(du -skx "$1" 2>/dev/null) || r=""; fi
  k=$(printf '%s' "$r" | cut -f1)
  case "$k" in ''|*[!0-9]*) printf 'unknown' ;; *) printf '%s' "$k" ;; esac
}

tugra_inventory() {
  # $1 = the source server ref this host is (label only), $2 = the hub base. The token is in $TUGRA_MIGRATION_TOKEN.
  set +eu
  REF=$1
  HUBB=$2
  TK=$TUGRA_MIGRATION_TOKEN
  T=$(printf '\t')
  command -v docker >/dev/null 2>&1 || die "Docker is required on this host" 6
  DUT=$TUGRA_DU_TIMEOUT
  case "$DUT" in ''|*[!0-9]*) DUT=300 ;; esac
  W=/tmp/tugra-inventory.$$
  mkdir -m 700 "$W" 2>/dev/null || die "cannot create a temporary directory" 6
  trap 'rm -rf "$W"' EXIT
  OUT=$W/out
  : > "$OUT"
  emit() {
    line="TUGRA_AT$T$REF$T"TUGRA_INV
    for f in "$@"; do line="$line$T$f"; done
    printf '%s\n' "$line" >> "$OUT"
  }
  cfg() { printf 'header = "Authorization: Bearer %s"\n' "$TK"; }
  clean() { printf '%s' "$1" | tr '\t\r\n' '???'; }

  hn=$(clean "$(hostname 2>/dev/null)")
  dv=$(clean "$(docker version --format '{{.Server.Version}}' 2>/dev/null)")
  os=$(clean "$( . /etc/os-release 2>/dev/null; printf '%s' "$PRETTY_NAME")")
  emit host "$hn" "$dv" "$os"

  docker ps -a --no-trunc --format '{{.ID}}|{{.Names}}|{{.Image}}|{{.State}}' > "$W/ps" 2>/dev/null </dev/null || die "docker ps failed (is the Docker daemon running?)" 6
  : > "$W/used"
  : > "$W/binds"
  while IFS='|' read -r id name image state; do
    [ -n "$id" ] || continue
    emit ctr "$id" "$name" "$image" "$state"
    docker inspect -f '{{range .Mounts}}{{.Type}}|{{.Name}}|{{.Source}}|{{.Destination}}|{{.RW}}{{"\n"}}{{end}}' "$id" > "$W/m" 2>/dev/null </dev/null
    while IFS='|' read -r mt mn ms md mrw; do
      case "$mt" in
        volume) emit mount "$id" volume "$mn" "$(clean "$ms")" "$(clean "$md")" "$mrw"; printf '%s\n' "$mn" >> "$W/used" ;;
        bind) emit mount "$id" bind - "$(clean "$ms")" "$(clean "$md")" "$mrw"; printf '%s\n' "$ms" >> "$W/binds" ;;
      esac
    done < "$W/m"
  done < "$W/ps"

  docker volume ls -q > "$W/vols" 2>/dev/null </dev/null
  while IFS= read -r v; do
    [ -n "$v" ] || continue
    mp=$(docker volume inspect -f '{{.Mountpoint}}' "$v" 2>/dev/null </dev/null)
    [ -n "$mp" ] || mp=/var/lib/docker/volumes/$v/_data
    ln=$(grep -cxF -- "$v" "$W/used" 2>/dev/null)
    [ -n "$ln" ] || ln=0
    emit vol "$v" "$(clean "$mp")" "$(tugra_du_kib "$mp")" "$ln"
  done < "$W/vols"

  sort -u "$W/binds" > "$W/binds2" 2>/dev/null
  while IFS= read -r b; do
    [ -n "$b" ] || continue
    [ -S "$b" ] && continue
    emit bind "$(clean "$b")" "$(tugra_du_kib "$b")"
  done < "$W/binds2"

  cnt=$(wc -l < "$OUT" | tr -cd '0-9')
  emit end "$cnt"

  if [ -z "$TUGRA_NO_REACH" ]; then tugra_reach_probe; fi
  cat "$OUT"
  if [ -z "$TUGRA_NO_POST" ]; then
    code=$(cfg | curl -sS --max-time 60 --config - -X POST -H 'Content-Type: text/plain' --data-binary "@$OUT" -o /dev/null -w '%{http_code}' "$HUBB/import/migration/host-report" 2>/dev/null)
    printf 'TUGRA_POST\t%s\n' "$code" >&2
  fi
  return 0
}

tugra_reach_probe() {
  ping=000
  part=-
  max=-
  failed=-
  secs=-
  ping=$(cfg | curl -sS --max-time 20 --config - -o "$W/ping" -w '%{http_code}' "$HUBB/import/migration/host-probe/ping" 2>/dev/null)
  case "$ping" in [0-9][0-9][0-9]) ;; *) ping=000 ;; esac
  if [ "$ping" = 200 ]; then
    part=$(sed -n 's/.*"partMiB":\([0-9][0-9]*\).*/\1/p' "$W/ping" | head -n 1)
    case "$part" in ''|*[!0-9]*) part=- ;; esac
  fi
  if [ "$part" != - ] && [ "$part" -ge 1 ] && [ "$part" -le 512 ]; then
    max=0
    last=0
    for sz in "$part" 64 32; do
      [ "$sz" -le "$part" ] || continue
      [ "$sz" -ne "$last" ] || continue
      last=$sz
      dd if=/dev/null of="$W/probe" bs=1048576 seek="$sz" count=0 2>/dev/null
      t0=$(date +%s)
      code=$(cfg | curl -sS --max-time 900 --config - -X POST -T "$W/probe" -H 'Content-Type: application/octet-stream' -o /dev/null -w '%{http_code}' "$HUBB/import/migration/host-probe/sink" 2>/dev/null)
      t1=$(date +%s)
      if [ "$code" = 200 ]; then
        max=$sz
        secs=$((t1 - t0))
        break
      fi
      failed=$sz
    done
    rm -f "$W/probe"
  else
    part=-
  fi
  printf 'TUGRA_AT\t%s\tTUGRA_REACH\t%s\t%s\t%s\t%s\t%s\n' "$REF" "$ping" "$part" "$max" "$failed" "$secs" >> "$OUT"
}
`;

/** The shell lines (functions) `migrator.sh` embeds before its `main()`. */
export function inventoryShellLines(): string[] {
  return SCRIPT.replace(/^\n/, "").split("\n");
}

/** The `ref` charset the shell and the hub both accept for `--server-ref`. */
export const SERVER_REF_SHELL_RE = /^[A-Za-z0-9_-]{1,128}$/;
