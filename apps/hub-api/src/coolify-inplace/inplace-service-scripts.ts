/**
 * Hub-built host scripts of the in-place takeover of a Coolify compose service, and the fail-closed parsers of what they print. They run on
 * the server the service already lives on, through the agent's `deploy` capability, like every script of the takeover.
 *
 * The same source-safety rules as the rest of the lane: nothing here runs `docker rm`, `kill`, `prune` or `volume rm`; Coolify's containers,
 * images and volumes are only read; no environment is asked for; only the compose service name label of a container is read (never another
 * label value); every value that reaches a shell is validated first and then single-quoted.
 */
import { shq } from "../deploy/deploy-script";
import { EXACT_IMAGE_LINES, IP_MARK, isHex64, parseContainerDetail, type CtrDetail, type RecordedCtr } from "./inplace-scripts";
import type { CtrNetwork, MemberProbe, ServiceCtrFacts } from "./inplace-service";

export const SVC_MARK = {
  ctr: "TUGRA_IP_SVCCTR",
  net: "TUGRA_IP_NET",
  imgId: "TUGRA_IP_IMGID",
  imgEnd: "TUGRA_IP_IMGID_END",
  member: "TUGRA_IP_SVC",
  memberEnd: "TUGRA_IP_SVC_END",
} as const;

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/;
const VOL_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
const PROJECT_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const HOST_PATH_RE = /^\/[A-Za-z0-9._+/-]{0,500}$/;
const SERVICE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const MAX_REFS = 64;

const IDENT = [
  "ident() {",
  '  cur="$(docker inspect -f \'{{.Name}}|{{.Config.Image}}\' "$1" 2>/dev/null)" || return 2',
  '  [ "$cur" = "/$2|$3" ] || return 1',
  "  return 0",
  "}",
];

function assertRecorded(cs: readonly RecordedCtr[]): void {
  for (const c of cs) if (!isHex64(c.id) || !NAME_RE.test(c.name) || !IMAGE_RE.test(c.image)) throw new Error("inplace-service: invalid recorded container");
}

// ───────────────────────────── what Coolify runs for the service (read-only) ─────────────────────────────

/**
 * Per recorded container: what the app detail script reads (restart policy, image id, mounts) and, besides, its compose service name, the
 * networks it is on with its aliases there, and how many host ports it publishes. No environment, no other label, no command line.
 */
export function buildServiceDetailScript(containers: readonly RecordedCtr[]): string {
  assertRecorded(containers);
  return [
    "set -u",
    ...IDENT,
    "detail() {",
    '  ident "$1" "$2" "$3" || return 0',
    `  printf '${IP_MARK.restart}|%s|%s\\n' "$1" "$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$1" 2>/dev/null)"`,
    `  printf '${IP_MARK.image}|%s|%s\\n' "$1" "$(docker inspect -f '{{.Image}}' "$1" 2>/dev/null)"`,
    ...EXACT_IMAGE_LINES,
    `  docker inspect -f '{{range .Mounts}}${IP_MARK.mount}|{{$.Id}}|{{.Type}}|{{.Name}}|{{.Source}}|{{.Destination}}|{{.RW}}{{"\\n"}}{{end}}' "$1" 2>/dev/null`,
    `  printf '${SVC_MARK.ctr}|%s|%s|%s\\n' "$1" "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$1" 2>/dev/null)" "$(docker inspect -f '{{len .HostConfig.PortBindings}}' "$1" 2>/dev/null)"`,
    `  docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}${SVC_MARK.net}|{{$.Id}}|{{$k}}|{{range $v.Aliases}}{{.}},{{end}}{{"\\n"}}{{end}}' "$1" 2>/dev/null`,
    "}",
    ...containers.map((c) => `detail ${shq(c.id)} ${shq(c.name)} ${shq(c.image)}`),
    `echo ${IP_MARK.detailEnd}`,
    "",
  ].join("\n");
}

