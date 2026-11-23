/**
 * Pure builders + strict parsers for the shell the agent runs during an app move. Everything here is a plain
 * function of its inputs (golden-string tested): no I/O, no DI. Docker names and ids are validated BEFORE they are
 * interpolated (a hostile name throws) and every value is `shq()`-quoted on top, so nothing a user typed can reach
 * a shell unquoted. Only the markers documented per builder are parsed; exit codes are authoritative.
 */
import { randomBytes } from "node:crypto";
import { BACKUP_HELPER_IMAGE, safeWipeExtract } from "../volume-backups/volume-backup-script";
import { scrubRunOutput } from "../backups/backup-script";

/** Staging root on BOTH hosts (same /etc/tugra tree the volume backups use). */
export const MOVE_STAGING_ROOT = "/etc/tugra/app-moves";
/** Docker's data root: the other disk-space subject of the sizing rule. This is the marker KEY the hub looks up; the
 *  probe measures the daemon's real `DockerRootDir` on the host under this fixed key. */
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
  /** Free KB + the device id of the filesystem backing each probed path, as seen from the HOST (null = could not be
   *  read; an unknown device id is sized conservatively by the preflight). */
  df: Record<string, { availKb: number | null; dev: string | null }>;
  tools: Record<MoveTool, boolean>;
  vols: Record<string, { exists: boolean; kb: number | null; label: string | null }>;
  /** Every TCP port listening in the HOST network namespace (a probe that could not list them parses to null). */
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

/** awk program: `netstat -tln` rows (BusyBox in the helper image, or net-tools) → one listening port per line. The port
 *  is the last `:`-field of Local Address, so both `0.0.0.0:22` and BusyBox's IPv6 form `:::80` work; headers are
 *  skipped by the `tcp` prefix. */
export const NETSTAT_PORTS_AWK = `$1 ~ /^tcp/ {n=split($4,a,":"); if (a[n] ~ /^[0-9]+$/) print a[n]}`;
/** awk program: `/proc/net/tcp` + `/proc/net/tcp6` rows in state 0A (LISTEN) → the local port, hex → decimal by hand
 *  (no gawk `strtonum`: it has to run on BusyBox awk and mawk alike). Header rows fail the state test. */
export const PROC_TCP_PORTS_AWK = `$4=="0A" {split($2,a,":"); h=a[2]; n=0; for(i=1;i<=length(h);i++) n=n*16+index("0123456789ABCDEF",toupper(substr(h,i,1)))-1; print n}`;
/** Printed by the in-container port listing only when a source worked; its absence = fail closed (`TUGRA_PORT -`). */
export const PORTS_END_MARKER = "TUGRA_PORTS_END";

/** POSIX sh run INSIDE a `--network host` container: the host's listening ports from netstat (BusyBox helper) or, in an
 *  image without netstat (the agent image), from the host's /proc/net/tcp{,6}. Ends with the marker only on success. */
const PORTS_INNER_SH = [
  `if command -v netstat >/dev/null 2>&1 && L=$(netstat -tln 2>/dev/null) && [ -n "$L" ]; then printf '%s\\n' "$L" | awk '${NETSTAT_PORTS_AWK}'; echo ${PORTS_END_MARKER};`,
  `elif [ -r /proc/net/tcp ]; then cat /proc/net/tcp /proc/net/tcp6 2>/dev/null | awk '${PROC_TCP_PORTS_AWK}'; echo ${PORTS_END_MARKER}; fi`,
].join(" ");

/** POSIX sh run inside a container with the HOST path bound at /x: `<availKB> <devId>` of that host filesystem. */
const HOST_DF_INNER_SH = `a=$(df -Pk /x 2>/dev/null | awk 'NR==2{print $4}'); d=$(stat -c %d /x 2>/dev/null); echo "\${a:--} \${d:--}"`;

