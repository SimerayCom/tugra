import { createHash } from "node:crypto";
import type { CleanupKeepReason, CleanupRemnant } from "@tugra/shared";

/**
 * What Coolify left on a server (Coolify hub takeover, lane G), step one: a READ-ONLY listing script and the pure classification of
 * its output. Nothing here removes anything. The classification is an allow-list: only objects Coolify itself creates and that are
 * named below can ever become removable; everything else the scan sees is either ignored or shown as "kept" with a reason. A docker
 * volume is never a remnant: volumes hold the owner's data. The scan reads their NAMES only, so the completeness checklist can compare
 * them with Tugra's; they never enter the list of things to remove.
 */

export const SCAN_BEGIN = "TUGRA_CU_BEGIN";
export const SCAN_END = "TUGRA_CU_END";
export const SCAN_NO_DOCKER = "TUGRA_CU_NO_DOCKER";

export const COOLIFY_ROOT = "/data/coolify";
/** Coolify's own control plane. Present on a server = this is the Coolify host: never cleaned here (the hub box is retired last, separately). */
export const CONTROL_PLANE_CONTAINERS: readonly string[] = ["coolify", "coolify-db", "coolify-redis", "coolify-realtime", "coolify-minio", "coolify-testing-host"];
export const PROXY_CONTAINER = "coolify-proxy";
export const SENTINEL_CONTAINER = "coolify-sentinel";
/** Networks Coolify creates for itself (per-resource networks are named by the resource uuid and only count when the hub names the uuid). */
export const COOLIFY_NETWORKS: readonly string[] = ["coolify", "coolify-overlay"];
/** Directories under /data/coolify that hold only Coolify's own machinery. */
export const OWN_DIRECTORIES: readonly string[] = ["proxy", "ssh", "sentinel", "source", "metrics", "webhooks-during-maintenance"];
/** Directories that may hold the owner's data (database dumps, compose files with bind data): listed, never removed. */
export const DATA_DIRECTORIES: readonly string[] = ["databases", "backups"];

export const COOLIFY_IMAGE_RE = /^(ghcr\.io\/)?coollabsio\/(coolify|coolify-helper|coolify-realtime|sentinel|coolify-testing-host)(:[A-Za-z0-9_.-]{1,128})?$/;
export const HELPER_IMAGE_RE = /(^|\/)coollabsio\/coolify-helper(:|$)/;
export const SENTINEL_IMAGE_RE = /(^|\/)coollabsio\/sentinel(:|$)/;
export const UUID_RE = /^[a-z0-9]{16,40}$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/** The read-only listing. `uuids` are the Coolify resource uuids the hub knows on this server (their per-resource networks). */
export function buildScanScript(): string {
  return [
    "#!/bin/sh",
    "# Tugra: list what Coolify left on this server. Read-only: it changes nothing.",
    `command -v docker >/dev/null 2>&1 || { echo ${SCAN_NO_DOCKER}; exit 0; }`,
    `echo ${SCAN_BEGIN}`,
    `docker ps -a --format 'TUGRA_CU_C|{{.Names}}|{{.Image}}|{{.State}}|{{.Label "coolify.managed"}}' 2>/dev/null`,
    `for n in $(docker network ls --format '{{.Name}}' 2>/dev/null); do c=$(docker network inspect -f '{{len .Containers}}' "$n" 2>/dev/null); echo "TUGRA_CU_N|$n|\${c:-?}"; done`,
    `docker volume ls --format 'TUGRA_CU_V|{{.Name}}' 2>/dev/null`,
    `docker image ls --format 'TUGRA_CU_I|{{.Repository}}:{{.Tag}}|{{.ID}}|{{.Size}}' 2>/dev/null`,
    `for id in $(docker ps -aq 2>/dev/null); do docker inspect -f 'TUGRA_CU_M|{{.Name}}|{{range .Mounts}}{{.Source}};{{end}}' "$id" 2>/dev/null; done`,
    // A local volume that is a bind on a host folder (the in-place takeover makes one of every folder a Coolify container bound): a container
    // using it shows the volume's own mountpoint, not the folder, so the folder behind it is read here and counts as in use.
    `for v in $(docker volume ls -q 2>/dev/null); do d=$(docker volume inspect -f '{{index .Options "device"}}' "$v" 2>/dev/null); case "$d" in /*) echo "TUGRA_CU_B|$v|$d";; esac; done`,
    `if [ -d ${COOLIFY_ROOT} ]; then`,
    `  for d in ${COOLIFY_ROOT}/* ${COOLIFY_ROOT}/applications/* ${COOLIFY_ROOT}/services/* ${COOLIFY_ROOT}/databases/*; do`,
    `    [ -e "$d" ] || [ -L "$d" ] || continue`,
    `    case "$d" in ${COOLIFY_ROOT}/applications|${COOLIFY_ROOT}/services|${COOLIFY_ROOT}/databases) continue;; esac`,
    `    if [ -L "$d" ]; then echo "TUGRA_CU_D|$d|link"; continue; fi`,
    `    kb=$(du -sk "$d" 2>/dev/null | cut -f1)`,
    // Anything in a resource directory other than its compose file and .env is the owner's data (bind-mounted files, uploads, dumps).
    // An unreadable directory counts as data.
    `    data=plain`,
    `    case "$d" in ${COOLIFY_ROOT}/applications/*|${COOLIFY_ROOT}/services/*)`,
    `      if [ ! -r "$d" ] || [ ! -x "$d" ]; then data=data; else x=$(find "$d" -mindepth 1 ! -type d ! -name docker-compose.yaml ! -name docker-compose.yml ! -name .env 2>/dev/null | head -n 1); [ -n "$x" ] && data=data; fi;;`,
    `    esac`,
    `    echo "TUGRA_CU_D|$d|\${kb:-0}|$data"`,
    `  done`,
    `fi`,
    `echo ${SCAN_END}`,
    "",
  ].join("\n");
}

