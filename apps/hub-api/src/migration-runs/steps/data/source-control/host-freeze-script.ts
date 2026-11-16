/**
 * The REMOTE freeze script of the `coolify-host-loop` runner: what the loop runs on ONE source host over ssh to stop (and, on an
 * abort, start again) the writers of that host, with the same safety rules as the same-host `agent` controller
 * (`source-scripts.ts`):
 *  - it stops ONLY containers it DISCOVERED and RECORDED, by their immutable id, after verifying id + name + image (a recreated
 *    container with the same name is a `mismatch`, never touched); there is no `docker rm`, `kill` or `prune` in it,
 *  - the record is written to the host (`/etc/tugra/migrate/<run>-freeze/record`, a 0700 directory) BEFORE the first stop, and
 *    only containers that are RUNNING at that moment are recorded (a container the owner had stopped is never started again),
 *  - a stop-list item no container matches blocks the stop (`unresolved-items`) until the operator, who can look at the host,
 *    attests it on the hub and the script is minted again with `F_ALLOW_UNRESOLVED=1`: fail closed, like the agent controller,
 *  - re-running it is safe: an existing record is re-reported and stopped again (idempotent); `unfreeze` starts exactly the
 *    recorded containers and archives the record.
 *
 * Constant text: the run-specific values arrive in the variables `F_REF`, `F_RUNID`, `F_ACTION`, `F_ITEMS` (newline-joined
 * itemRefs), `F_GRACE` and `F_ALLOW_UNRESOLVED`, set by a PRELUDE ({@link freezePrelude}) of validated assignments. It carries no
 * token: nothing here talks to the hub; the loop posts what this prints.
 */
import { IDENT, shq } from "./source-scripts";
import { MIGRATE_RUN_ROOT } from "../launcher/migrator-launcher";

export const FREEZE_ACTIONS = ["freeze", "unfreeze"] as const;
export type FreezeAction = (typeof FREEZE_ACTIONS)[number];

const RUN_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const REF_RE = /^[A-Za-z0-9_-]{1,128}$/;
const ITEM_RE = /^(app|service|database):[A-Za-z0-9_-]{1,128}:[A-Za-z0-9_-]{1,128}$/;

export interface FreezePreludeInput {
  ref: string;
  runId: string;
  action: FreezeAction;
  items: readonly string[];
  graceSec: number;
  allowUnresolved: boolean;
}

/** The assignments that parameterize {@link FREEZE_TEMPLATE}. Every value is validated here; none can contain a quote. */
export function freezePrelude(i: FreezePreludeInput): string {
  if (!REF_RE.test(i.ref) || !RUN_ID_RE.test(i.runId) || !(FREEZE_ACTIONS as readonly string[]).includes(i.action)) throw new Error("invalid freeze input");
  if (!Number.isInteger(i.graceSec) || i.graceSec < 1 || i.graceSec > 3600) throw new Error("invalid grace");
  if (i.items.length > 2000 || i.items.some((x) => !ITEM_RE.test(x))) throw new Error("invalid freeze item");
  return [`F_REF='${i.ref}'`, `F_RUNID='${i.runId}'`, `F_ACTION='${i.action}'`, `F_GRACE='${i.graceSec}'`, `F_ALLOW_UNRESOLVED='${i.allowUnresolved ? 1 : 0}'`, `F_ITEMS='${i.items.join("\n")}'`, ""].join("\n");
}