/**
 * READ-ONLY probe: no mkdir, no pull, nothing written. Same fixed template on both hosts. The agent runs in a container
 * of its own (overlay root, own network namespace, only /etc/tugra and the docker socket bound), so everything about the
 * HOST is measured through a throwaway container the daemon starts: a bind of the host path for df/stat (the daemon
 * resolves `src=` on the host, and a bind keeps the host filesystem's device id), `--network host` for the listening
 * ports. That container runs the pinned helper image when the host has it, else the agent's own image
 * (`TUGRA_AGENT_IMAGE`, present on every host that runs an agent); never a pull. Markers:
 *   TUGRA_DF <key> <availKB|-> <devId|->       keys /var/lib/docker (= the daemon's DockerRootDir) and /etc/tugra/app-moves
 *                                              (= host /etc/tugra); without any image: the agent's own view, device id `-`
 *                                              when the path is not in the agent's tree (sized conservatively)
 *   TUGRA_TOOL <curl|split|sha256sum|gzip|helper> <0|1>
 *   TUGRA_VOL <dockerName> ABSENT | EXISTS <kb|-> <label|->
 *   TUGRA_PORT <n>                              every TCP port listening on the HOST (netstat, else /proc/net/tcp{,6})
 *   TUGRA_PORT -                                the ports could NOT be listed: the parser fails closed (probe_failed)
 *   TUGRA_HOSTPATH <path> <0|1>
 *   TUGRA_PROBE_END                             always last (a truncated output is detected by its absence)
 */