// ---- parse ----------------------------------------------------------------------------------------------------------

export interface ScanContainer {
  name: string;
  image: string;
  state: string;
  managed: boolean;
}
export interface ScanNetwork {
  name: string;
  /** Attached containers, null when docker could not say. */
  attached: number | null;
}
export interface ScanImage {
  ref: string;
  id: string;
  sizeBytes: number | null;
}
export interface ScanMount {
  container: string;
  sources: string[];
}
export interface ScanDir {
  path: string;
  sizeBytes: number | null;
  link: boolean;
  /** Holds anything besides compose files (the owner's data), or could not be read. Absent in an older listing = unknown = data. */
  data: boolean;
}
export interface ScanResult {
  /** Docker volume NAMES, read for the checklist only. */
  volumes: string[];
  containers: ScanContainer[];
  networks: ScanNetwork[];
  images: ScanImage[];
  mounts: ScanMount[];
  dirs: ScanDir[];
}

export class ScanError extends Error {
  constructor(readonly code: "no_docker" | "unreadable") {
    super(code);
  }
}

const UNIT: Record<string, number> = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3, TIB: 1024 ** 4 };
/** Docker's human size ("1.2GB", "35.5MB") -> bytes, null when it does not parse. */
export function parseHumanSize(s: string): number | null {
  const m = /^\s*([0-9]+(?:\.[0-9]+)?)\s*([A-Za-z]+)\s*$/.exec(s);
  if (!m) return null;
  const mult = UNIT[m[2].toUpperCase()];
  return mult ? Math.round(Number(m[1]) * mult) : null;
}

const MAX_LINES = 20_000;