/** `@{` is written for the shell's brace expansion so the text can live in a `String.raw` template. */
const BODY = String.raw`
set -u
umask 077
TAB=$(printf '\t')
D=@ROOT@/"$F_RUNID"-freeze
fz() { printf 'TUGRA_AT\t%s\tTUGRA_FZ\t%s\n' "$F_REF" "$1"; }
fz "action$TAB$F_ACTION"
mkdir -p "$D" 2>/dev/null && chmod 700 "$D" 2>/dev/null || { fz "error@{TAB}mkdir-failed"; exit 0; }
@IDENT@
valid_rec() {
  case "$1" in ''|*[!0-9a-f]*) return 1 ;; esac
  [ "@{#1}" -eq 64 ] || return 1
  case "$2" in ''|*[!A-Za-z0-9_.-]*|[!A-Za-z0-9]*) return 1 ;; esac
  case "$3" in ''|*[!A-Za-z0-9._/:@-]*|[!A-Za-z0-9]*) return 1 ;; esac
  return 0
}
discover() {
  docker ps -a --no-trunc --format '{{.ID}}|{{.Names}}|{{.Image}}|{{.Ports}}|{{.State}}' > "$D/ps.tmp" 2>/dev/null </dev/null || return 1
  : > "$D/rec.tmp"
  : > "$D/unres.tmp"
  printf '%s\n' "$F_ITEMS" | while IFS= read -r item; do
    [ -n "$item" ] || continue
    kind=@{item%%:*}
    uuid=@{item##*:}
    found=0
    while IFS='|' read -r id name image ports state; do
      m=0
      case "$name" in
        "$uuid") m=1 ;;
        "$uuid"-*) sfx=@{name#"$uuid"-}; case "$sfx" in ''|*[!0-9]*) ;; *) [ "@{#sfx}" -ge 6 ] && m=1 ;; esac ;;
      esac
      if [ "$kind" = service ] && [ "$m" = 0 ]; then case "$name" in ?*-"$uuid") m=1 ;; esac; fi
      [ "$m" = 1 ] || continue
      found=1
      printf 'TUGRA_AT\t%s\tTUGRA_CTR\t%s\t%s\t%s\t%s\t%s\t%s\n' "$F_REF" "$item" "$id" "$name" "$image" "$ports" "$state"
      if [ "$state" = running ]; then printf '%s\t%s\t%s\t%s\t%s\n' "$item" "$id" "$name" "$image" "$ports" >> "$D/rec.tmp"; fi
    done < "$D/ps.tmp"
    if [ "$found" = 0 ]; then
      fz "unresolved$TAB$item"
      printf '%s\n' "$item" >> "$D/unres.tmp"
    fi
  done
  return 0
}
bad=0
if [ "$F_ACTION" = freeze ]; then
  if [ ! -f "$D/record" ]; then
    discover || { fz "error@{TAB}docker-ps"; exit 0; }
    if [ -s "$D/unres.tmp" ] && [ "$F_ALLOW_UNRESOLVED" != 1 ]; then
      rm -f "$D/rec.tmp"
      fz "error@{TAB}unresolved-items"
      exit 0
    fi
    mv "$D/rec.tmp" "$D/record"
  else
    while IFS="$TAB" read -r item id name image ports; do
      [ -n "$id" ] || continue
      valid_rec "$id" "$name" "$image" || continue
      printf 'TUGRA_AT\t%s\tTUGRA_CTR\t%s\t%s\t%s\t%s\t%s\trunning\n' "$F_REF" "$item" "$id" "$name" "$image" "$ports"
    done < "$D/record"
  fi
  while IFS="$TAB" read -r item id name image ports; do
    [ -n "$id" ] || continue
    valid_rec "$id" "$name" "$image" || { bad=1; continue; }
    ident "$id" "$name" "$image"; r=$?
    if [ "$r" = 2 ]; then o=gone
    elif [ "$r" = 1 ]; then o=mismatch
    elif docker stop -t "$F_GRACE" "$id" >/dev/null 2>&1 </dev/null; then o=stopped
    else o=failed
    fi
    printf 'TUGRA_AT\t%s\tTUGRA_STOP\t%s\t%s\n' "$F_REF" "$id" "$o"
  done < "$D/record"
elif [ "$F_ACTION" = unfreeze ]; then
  [ -f "$D/record" ] || { fz "error@{TAB}no-record"; exit 0; }
  while IFS="$TAB" read -r item id name image ports; do
    [ -n "$id" ] || continue
    valid_rec "$id" "$name" "$image" || { bad=1; continue; }
    ident "$id" "$name" "$image"; r=$?
    if [ "$r" = 2 ]; then o=gone
    elif [ "$r" = 1 ]; then o=mismatch
    elif docker start "$id" >/dev/null 2>&1 </dev/null; then o=started
    else o=failed
    fi
    printf 'TUGRA_AT\t%s\tTUGRA_START\t%s\t%s\n' "$F_REF" "$id" "$o"
  done < "$D/record"
  mv "$D/record" "$D/record.done-$(date +%s)"
fi
if [ "$bad" = 1 ]; then fz "error@{TAB}record-invalid"; else fz done; fi
exit 0
`;

/** The remote freeze script; `root` is the host directory under which the per-run record lives (default `/etc/tugra/migrate`). */
export function buildFreezeTemplate(root: string = MIGRATE_RUN_ROOT): string {
  if (!/^\/[A-Za-z0-9._/-]+$/.test(root)) throw new Error("invalid freeze root");
  return BODY.replace(/^\n/, "")
    .replaceAll("@{", () => "${")
    .replace("@ROOT@", () => shq(root))
    .replace("@IDENT@", () => IDENT.join("\n"));
}