export function buildMoveProbeScript(input: MoveProbeInput): string {
  const vols = input.dockerVolumes.map(assertDockerName);
  const hostPaths = (input.hostPaths ?? []).map(assertAbsPath);
  const lines = [
    "set +e",
    "export LC_ALL=C",
    // The image the host-view containers run: the pinned helper, else the agent's own image (never pulled here).
    `HI=; HELPER=0`,
    `if docker image inspect ${IMG} >/dev/null 2>&1; then HI=${IMG}; HELPER=1; elif [ -n "$TUGRA_AGENT_IMAGE" ] && docker image inspect "$TUGRA_AGENT_IMAGE" >/dev/null 2>&1; then HI="$TUGRA_AGENT_IMAGE"; fi`,
    // In-agent fallback (no image at all): nearest existing parent. Walking out to "/" means the path is not in the
    // agent's own tree: the overlay root's free space IS the docker root's (its upper dir lives there), but its
    // anonymous device id says nothing about the host, so it is reported unknown.
    "probe_df() {",
    '  p="$1"',
    '  while [ ! -e "$p" ] && [ "$p" != "/" ]; do p=$(dirname "$p"); done',
    `  a=$(df -Pk "$p" 2>/dev/null | awk 'NR==2{print $4}')`,
    '  d=$(stat -c %d "$p" 2>/dev/null)',
    '  [ "$p" = "/" ] && d=',
    '  echo "TUGRA_DF $1 \${a:--} \${d:--}"',
    "}",
    // Host view: $1 = marker key, $2 = the HOST path (a --mount bind never creates a missing host dir, unlike -v).
    "host_df() {",
    "  o=",
    `  [ -n "$HI" ] && o=$(docker run --rm --pull=never --mount "type=bind,src=$2,dst=/x,readonly" "$HI" sh -c ${shq(HOST_DF_INNER_SH)} 2>/dev/null)`,
    `  if printf '%s\\n' "$o" | grep -Eq '^[0-9]+ [0-9]+$'; then echo "TUGRA_DF $1 $o"; else probe_df "$1"; fi`,
    "}",
    `DR=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null); [ -n "$DR" ] || DR=${DOCKER_ROOT}`,
    `host_df ${DOCKER_ROOT} "$DR"`,
    `host_df ${MOVE_STAGING_ROOT} /etc/tugra`,
    'for t in curl split sha256sum gzip; do if command -v "$t" >/dev/null 2>&1; then echo "TUGRA_TOOL $t 1"; else echo "TUGRA_TOOL $t 0"; fi; done',
    'echo "TUGRA_TOOL helper $HELPER"',
  ];
  for (const v of vols) {
    const q = shq(v);
    lines.push(
      `if docker volume inspect ${q} >/dev/null 2>&1; then`,
      // Sized through the host-view image (helper, else the agent's own image; probing never pulls); last resort: du on
      // the volume's mountpoint, which only an agent that can see the docker root (not a stock container) can read.
      `  kb=; [ -n "$HI" ] && kb=$(docker run --rm --pull=never -v ${q}:/d:ro "$HI" du -sk /d 2>/dev/null | awk '{print $1}')`,
      `  [ -n "$kb" ] || kb=$(du -sk "$(docker volume inspect -f '{{.Mountpoint}}' ${q} 2>/dev/null)" 2>/dev/null | awk '{print $1}')`,
      `  lb=$(docker volume inspect -f '{{index .Labels "tugra.move"}}' ${q} 2>/dev/null)`,
      `  echo "TUGRA_VOL ${v} EXISTS \${kb:--} \${lb:--}"`,
      `else`,
      `  echo "TUGRA_VOL ${v} ABSENT"`,
      `fi`,
    );
  }
  // Ports of the HOST namespace, through the host-view container; the agent's own namespace is not the host's and the
  // agent image ships neither ss nor netstat. No image, or neither source worked → `TUGRA_PORT -` (fail closed).
  lines.push(
    `PL=; [ -n "$HI" ] && PL=$(docker run --rm --pull=never --network host "$HI" sh -c ${shq(PORTS_INNER_SH)} 2>/dev/null)`,
    `case "$PL" in *${PORTS_END_MARKER}) printf '%s\\n' "$PL" | grep -E '^[0-9]+$' | sort -un | head -n 4000 | while read -r p; do echo "TUGRA_PORT $p"; done ;; *) echo "TUGRA_PORT -" ;; esac`,
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
    } else if (line === "TUGRA_PORT -") {
      return null; // the host's listening ports could not be listed: never assume "no ports" (fail closed)
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

// ───────────────────────────── transfer scripts ─────────────────────────────

const GiB = 1024 ** 3;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Exit codes the move scripts use (besides the restore contract 0/72/71/70 from safeWipeExtract). */
export const MOVE_EXIT = {
  noOrigin: 64, // TUGRA_HUB_ORIGIN missing (agent too old / not a backup-capability command)
  sizeMismatch: 65, // received part length differs from the signed size
  shaMismatch: 66, // received part sha256 differs from the signed one
  emptyPack: 67, // the pack produced no part
  entryMismatch: 68, // extracted entry count differs from the packed one
} as const;

/** Exactly what mintRelayPath produces: the ONLY path shape that may reach a curl in these scripts. */
const RELAY_PATH_RE = /^\/api\/v1\/agent-vx\/t\/[A-Za-z0-9_-]{16,64}\?exp=[0-9]{1,12}&sig=[A-Za-z0-9_-]{16,128}$/;

function assertRelayPath(p: string): string {
  if (typeof p !== "string" || !RELAY_PATH_RE.test(p)) throw new Error("invalid relay path");
  return p;
}

function assertSha256(h: string): string {
  if (typeof h !== "string" || !/^[0-9a-f]{64}$/.test(h)) throw new Error("invalid sha256");
  return h;
}

function assertSize(n: number): number {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`invalid size: ${n}`);
  return n;
}

function assertBytes(n: number, min: number, max: number, what: string): number {
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`invalid ${what}: ${n}`);
  return n;
}

/** A compose volume key / project (the labels compose itself writes). Same charset as a docker name. */
function assertLabelValue(v: string, what: string): string {
  if (!isValidDockerName(v)) throw new Error(`invalid ${what}: ${JSON.stringify(v)}`);
  return v;
}

export interface PrepareVolume {
  dockerName: string;
  /** Present for a compose-owned volume: the labels compose expects, so `compose up` does not warn the volume "was not
   *  created for project". */
  compose?: { project: string; key: string };
}

/**
 * (target) Create the staging dir and every destination volume that does not exist yet, labelled `tugra.move=<moveId>`
 * so cleanup can prove a volume is ours before removing it. Prints `TUGRA_VX_CREATED <dockerName> 1|0` (0 = it already
 * existed: an archive of an earlier move that the apply will overwrite, never removed on rollback).
 */