/** Fail-closed: no BEGIN/END means the output was cut, and a cut listing is "unreadable", never "empty". */
export function parseScan(output: string): ScanResult {
  if (output.includes(SCAN_NO_DOCKER)) throw new ScanError("no_docker");
  const lines = output.split("\n").map((l) => l.replace(/\r$/, ""));
  const begin = lines.indexOf(SCAN_BEGIN);
  const end = lines.lastIndexOf(SCAN_END);
  if (begin < 0 || end < begin) throw new ScanError("unreadable");
  const out: ScanResult = { volumes: [], containers: [], networks: [], images: [], mounts: [], dirs: [] };
  for (const line of lines.slice(begin + 1, end).slice(0, MAX_LINES)) {
    if (!line.startsWith("TUGRA_CU_")) continue; // banners, warnings
    const [tag, ...f] = line.split("|");
    if (tag === "TUGRA_CU_C" && f.length >= 4 && f[0]) out.containers.push({ name: f[0], image: f[1], state: f[2].toLowerCase(), managed: f[3] === "true" });
    else if (tag === "TUGRA_CU_V" && f.length >= 1 && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(f[0])) out.volumes.push(f[0]);
    else if (tag === "TUGRA_CU_N" && f.length >= 2 && f[0]) out.networks.push({ name: f[0], attached: /^\d+$/.test(f[1]) ? Number(f[1]) : null });
    else if (tag === "TUGRA_CU_I" && f.length >= 3 && f[0]) out.images.push({ ref: f[0], id: f[1] ?? "", sizeBytes: parseHumanSize(f[2] ?? "") });
    else if (tag === "TUGRA_CU_M" && f.length >= 2) out.mounts.push({ container: f[0].replace(/^\//, ""), sources: (f[1] ?? "").split(";").filter(Boolean) });
    else if (tag === "TUGRA_CU_B" && f.length >= 2 && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/.test(f[0]) && /^\/[\x21-\x7e]{0,500}$/.test(f[1]) && !f[1].includes(";")) out.mounts.push({ container: `volume:${f[0]}`, sources: [f[1]] });
    else if (tag === "TUGRA_CU_D" && f.length >= 2 && f[0].startsWith(`${COOLIFY_ROOT}/`)) {
      const link = f[1] === "link";
      out.dirs.push({ path: f[0], sizeBytes: link || !/^\d+$/.test(f[1]) ? null : Number(f[1]) * 1024, link, data: f[2] !== "plain" });
    }
  }
  return out;
}

// ---- classify -------------------------------------------------------------------------------------------------------

export interface Classified {
  /** A Coolify control-plane container is here: this server is the Coolify host. Nothing is removable. */
  controlPlane: boolean;
  remnants: CleanupRemnant[];
}

const sorted = (r: CleanupRemnant[]): CleanupRemnant[] =>
  [...r].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));

/**
 * Does this Coolify container belong to the resource with this uuid? Coolify names them `<uuid>` (databases), `<uuid>-<stamp>`
 * (applications) and `<name>-<uuid>` (service components, sometimes followed by a suffix). The uuid is 16 to 40 lowercase letters or
 * digits, so it can only match as a whole dash-separated token.
 */
export function containerBelongsTo(name: string, uuid: string): boolean {
  if (!UUID_RE.test(uuid)) return false;
  return name.split("-").includes(uuid);
}

/** Under or above: a bind mount whose source contains the directory, or sits inside it, keeps it in use. */
function mountTouches(source: string, dir: string): boolean {
  return source === dir || source.startsWith(`${dir}/`) || dir.startsWith(`${source}/`);
}

/**
 * `knownUuids` = every Coolify resource uuid the stored read named on this server. `completeUuids` = the ones matched COMPLETE in the
 * checklist. A managed container or an applications/services directory is only removable when its uuid is in `completeUuids`: what the
 * checklist did not verify (a uuid the read does not know, created after the read, or an item that is not complete) is kept.
 */
export function classifyScan(scan: ScanResult, opts: { knownUuids: readonly string[]; completeUuids?: readonly string[] }): Classified {
  const remnants: CleanupRemnant[] = [];
  const control = scan.containers.some((c) => CONTROL_PLANE_CONTAINERS.includes(c.name));
  if (control) {
    for (const c of scan.containers) if (CONTROL_PLANE_CONTAINERS.includes(c.name)) remnants.push({ kind: "container", name: c.name, sizeBytes: null, keep: true, reason: "control_plane" });
    return { controlPlane: true, remnants: sorted(remnants) };
  }

  const known = new Set(opts.knownUuids.filter((u) => UUID_RE.test(u)));
  const complete = new Set((opts.completeUuids ?? []).filter((u) => known.has(u)));

  // Containers.
  const removableContainers = new Set<string>();
  for (const c of scan.containers) {
    if (!NAME_RE.test(c.name)) continue;
    const running = c.state === "running" || c.state === "restarting" || c.state === "paused";
    const isProxy = c.name === PROXY_CONTAINER;
    const isSentinel = c.name === SENTINEL_CONTAINER || SENTINEL_IMAGE_RE.test(c.image);
    const isHelper = HELPER_IMAGE_RE.test(c.image);
    const isManaged = c.managed;
    if (!isProxy && !isSentinel && !isHelper && !isManaged) continue;
    // The sentinel is Coolify's metrics agent: useless after the takeover, safe to stop. The proxy, a helper mid-job and a managed app container
    // that is still running are doing something: shown, not removed.
    // A managed container that is Coolify's own machinery (proxy, sentinel, helper) needs no uuid. Any other managed container is an app,
    // database or service container: only when its uuid is one the checklist matched complete.
    const machinery = isProxy || isSentinel || isHelper;
    if (running && !isSentinel) {
      remnants.push({ kind: "container", name: c.name, sizeBytes: null, keep: true, reason: "running" });
    } else if (!machinery && ![...complete].some((u) => containerBelongsTo(c.name, u))) {
      remnants.push({ kind: "container", name: c.name, sizeBytes: null, keep: true, reason: "unknown" });
    } else {
      removableContainers.add(c.name);
      remnants.push({ kind: "container", name: c.name, sizeBytes: null });
    }
  }
  const keptContainers = scan.containers.filter((c) => !removableContainers.has(c.name));

  // Networks: Coolify's own plus the per-resource ones the hub names; only when nothing is attached.
  const uuids = new Set(opts.knownUuids.filter((u) => UUID_RE.test(u)));
  for (const n of scan.networks) {
    if (!NAME_RE.test(n.name) || !(COOLIFY_NETWORKS.includes(n.name) || uuids.has(n.name))) continue;
    if (n.attached === 0) remnants.push({ kind: "network", name: n.name, sizeBytes: null });
    else remnants.push({ kind: "network", name: n.name, sizeBytes: null, keep: true, reason: "in_use" });
  }

  // Images: Coolify's own only; an image a kept container uses is shown, not removed.
  const usedImages = new Set(keptContainers.map((c) => c.image));
  for (const i of scan.images) {
    if (!COOLIFY_IMAGE_RE.test(i.ref)) continue;
    if (usedImages.has(i.ref) || usedImages.has(i.id)) remnants.push({ kind: "image", name: i.ref, sizeBytes: i.sizeBytes, keep: true, reason: "in_use" });
    else remnants.push({ kind: "image", name: i.ref, sizeBytes: i.sizeBytes });
  }

  // Directories under /data/coolify.
  // Every container counts, including those about to be removed: a stopped container's bind data is exactly what must not vanish with it.
  const liveSources = scan.mounts.flatMap((m) => m.sources);
  for (const d of scan.dirs) {
    const rel = d.path.slice(COOLIFY_ROOT.length + 1);
    const parts = rel.split("/");
    const top = parts[0];
    let keep: CleanupKeepReason | null = null;
    if (d.link || parts.some((p) => !p || p === "." || p === "..")) keep = "unknown";
    else if (DATA_DIRECTORIES.includes(top)) keep = "user_data";
    else if (parts.length === 1 && OWN_DIRECTORIES.includes(top)) keep = null;
    else if (parts.length === 2 && (top === "applications" || top === "services") && /^[A-Za-z0-9_-]{1,64}$/.test(parts[1])) {
      // Only a directory of an item the checklist matched complete, and holding nothing but compose files.
      if (d.data) keep = "user_data";
      else if (!complete.has(parts[1])) keep = "unknown";
      else keep = null;
    } else keep = "unknown";
    if (keep === null && liveSources.some((s) => mountTouches(s, d.path))) keep = "in_use";
    remnants.push(keep ? { kind: "directory", name: d.path, sizeBytes: d.sizeBytes, keep: true, reason: keep } : { kind: "directory", name: d.path, sizeBytes: d.sizeBytes });
  }
  return { controlPlane: false, remnants: sorted(remnants) };
}

/** Fingerprint of the removable part of a list: the owner's confirmation quotes it. */
export function listHash(remnants: readonly CleanupRemnant[]): string {
  const lines = remnants.filter((r) => !r.keep).map((r) => `${r.kind}:${r.name}`).sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

export const removable = (remnants: readonly CleanupRemnant[]): CleanupRemnant[] => remnants.filter((r) => !r.keep);
