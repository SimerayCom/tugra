import { shq } from "../../../deploy/deploy-script";

/**
 * DECOMMISSION scripts (design 4): STOP-ONLY. They discover the Coolify-managed containers on the source host, stop the
 * exact ids the operator approved, and verify the result. Nothing here ever runs `docker rm` or touches a volume: the
 * removal commands are only PRINTED ({@link REMOVAL_COMMANDS}) for the operator to run when they are sure of their backups.
 */

const ID_RE = /^[a-f0-9]{12,64}$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
export const DECOMMISSION_MAX_CONTAINERS = 500;

export interface SourceContainer {
  id: string;
  name: string;
  running: boolean;
}

/** Containers Coolify manages on a host (label `coolify.managed=true`), including stopped ones. Read-only; never lists a `tugra*` container. */
export function buildDecommissionDiscoverScript(): string {
  return [
    "set -u",
    `docker ps -a --filter label=coolify.managed=true --format '{{.ID}} {{.Names}} {{.State}}' 2>/dev/null | while read -r id name state; do`,
    '  case "$name" in tugra*) continue;; esac',
    '  r=false; [ "$state" = "running" ] && r=true',
    `  printf 'TUGRA_SRC id=%s name=%s running=%s\\n' "$id" "$name" "$r"`,
    "done",
    'echo "TUGRA_SRC_END"',
  ].join("\n");
}

const SRC_RE = /^TUGRA_SRC id=([a-f0-9]{12,64}) name=([A-Za-z0-9][A-Za-z0-9_.-]{0,127}) running=(true|false)$/;

/** `null` when the output is cut (no END marker): never mistaken for "nothing to stop". */
export function parseDecommissionDiscover(out: string): SourceContainer[] | null {
  if (out.includes("…(truncated)")) return null;
  const lines = out.split(/\r?\n/);
  if (!lines.includes("TUGRA_SRC_END")) return null;
  const res: SourceContainer[] = [];
  for (const l of lines) {
    const m = SRC_RE.exec(l);
    if (m) res.push({ id: m[1], name: m[2], running: m[3] === "true" });
    if (res.length > DECOMMISSION_MAX_CONTAINERS) return null;
  }
  return res;
}

/** `docker stop` of EXACT ids (validated, quoted), then each id's running state. A removed id reports `absent`. */
export function buildDecommissionStopScript(ids: readonly string[]): string {
  if (ids.length === 0 || ids.length > DECOMMISSION_MAX_CONTAINERS) throw new Error("decommission: container count out of range");
  for (const id of ids) if (!ID_RE.test(id)) throw new Error("decommission: invalid container id");
  return [
    "set -u",
    `for ID in ${ids.map(shq).join(" ")}; do`,
    '  docker stop "$ID" >/dev/null 2>&1 || true',
    `  printf 'TUGRA_SRC_STATE id=%s running=%s\\n' "$ID" "$(docker container inspect -f '{{.State.Running}}' "$ID" 2>/dev/null || echo absent)"`,
    "done",
    'echo "TUGRA_SRC_STATE_END"',
  ].join("\n");
}

const STATE_RE = /^TUGRA_SRC_STATE id=([a-f0-9]{12,64}) running=(true|false|absent)$/;

export function parseDecommissionStop(out: string): Record<string, boolean | "absent"> | null {
  if (out.includes("…(truncated)")) return null;
  const lines = out.split(/\r?\n/);
  if (!lines.includes("TUGRA_SRC_STATE_END")) return null;
  const res: Record<string, boolean | "absent"> = {};
  for (const l of lines) {
    const m = STATE_RE.exec(l);
    if (m) res[m[1]] = m[2] === "absent" ? "absent" : m[2] === "true";
  }
  return res;
}

/** Printed for the operator to run themselves, on the SOURCE host, after stopping. Tugra never executes these. */
export const STOP_COMMANDS: readonly string[] = ["docker ps -q --filter label=coolify.managed=true | xargs -r docker stop", "docker stop coolify coolify-realtime coolify-redis coolify-db coolify-proxy"];
export const REMOVAL_COMMANDS: readonly string[] = [
  "docker ps -aq --filter label=coolify.managed=true | xargs -r docker rm",
  "docker rm coolify coolify-realtime coolify-redis coolify-db coolify-proxy",
];

/** Container names validated for the printed per-container removal command. */
export function removalCommandFor(names: readonly string[]): string | null {
  const ok = names.filter((n) => NAME_RE.test(n));
  return ok.length ? `docker rm ${ok.map(shq).join(" ")}` : null;
}