export function buildMovePrepareScript(moveId: string, vols: PrepareVolume[]): string {
  const dir = moveDir(moveId);
  const lines = [
    "set -e",
    "umask 077",
    `mkdir -p -m 700 ${dir}`,
    `docker image inspect ${IMG} >/dev/null 2>&1 || docker pull ${IMG}`,
  ];
  for (const v of vols) {
    const name = assertDockerName(v.dockerName);
    const q = shq(name);
    const labels = [`--label tugra.move=${moveId}`];
    if (v.compose) {
      labels.push(`--label com.docker.compose.project=${assertLabelValue(v.compose.project, "compose project")}`);
      labels.push(`--label com.docker.compose.volume=${assertLabelValue(v.compose.key, "compose volume key")}`);
    }
    lines.push(
      `if docker volume inspect ${q} >/dev/null 2>&1; then echo "TUGRA_VX_CREATED ${name} 0"; else docker volume create ${labels.join(" ")} ${q} >/dev/null; echo "TUGRA_VX_CREATED ${name} 1"; fi`,
    );
  }
  return lines.join("\n");
}

const CREATED_RE = /^TUGRA_VX_CREATED (\S+) ([01])$/;

/** Strict parse of the prepare output: every requested volume reported exactly once, nothing unknown. null = unusable. */
export function parseMovePrepare(output: string, expected: string[]): Record<string, boolean> | null {
  const out: Record<string, boolean> = {};
  for (const raw of (output ?? "").split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.startsWith("TUGRA_VX_CREATED")) continue;
    const m = CREATED_RE.exec(line);
    if (!m || !expected.includes(m[1]) || m[1] in out) return null;
    out[m[1]] = m[2] === "1";
  }
  for (const n of expected) if (!(n in out)) return null;
  return out;
}

export interface PackInput {
  moveId: string;
  idx: number;
  dockerVolume: string;
  partBytes: number;
}

/**
 * (source) Tar the (stopped) volume, gzip -1, split into fixed-size parts under the staging dir, write the checksum
 * file and count the entries. A tar failure trips pipefail (non-zero exit). Prints
 * `TUGRA_VX_PACKED parts=<n> entries=<e>`.
 */
export function buildMovePackScript(i: PackInput): string {
  const vol = shq(assertDockerName(i.dockerVolume));
  const dir = volDir(i.moveId, i.idx);
  assertBytes(i.partBytes, 1024, 2 * GiB, "part size");
  return [
    "set -e",
    "set -o pipefail",
    `D=${dir}`,
    'umask 077; rm -rf "$D"; mkdir -p "$D"',
    `docker run --rm -v ${vol}:/data:ro ${IMG} tar -C /data -cf - . | gzip -1 | split -b ${i.partBytes} -d -a 5 - "$D/p."`,
    `N=$(ls "$D" | grep -c '^p\\.' || true)`,
    '[ "$N" -ge 1 ] || { echo "empty pack" >&2; exit 67; }',
    '( cd "$D" && sha256sum p.* > sums )',
    `E=$(docker run --rm -v ${vol}:/data:ro ${IMG} sh -c 'find /data -mindepth 1 | wc -l | tr -d " "')`,
    'echo "TUGRA_VX_PACKED parts=$N entries=$E"',
  ].join("\n");
}

const PACKED_RE = /^TUGRA_VX_PACKED parts=(\d+) entries=(\d+)$/;

/** `TUGRA_VX_PACKED parts=N entries=E` exactly once; anything else (extra/missing fields, 0 parts) is null. */
export function parseMovePacked(output: string): { parts: number; entries: number } | null {
  const hits = (output ?? "").split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.startsWith("TUGRA_VX_PACKED"));
  if (hits.length !== 1) return null;
  const m = PACKED_RE.exec(hits[0]);
  if (!m) return null;
  const parts = Number(m[1]);
  const entries = Number(m[2]);
  if (!Number.isSafeInteger(parts) || parts < 1 || parts > 100_000 || !Number.isSafeInteger(entries)) return null;
  return { parts, entries };
}