const NET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/** Parse the service detail output, keyed by container id. A container with no restart and image line is absent; a cut output is null. */
export function parseServiceDetail(out: string, containers: readonly RecordedCtr[]): Map<string, ServiceCtrFacts> | null {
  const base = parseContainerDetail(out, containers.map((c) => c.id));
  if (!base) return null;
  const svc = new Map<string, string | null>();
  const published = new Map<string, number>();
  const nets = new Map<string, CtrNetwork[]>();
  for (const l of out.split(/\r?\n/)) {
    const f = l.split("|");
    if (f[0] === SVC_MARK.ctr && f.length === 4) {
      svc.set(f[1], SERVICE_RE.test(f[2]) ? f[2] : null);
      published.set(f[1], /^\d{1,4}$/.test(f[3]) ? Number(f[3]) : 0);
    } else if (f[0] === SVC_MARK.net && f.length === 4 && NET_NAME_RE.test(f[2])) {
      const aliases = f[3].split(",").filter((a) => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,126}$/.test(a));
      nets.set(f[1], [...(nets.get(f[1]) ?? []), { name: f[2], aliases }]);
    }
  }
  const res = new Map<string, ServiceCtrFacts>();
  for (const c of containers) {
    const d: CtrDetail | undefined = base.get(c.id);
    if (!d || !svc.has(c.id)) continue; // a container whose service line is missing is unreadable, not "has no service"
    res.set(c.id, { id: c.id, name: c.name, image: c.image, imageId: d.imageId, ...(d.repoDigests ? { repoDigests: d.repoDigests } : {}), ...(d.imageVersion ? { imageVersion: d.imageVersion } : {}), restart: d.restart, service: svc.get(c.id) ?? null, mounts: d.mounts, networks: nets.get(c.id) ?? [], published: published.get(c.id) ?? 0 });
  }
  return res;
}

// ───────────────────────────── is it the same image? ─────────────────────────────

/** For each image reference: the id of the image the host has under that name (`missing` when it has none). Read-only. */
export function buildImageIdsScript(refs: readonly string[]): string {
  if (refs.length === 0 || refs.length > MAX_REFS) throw new Error("inplace-service: image count out of range");
  for (const r of refs) if (!IMAGE_RE.test(r)) throw new Error("inplace-service: invalid image");
  return [
    "set -u",
    "one() {",
    '  id="$(docker image inspect -f \'{{.Id}}\' "$1" 2>/dev/null)" || id=""',
    `  case "$id" in sha256:*) printf '${SVC_MARK.imgId}|%s|%s\\n' "$1" "$id";; *) printf '${SVC_MARK.imgId}|%s|missing\\n' "$1";; esac`,
    "}",
    ...refs.map((r) => `one ${shq(r)}`),
    `echo ${SVC_MARK.imgEnd}`,
    "",
  ].join("\n");
}

/** Parse the image ids: every reference asked for must be answered, or the output is null (never a partial pass). */
export function parseImageIds(out: string, refs: readonly string[]): Map<string, string | "missing"> | null {
  if (out.includes("…(truncated)")) return null;
  const lines = out.split(/\r?\n/);
  if (!lines.includes(SVC_MARK.imgEnd)) return null;
  const want = new Set(refs);
  const res = new Map<string, string | "missing">();
  for (const l of lines) {
    const f = l.split("|");
    if (f[0] !== SVC_MARK.imgId || f.length !== 3 || !want.has(f[1])) continue;
    if (f[2] === "missing" || /^sha256:[0-9a-f]{64}$/.test(f[2])) res.set(f[1], f[2]);
  }
  return res.size === want.size ? res : null;
}

// ───────────────────────────── the data: volume aliases, no copy ─────────────────────────────

export interface ServiceVolumeAlias {
  /** `volume`: another docker volume's data directory. `bind`: a host folder. */
  kind: "volume" | "bind";
  /** The Coolify volume name, or the absolute host folder. */
  from: string;
  /** The docker volume the Tugra compose app mounts. */
  to: string;
  /** The compose project and the volume key: stamped on a new volume so compose treats it as its own. */
  project: string;
  key: string;
}

/**
 * Make the compose app's named volume point at the data Coolify's container already has, with no copy: a local-driver bind volume whose
 * device is the other volume's data directory (or the host folder). A volume that already exists is left alone: `present` when it is such an
 * alias of the same place, `foreign` when it is anything else (the takeover refuses: it may hold data of its own). Prints `TUGRA_IP_ALIAS|<to>|<outcome>`,
 * the same marks as the app volume alias, so the same parser reads it.
 */
