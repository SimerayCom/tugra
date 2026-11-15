/**
 * Pure builders + strict parsers for the shell the agent runs during an app move. Everything here is a plain
 * function of its inputs (golden-string tested): no I/O, no DI. Docker names and ids are validated BEFORE they are
 * interpolated (a hostile name throws) and every value is `shq()`-quoted on top, so nothing a user typed can reach
 * a shell unquoted. Only the markers documented per builder are parsed; exit codes are authoritative.
 */
import { BACKUP_HELPER_IMAGE } from "../volume-backups/volume-backup-script";

/** Staging root on BOTH hosts (same /etc/tugra tree the volume backups use). */
export const MOVE_STAGING_ROOT = "/etc/tugra/app-moves";
/** Docker's data root: the other disk-space subject of the sizing rule. */
export const DOCKER_ROOT = "/var/lib/docker";

/** A docker volume name we are willing to hand to a shell (also what docker itself accepts). */
export const DOCKER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
/** A cuid (AppMove.id). Validated before it is interpolated into a path. */
export const MOVE_ID_RE = /^[a-z0-9]{20,32}$/;

export function shq(v: string): string {
  return `'${v.replaceAll("'", "'\\''")}'`;
}

export function isValidDockerName(n: unknown): n is string {
  return typeof n === "string" && DOCKER_NAME_RE.test(n);
}

export function assertDockerName(n: string): string {
  if (!isValidDockerName(n)) throw new Error(`invalid docker volume name: ${JSON.stringify(n)}`);
  return n;
}

export function assertMoveId(id: string): string {
  if (typeof id !== "string" || !MOVE_ID_RE.test(id)) throw new Error(`invalid move id: ${JSON.stringify(id)}`);
  return id;
}

/** Volume index inside a move: 0..999. */
export function assertIdx(idx: number): number {
  if (!Number.isInteger(idx) || idx < 0 || idx > 999) throw new Error(`invalid volume index: ${idx}`);
  return idx;
}

/** Part number inside a volume: 0..99999 (`split -d -a 5`). */
export function assertPart(part: number): number {
  if (!Number.isInteger(part) || part < 0 || part > 99_999) throw new Error(`invalid part number: ${part}`);
  return part;
}

/** `p.00007` — the on-disk name of part 7 (matches `split -d -a 5 - "$D/p."`). */
export function partName(part: number): string {
  return `p.${String(assertPart(part)).padStart(5, "0")}`;
}

export function moveDir(moveId: string): string {
  return `${MOVE_STAGING_ROOT}/${assertMoveId(moveId)}`;
}

export function volDir(moveId: string, idx: number): string {
  return `${moveDir(moveId)}/${assertIdx(idx)}`;
}

/** Docker CLI helper image used for every in-volume operation (same pinned image as the backup scripts). */
const IMG = BACKUP_HELPER_IMAGE;

// ───────────────────────────── probe (read-only, run on BOTH hosts) ─────────────────────────────

export const MOVE_TOOLS = ["curl", "split", "sha256sum", "gzip", "helper"] as const;
export type MoveTool = (typeof MOVE_TOOLS)[number];

/** Result of one probe, or null when the output was missing/malformed (the caller fails closed). */
export interface MoveProbe {
  /** Free KB + the device id of the filesystem backing each probed path (null = could not be read). */
  df: Record<string, { availKb: number | null; dev: string | null }>;
  tools: Record<MoveTool, boolean>;
  vols: Record<string, { exists: boolean; kb: number | null; label: string | null }>;
  ports: Set<number>;
  hostPaths: Record<string, boolean>;
}

export interface MoveProbeInput {
  /** Docker volume names to inspect (validated). */
  dockerVolumes: string[];
  /** Absolute host paths to test for existence (target side only; may be empty). */
  hostPaths?: string[];
}

function assertAbsPath(p: string): string {
  if (typeof p !== "string" || !p.startsWith("/") || p.length > 4096 || /[\u0000-\u001f]/.test(p)) throw new Error(`invalid host path: ${JSON.stringify(p)}`);
  return p;
}

/**
 * READ-ONLY probe: no mkdir, no pull, nothing written. Same fixed template on both hosts. Markers:
 *   TUGRA_DF <path> <availKB|-> <devId|->      for /var/lib/docker and /etc/tugra/app-moves (nearest existing parent)
 *   TUGRA_TOOL <curl|split|sha256sum|gzip|helper> <0|1>
 *   TUGRA_VOL <dockerName> ABSENT | EXISTS <kb|-> <label|->
 *   TUGRA_PORT <n>                              every listening TCP port
 *   TUGRA_HOSTPATH <path> <0|1>
 *   TUGRA_PROBE_END                             always last (a truncated output is detected by its absence)
 */