/** (source) Print `TUGRA_VX_PART <bytes> <sha256>` for one part (from stat + the pack's checksum file). */
export function buildMovePartStatScript(moveId: string, idx: number, part: number): string {
  const dir = volDir(moveId, idx);
  const name = partName(part);
  return [
    "set -e",
    `D=${dir}`,
    `F="$D/${name}"`,
    '[ -f "$F" ] || { echo "part missing" >&2; exit 66; }',
    'S=$(stat -c %s "$F")',
    `H=$(awk '$2=="${name}"{print $1}' "$D/sums")`,
    '[ -n "$H" ] || { echo "no checksum" >&2; exit 66; }',
    'echo "TUGRA_VX_PART $S $H"',
  ].join("\n");
}

const PART_RE = /^TUGRA_VX_PART (\d+) ([0-9a-f]{64})$/;

export function parseMovePart(output: string): { size: number; sha256: string } | null {
  const hits = (output ?? "").split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.startsWith("TUGRA_VX_PART"));
  if (hits.length !== 1) return null;
  const m = PART_RE.exec(hits[0]);
  if (!m) return null;
  const size = Number(m[1]);
  return Number.isSafeInteger(size) && size > 0 ? { size, sha256: m[2] } : null;
}

export interface PartTransferInput {
  moveId: string;
  idx: number;
  part: number;
  /** The relative signed relay path (mintRelayPath). */
  path: string;
  /** curl --max-time, seconds. */
  maxTimeSec?: number;
}

const DEFAULT_CURL_MAX_SEC = 14 * 60;

/**
 * Keeps the signed relay path (the credential of a transfer) out of curl's argv: it is written to a private (0600,
 * mktemp) curl config file and read with `-K`, the way the deploy scripts hand a git token to GIT_ASKPASS through a
 * file. The path travels base64-encoded into a `printf | base64 -d` pipeline of shell builtins plus `base64` (no
 * relay path on any child's command line), and the file is removed by the EXIT trap. Known limit, documented in
 * docs/security.md: the agent runs the whole script as `bash -c <script>`, so the script text itself is still on that
 * shell's argv; closing that needs the credential delivered out of band by the agent.
 */
function relayCredentialLines(path: string): { setup: string[]; arg: string } {
  const b64 = Buffer.from(assertRelayPath(path), "utf8").toString("base64");
  return {
    setup: [
      "K=$(mktemp)",
      `printf 'url = "%s%s"\\n' "$O" "$(printf %s ${shq(b64)} | base64 -d)" > "$K"`,
      // A hub on a bare IP serves a self-signed certificate; the agent exports the path of the one it pinned
      // (TUGRA_HUB_CACERT, backup commands only) and curl then trusts exactly that certificate and nothing else.
      `[ -z "\${TUGRA_HUB_CACERT:-}" ] || printf 'cacert = "%s"\\n' "$TUGRA_HUB_CACERT" >> "$K"`,
    ],
    arg: '-K "$K"',
  };
}

/** (source) PUT one part to the signed relay path. The hub's origin comes from the agent's own env (TUGRA_HUB_ORIGIN). */
export function buildMoveSendScript(i: PartTransferInput): string {
  const f = `${volDir(i.moveId, i.idx)}/${partName(i.part)}`;
  const secs = assertBytes(i.maxTimeSec ?? DEFAULT_CURL_MAX_SEC, 30, 3600, "curl max-time");
  const cred = relayCredentialLines(i.path);
  return [
    "set -e",
    'O="$TUGRA_HUB_ORIGIN"; [ -n "$O" ] || { echo "no hub origin" >&2; exit 64; }',
    `F=${f}; [ -f "$F" ]`,
    ...cred.setup,
    `trap 'rm -f "$K"' EXIT`,
    `curl -fsS --max-time ${secs} -X PUT -H 'Expect:' -H 'Content-Type: application/octet-stream' -T "$F" ${cred.arg} >/dev/null`,
    "echo TUGRA_VX_SEND_OK",
  ].join("\n");
}