export function buildServiceVolumeScript(aliases: readonly ServiceVolumeAlias[]): string {
  for (const a of aliases) {
    if (!VOL_RE.test(a.to) || !PROJECT_RE.test(a.project) || !KEY_RE.test(a.key)) throw new Error("inplace-service: invalid volume alias");
    if (a.kind === "volume" ? !VOL_RE.test(a.from) : !HOST_PATH_RE.test(a.from) || a.from.includes("..")) throw new Error("inplace-service: invalid volume source");
  }
  const M = IP_MARK.alias;
  return [
    "set -u",
    "alias_one() {",
    // $1 kind, $2 source, $3 volume, $4 project, $5 key
    '  if [ "$1" = bind ]; then',
    '    src="$2"; [ -d "$src" ] || { printf \'' + M + "|%s|nosource\\n' \"$3\"; return; }",
    "  else",
    `    src="$(docker volume inspect -f '{{.Mountpoint}}' "$2" 2>/dev/null)" || { printf '${M}|%s|nosource\\n' "$3"; return; }`,
    `    case "$src" in /*) ;; *) printf '${M}|%s|nosource\\n' "$3"; return;; esac`,
    "  fi",
    '  if docker volume inspect "$3" >/dev/null 2>&1; then',
    `    dev="$(docker volume inspect -f '{{index .Options "device"}}' "$3" 2>/dev/null)"`,
    `    if [ "$dev" = "$src" ]; then printf '${M}|%s|present\\n' "$3"; else printf '${M}|%s|foreign\\n' "$3"; fi`,
    "    return",
    "  fi",
    `  if docker volume create --driver local --opt type=none --opt o=bind --opt "device=$src" --label "com.docker.compose.project=$4" --label "com.docker.compose.volume=$5" "$3" >/dev/null 2>&1; then printf '${M}|%s|created\\n' "$3"; else printf '${M}|%s|failed\\n' "$3"; fi`,
    "}",
    ...aliases.map((a) => `alias_one ${shq(a.kind)} ${shq(a.from)} ${shq(a.to)} ${shq(a.project)} ${shq(a.key)}`),
    "",
  ].join("\n");
}

// ───────────────────────────── is every member up? ─────────────────────────────

/** Read-only: every container of Tugra's compose project, with its compose service, state, health and restart count. */
export function buildServiceReadyScript(project: string): string {
  if (!PROJECT_RE.test(project)) throw new Error("inplace-service: invalid project");
  return [
    "set -u",
    `P=${shq(project)}`,
    'for id in $(docker ps -aq --no-trunc --filter "label=com.docker.compose.project=$P" 2>/dev/null); do',
    `  docker inspect -f '${SVC_MARK.member}|{{index .Config.Labels "com.docker.compose.service"}}|{{.Name}}|{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.RestartCount}}' "$id" 2>/dev/null`,
    "done",
    `echo ${SVC_MARK.memberEnd}`,
    "",
  ].join("\n");
}

/** Parse the members. `null` for a cut output or one with no END marker; a line that fails any check is dropped (never trusted as a pass). */
export function parseServiceReady(out: string): MemberProbe[] | null {
  if (out.includes("…(truncated)")) return null;
  const lines = out.split(/\r?\n/);
  if (!lines.includes(SVC_MARK.memberEnd)) return null;
  const res: MemberProbe[] = [];
  for (const l of lines) {
    const f = l.split("|");
    if (f[0] !== SVC_MARK.member || f.length !== 6) continue;
    const name = f[2].replace(/^\//, "");
    if (!SERVICE_RE.test(f[1]) || !NAME_RE.test(name) || !/^[a-z]{3,12}$/.test(f[3]) || !/^\d{1,9}$/.test(f[5])) continue;
    const health = f[4] === "healthy" || f[4] === "unhealthy" || f[4] === "starting" || f[4] === "none" ? f[4] : null;
    if (!health) continue;
    res.push({ service: f[1], name, state: f[3], health, restarts: Number(f[5]) });
  }
  return res;
}