export function buildMoveProbeScript(input: MoveProbeInput): string {
  const vols = input.dockerVolumes.map(assertDockerName);
  const hostPaths = (input.hostPaths ?? []).map(assertAbsPath);
  const lines = [
    "set +e",
    "export LC_ALL=C",
    "probe_df() {",
    '  p="$1"',
    '  while [ ! -e "$p" ] && [ "$p" != "/" ]; do p=$(dirname "$p"); done',
    `  a=$(df -Pk "$p" 2>/dev/null | awk 'NR==2{print $4}')`,
    '  d=$(stat -c %d "$p" 2>/dev/null)',
    '  echo "TUGRA_DF $1 \${a:--} \${d:--}"',
    "}",
    `probe_df ${DOCKER_ROOT}`,
    `probe_df ${MOVE_STAGING_ROOT}`,
    'for t in curl split sha256sum gzip; do if command -v "$t" >/dev/null 2>&1; then echo "TUGRA_TOOL $t 1"; else echo "TUGRA_TOOL $t 0"; fi; done',
    `if docker image inspect ${IMG} >/dev/null 2>&1; then echo "TUGRA_TOOL helper 1"; else echo "TUGRA_TOOL helper 0"; fi`,
  ];
  for (const v of vols) {
    const q = shq(v);
    lines.push(
      `if docker volume inspect ${q} >/dev/null 2>&1; then`,
      `  kb=$(docker run --rm --pull=never -v ${q}:/d:ro ${IMG} du -sk /d 2>/dev/null | awk '{print $1}')`,
      // The helper image may not be on this host yet (probing never pulls): fall back to du on the volume's mountpoint.
      `  [ -n "$kb" ] || kb=$(du -sk "$(docker volume inspect -f '{{.Mountpoint}}' ${q} 2>/dev/null)" 2>/dev/null | awk '{print $1}')`,
      `  lb=$(docker volume inspect -f '{{index .Labels "tugra.move"}}' ${q} 2>/dev/null)`,
      `  echo "TUGRA_VOL ${v} EXISTS \${kb:--} \${lb:--}"`,
      `else`,
      `  echo "TUGRA_VOL ${v} ABSENT"`,
      `fi`,
    );
  }
  lines.push(
    `if command -v ss >/dev/null 2>&1; then ss -ltnH 2>/dev/null; else netstat -ltn 2>/dev/null | tail -n +3; fi | awk '{n=split($4,a,":"); p=a[n]; if (p ~ /^[0-9]+$/) print p}' | sort -un | head -n 4000 | while read -r p; do echo "TUGRA_PORT $p"; done`,
  );
  for (const h of hostPaths) lines.push(`if [ -e ${shq(h)} ]; then echo "TUGRA_HOSTPATH ${h.replace(/[\s"\\$`]/g, "_")} 1"; else echo "TUGRA_HOSTPATH ${h.replace(/[\s"\\$`]/g, "_")} 0"; fi`);
  lines.push("echo TUGRA_PROBE_END");
  return lines.join("\n");
}

/** Marker-safe form of a host path (what buildMoveProbeScript prints), so callers can look the result up. */
export function probeHostPathKey(h: string): string {
  return h.replace(/[\s"\\$`]/g, "_");
}

const DF_RE = /^TUGRA_DF (\/\S+) (\d+|-) (\d+|-)$/;
const TOOL_RE = /^TUGRA_TOOL (curl|split|sha256sum|gzip|helper) ([01])$/;
const VOL_ABSENT_RE = /^TUGRA_VOL (\S+) ABSENT$/;
const VOL_EXISTS_RE = /^TUGRA_VOL (\S+) EXISTS (\d+|-) (\S+)$/;
const PORT_RE = /^TUGRA_PORT (\d{1,5})$/;
const HOSTPATH_RE = /^TUGRA_HOSTPATH (\S+) ([01])$/;

/**
 * Strictly parse a probe's output. Returns null (the caller reports `probe_failed`) when ANY required marker is
 * missing or duplicated, when a `TUGRA_*` line is malformed, or when the end marker is absent (truncation).
 * Never "assume OK".
 */
export function parseMoveProbe(output: string, expected: MoveProbeInput): MoveProbe | null {
  const probe: MoveProbe = { df: {}, tools: {} as Record<MoveTool, boolean>, vols: {}, ports: new Set(), hostPaths: {} };
  let ended = false;
  const wantVols = new Set(expected.dockerVolumes);
  const wantHost = new Set((expected.hostPaths ?? []).map(probeHostPathKey));
  for (const raw of (output ?? "").split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.startsWith("TUGRA_")) continue;
    if (ended) return null; // nothing may follow the end marker
    if (line === "TUGRA_PROBE_END") {
      ended = true;
      continue;
    }
    let m: RegExpExecArray | null;
    if ((m = DF_RE.exec(line))) {
      if (m[1] in probe.df) return null;
      probe.df[m[1]] = { availKb: m[2] === "-" ? null : Number(m[2]), dev: m[3] === "-" ? null : m[3] };
    } else if ((m = TOOL_RE.exec(line))) {
      const t = m[1] as MoveTool;
      if (t in probe.tools) return null;
      probe.tools[t] = m[2] === "1";
    } else if ((m = VOL_ABSENT_RE.exec(line))) {
      if (!wantVols.has(m[1]) || m[1] in probe.vols) return null;
      probe.vols[m[1]] = { exists: false, kb: null, label: null };
    } else if ((m = VOL_EXISTS_RE.exec(line))) {
      if (!wantVols.has(m[1]) || m[1] in probe.vols) return null;
      probe.vols[m[1]] = { exists: true, kb: m[2] === "-" ? null : Number(m[2]), label: m[3] === "-" ? null : m[3] };
    } else if ((m = PORT_RE.exec(line))) {
      const n = Number(m[1]);
      if (n < 1 || n > 65535) return null;
      probe.ports.add(n);
    } else if ((m = HOSTPATH_RE.exec(line))) {
      if (!wantHost.has(m[1]) || m[1] in probe.hostPaths) return null;
      probe.hostPaths[m[1]] = m[2] === "1";
    } else {
      return null; // a TUGRA_ line we do not recognise: malformed
    }
  }
  if (!ended) return null;
  for (const p of [DOCKER_ROOT, MOVE_STAGING_ROOT]) if (!(p in probe.df)) return null;
  for (const t of MOVE_TOOLS) if (!(t in probe.tools)) return null;
  for (const v of wantVols) if (!(v in probe.vols)) return null;
  for (const h of wantHost) if (!(h in probe.hostPaths)) return null;
  return probe;
}