export interface RecvInput extends PartTransferInput {
  size: number;
  sha256: string;
}

/** (target) GET one part from the signed relay path, verify its exact length and sha256, then move it into place. */
export function buildMoveRecvScript(i: RecvInput): string {
  const dir = volDir(i.moveId, i.idx);
  const name = partName(i.part);
  const secs = assertBytes(i.maxTimeSec ?? DEFAULT_CURL_MAX_SEC, 30, 3600, "curl max-time");
  const cred = relayCredentialLines(i.path);
  return [
    "set -e",
    "set -o pipefail",
    'O="$TUGRA_HUB_ORIGIN"; [ -n "$O" ] || { echo "no hub origin" >&2; exit 64; }',
    `D=${dir}; umask 077; mkdir -p "$D"; F="$D/${name}"; rm -f "$F.tmp"`,
    ...cred.setup,
    `trap 'rm -f "$F.tmp" "$K"' EXIT`,
    `curl -fsS --no-buffer --max-time ${secs} ${cred.arg} -o "$F.tmp"`,
    `[ "$(stat -c %s "$F.tmp")" = "${assertSize(i.size)}" ] || { echo "size mismatch" >&2; exit 65; }`,
    `[ "$(sha256sum "$F.tmp" | cut -d' ' -f1)" = "${assertSha256(i.sha256)}" ] || { echo "sha mismatch" >&2; exit 66; }`,
    'mv "$F.tmp" "$F"; echo TUGRA_VX_RECV_OK',
  ].join("\n");
}

/** True when the output carries the marker as a whole line (the exit code is still what decides success). */
export function hasMarker(output: string, marker: string): boolean {
  return (output ?? "").split("\n").some((l) => l.replace(/\r$/, "") === marker);
}

/** (source) Free one part's disk once BOTH the send and the receive of it succeeded. */
export function buildMoveSourcePartDropScript(moveId: string, idx: number, part: number): string {
  return `rm -f ${volDir(moveId, idx)}/${partName(part)}`;
}

export interface ApplyInput {
  moveId: string;
  idx: number;
  dockerVolume: string;
  restoreId: string;
  expectedEntries: number;
}

/**
 * (target) Verify-then-wipe-then-extract the received parts into the volume, rollback-protected exactly like a volume
 * restore (exit 0 ok · 72 aborted before the wipe · 71 rolled back · 70 rollback failed, snapshot kept), streaming the
 * gunzipped parts into docker TWICE (validate, extract) so no decoded tar ever sits on disk. Ownership is PRESERVED
 * (no --no-same-owner): this is a trusted Tugra->Tugra transfer and a postgres volume must keep uid 999. After the
 * extract the entry count must equal the packed one (68). Prints `TUGRA_VX_APPLY_OK entries=<e>`.
 */
export function buildMoveApplyScript(i: ApplyInput): string {
  const vol = shq(assertDockerName(i.dockerVolume));
  const dir = volDir(i.moveId, i.idx);
  if (typeof i.restoreId !== "string" || !/^[A-Za-z0-9_]{1,80}$/.test(i.restoreId)) throw new Error("invalid restore id");
  assertSize(i.expectedEntries);
  return [
    "set -e",
    "set -o pipefail",
    "TMP=$(mktemp)",
    `trap 'rm -f "$TMP" "$TMP.list"' EXIT`,
    // glob order is lexical = part order (5-digit suffixes)
    `vx_stream() { cat ${dir}/p.* | gunzip; }`,
    ...safeWipeExtract(i.dockerVolume, i.restoreId, "", { kind: "stream", fn: "vx_stream" }),
    `E=$(docker run --rm -v ${vol}:/data:ro ${IMG} sh -c 'find /data -mindepth 1 | wc -l | tr -d " "')`,
    `[ "$E" = "${i.expectedEntries}" ] || { echo "entry count mismatch" >&2; exit 68; }`,
    'echo "TUGRA_VX_APPLY_OK entries=$E"',
    `rm -rf ${dir}`,
  ].join("\n");
}

const APPLY_OK_RE = /^TUGRA_VX_APPLY_OK entries=(\d+)$/;

export function parseMoveApplyOk(output: string): number | null {
  const hits = (output ?? "").split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.startsWith("TUGRA_VX_APPLY_OK"));
  if (hits.length !== 1) return null;
  const m = APPLY_OK_RE.exec(hits[0]);
  return m ? Number(m[1]) : null;
}

export interface CleanupInput {
  /** Volumes THIS move created on the host (label re-checked in-script; an unlabelled/foreign volume is never removed). */
  removeVolumes?: string[];
  /** Rollback snapshot volumes (`tugra_restore_rb_<restoreId>`) of the applies. */
  removeRollbackFor?: string[];
}

/**
 * Remove the staging dir and, when listed, the volumes this move created and the apply rollback snapshots — each one
 * only after its label proves it is ours. Best-effort (docker refuses an in-use volume; the sweeper retries). Prints
 * `TUGRA_VX_VOL <name> removed|kept|skipped|absent` per volume and `TUGRA_VX_CLEANUP_DONE` last.
 */
export function buildMoveCleanupScript(moveId: string, input: CleanupInput = {}): string {
  const dir = moveDir(moveId);
  const lines = ["set +e", `rm -rf ${dir}`];
  const one = (name: string, labelKey: string, labelValue: string): void => {
    const q = shq(name);
    lines.push(
      `if docker volume inspect ${q} >/dev/null 2>&1; then`,
      `  lb=$(docker volume inspect -f '{{index .Labels "${labelKey}"}}' ${q} 2>/dev/null)`,
      `  if [ "$lb" = ${shq(labelValue)} ]; then if docker volume rm ${q} >/dev/null 2>&1; then echo "TUGRA_VX_VOL ${name} removed"; else echo "TUGRA_VX_VOL ${name} kept"; fi; else echo "TUGRA_VX_VOL ${name} skipped"; fi`,
      `else echo "TUGRA_VX_VOL ${name} absent"; fi`,
    );
  };
  for (const v of input.removeVolumes ?? []) one(assertDockerName(v), "tugra.move", assertMoveId(moveId));
  for (const r of input.removeRollbackFor ?? []) {
    if (!/^[A-Za-z0-9_]{1,80}$/.test(r)) throw new Error("invalid restore id");
    one(`tugra_restore_rb_${r}`, "tugra.restore-rb", r);
  }
  lines.push("echo TUGRA_VX_CLEANUP_DONE");
  return lines.join("\n");
}

const VOL_RESULT_RE = /^TUGRA_VX_VOL (\S+) (removed|kept|skipped|absent)$/;

/**
 * Parse a cleanup/purge output. `leftover` = the volumes docker refused to remove (in use) or whose result is missing;
 * the caller stamps its "purged" timestamp only when `complete` (the end marker is there) and nothing is left over.
 */
export function parseMoveVolResults(output: string, expected: string[]): { complete: boolean; leftover: string[] } {
  const seen: Record<string, string> = {};
  let done = false;
  for (const raw of (output ?? "").split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line === "TUGRA_VX_CLEANUP_DONE") done = true;
    const m = VOL_RESULT_RE.exec(line);
    if (m) seen[m[1]] = m[2];
  }
  const leftover = expected.filter((n) => !(n in seen) || seen[n] === "kept");
  return { complete: done, leftover };
}

/**
 * (source, sweeper / purge-source) Remove the archived original volumes. Docker refuses an in-use volume — the last
 * safety net — and the sweeper's own guards run before this is ever sent. Same output markers as cleanup.
 */
export function buildMoveArchivePurgeScript(dockerNames: string[]): string {
  const lines = ["set +e"];
  for (const n of dockerNames) {
    const name = assertDockerName(n);
    const q = shq(name);
    lines.push(`if docker volume inspect ${q} >/dev/null 2>&1; then if docker volume rm ${q} >/dev/null 2>&1; then echo "TUGRA_VX_VOL ${name} removed"; else echo "TUGRA_VX_VOL ${name} kept"; fi; else echo "TUGRA_VX_VOL ${name} absent"; fi`);
  }
  lines.push("echo TUGRA_VX_CLEANUP_DONE");
  return lines.join("\n");
}

/** The synthetic file of the optional link test: one real relay part of this many bytes. */
export const LINK_PROBE_BYTES = 16 * 1024 * 1024;

/** A throwaway move id for the link test (matches MOVE_ID_RE, so the normal send/recv builders accept it). */
export function newLinkProbeId(): string {
  return `probe${randomBytes(10).toString("hex")}`;
}

/** (source) Create a 16 MiB random file as part 0 of a probe "volume" and print `TUGRA_VX_PART <bytes> <sha256>`. */
export function buildMoveLinkProbeFileScript(probeId: string): string {
  const dir = volDir(probeId, 0);
  return [
    "set -e",
    "umask 077",
    `D=${dir}`,
    'rm -rf "$D"; mkdir -p "$D"',
    `head -c ${LINK_PROBE_BYTES} /dev/urandom > "$D/p.00000"`,
    'S=$(stat -c %s "$D/p.00000")',
    'H=$(sha256sum "$D/p.00000" | cut -d" " -f1)',
    'echo "TUGRA_VX_PART $S $H"',
  ].join("\n");
}

/** An app id (cuid) as it appears in container names. */
const APP_ID_RE = /^[a-z0-9]{20,32}$/;

/**
 * (source or target) Prove nothing of the app is running: no container whose name starts with `tugra_<appId>` (the classic
 * container, its rolling twin and every compose service container). Prints `TUGRA_VX_QUIESCED`, else `TUGRA_VX_RUNNING`
 * and exits 1. Read-only. Stop-before-read is the consistency guarantee of the copy, so this is checked, not assumed.
 */
export function buildMoveVerifyStoppedScript(appId: string): string {
  if (typeof appId !== "string" || !APP_ID_RE.test(appId)) throw new Error(`invalid app id: ${JSON.stringify(appId)}`);
  return [
    `R=$(docker ps -q --filter 'name=^/tugra_${appId}')`,
    'if [ -z "$R" ]; then echo TUGRA_VX_QUIESCED; else echo TUGRA_VX_RUNNING; exit 1; fi',
  ].join("\n");
}

// ───────────────────────────── timeouts + output scrubbing ─────────────────────────────

const clampMs = (ms: number): number => Math.min(Math.max(ms, 1), DAY_MS);

/** Agent kill timers (the agent does not clamp them): pack 10 min + 150 s/GiB, apply 10 min + 240 s/GiB, all <= 24 h. */
export const MOVE_TIMEOUTS = {
  probe: 600_000,
  prepare: 120_000,
  stat: 120_000,
  drop: 120_000,
  /** One part's send/recv (the curl --max-time is 14 min inside it). */
  transfer: 900_000,
  pack: (bytes: number): number => clampMs(600_000 + Math.ceil(Math.max(0, bytes) / GiB) * 150_000),
  apply: (bytes: number): number => clampMs(600_000 + Math.ceil(Math.max(0, bytes) / GiB) * 240_000),
} as const;

const RELAY_URL_RE = /(?:https?:\/\/[^\s'"]*)?\/api\/v1\/agent-vx\/t\/[^\s'"]*/g;

/**
 * Make agent output safe to persist / show: the signed relay path (with or without the hub origin in front) is the
 * credential of a transfer and is removed, then the shared run-output scrub (connection-URI userinfo, password-ish
 * assignments, restore noise) applies. TUGRA_HUB_ORIGIN is never echoed by our scripts; a literal assignment is
 * redacted as well, in case a hostile helper prints its environment.
 */
export function scrubMoveOutput(output: string, secrets: ReadonlyArray<string | null | undefined> = []): string {
  const noRelay = (output ?? "").replace(RELAY_URL_RE, "<relay-path-redacted>").replace(/TUGRA_HUB_ORIGIN=\S+/g, "TUGRA_HUB_ORIGIN=<redacted>");
  return scrubRunOutput(noRelay, secrets);
}
