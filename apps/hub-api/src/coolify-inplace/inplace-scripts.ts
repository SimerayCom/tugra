/**
 * Hub-built host scripts of the in-place takeover (Coolify hub takeover, lane F), and the fail-closed parsers of what they print.
 * Everything runs on the server the apps already live on, through the agent's `deploy` capability, like every proxy script.
 *
 * Rules (the same source-safety rules as the proxy swap):
 *  - nothing here runs `docker rm`, `kill`, `prune`, `rmi` or `volume rm`; Coolify's containers, images and volumes are only ever
 *    stopped, started or read, and given back exactly as they were found (a spec asserts the absence),
 *  - a container is touched by RECORDED id only, after its name and image still match what was recorded,
 *  - environment values never leave the host and are never printed: nothing here asks docker for `.Config.Env`,
 *  - certificate keys never leave the host: the fallback certificate is copied from Coolify's acme.json to the Tugra proxy's
 *    own directory on the same box, and only a serial number and a domain name are printed,
 *  - every value that reaches a shell is validated first and then single-quoted.
 */
import { shq } from "../deploy/deploy-script";
import { PROXY_DYNAMIC_DIR } from "../deploy/panel-router";
import { CUTOVER_HOSTNAME_RE, PROBE_PATH_RE } from "../cutover/cutover.logic";
import { OCI_VERSION_LABEL, REPO_DIGEST_RE, VERSION_LABEL_RE } from "../importer/exact-image";

export const IP_MARK = {
  restart: "TUGRA_IP_RESTART",
  image: "TUGRA_IP_IMAGE",
  mount: "TUGRA_IP_MOUNT",
  detailEnd: "TUGRA_IP_DETAIL_END",
  adopt: "TUGRA_IP_ADOPT",
  alias: "TUGRA_IP_ALIAS",
  probe: "TUGRA_IP_PROBE",
  probeEnd: "TUGRA_IP_PROBE_END",
  app: "TUGRA_IP_APP",
  appEnd: "TUGRA_IP_APP_END",
  policy: "TUGRA_IP_POLICY",
  fallback: "TUGRA_IP_FALLBACK",
  cert: "TUGRA_IP_CERT",
  dbfp: "TUGRA_IP_DBFP",
  /** A registry digest (`repo@sha256:...`) of the image a container runs, and the version the image labels itself with. */
  rdig: "TUGRA_IP_RDIG",
  imgver: "TUGRA_IP_IMGVER",
} as const;

/** Where Coolify keeps its proxy's ACME store on the host when nothing says otherwise. */
export const COOLIFY_ACME_DEFAULT = "/data/coolify/proxy/acme.json";
/** Where the fallback certificates live: under the proxy's dynamic dir, which the proxy mounts read-only. */
export const FALLBACK_CERT_DIR = `${PROXY_DYNAMIC_DIR}/certs`;

const HEX64 = /^[0-9a-f]{64}$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/;
const TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const ACME_PATH_RE = /^\/[A-Za-z0-9._\-/]{1,200}$/;
const POLICIES = ["no", "always", "unless-stopped", "on-failure"] as const;
export type InPlaceRestartPolicy = (typeof POLICIES)[number];
const MAX_HOSTS = 100;

export const isHex64 = (v: unknown): v is string => typeof v === "string" && HEX64.test(v);

/** A container the takeover has recorded: identity first, so a later stop or start can verify it is the same one. */
export interface RecordedCtr {
  id: string;
  name: string;
  image: string;
}

function assertRecorded(cs: readonly RecordedCtr[]): void {
  for (const c of cs) if (!isHex64(c.id) || !NAME_RE.test(c.name) || !IMAGE_RE.test(c.image)) throw new Error("inplace: invalid recorded container");
}
function assertHosts(hosts: readonly string[]): void {
  if (hosts.length === 0 || hosts.length > MAX_HOSTS) throw new Error("inplace: host count out of range");
  for (const h of hosts) if (!CUTOVER_HOSTNAME_RE.test(h)) throw new Error("inplace: invalid hostname");
}

/** The identity check every script defines: 0 when the container with this id still has this name and image, 1 when not, 2 when gone. */
const IDENT = [
  "ident() {",
  '  cur="$(docker inspect -f \'{{.Name}}|{{.Config.Image}}\' "$1" 2>/dev/null)" || return 2',
  '  [ "$cur" = "/$2|$3" ] || return 1',
  "  return 0",
  "}",
];

/**
 * The shell lines of `detail()` that read the EXACT image a container runs: the registry digests docker recorded for its image id (at most
 * eight) and the image's own version label (only a plain token). Read-only; a host with no digest (a locally built image) prints none, which
 * the hub reads as "unknown", never as a failure.
 */
export const EXACT_IMAGE_LINES: readonly string[] = [
  `  iid="$(docker inspect -f '{{.Image}}' "$1" 2>/dev/null)"`,
  `  docker image inspect -f '{{range .RepoDigests}}{{println .}}{{end}}' "$iid" 2>/dev/null | head -n 8 | while IFS= read -r d; do [ -n "$d" ] && printf '${IP_MARK.rdig}|%s|%s\\n' "$1" "$d"; done`,
  `  iv="$(docker image inspect -f '{{index .Config.Labels "${OCI_VERSION_LABEL}"}}' "$iid" 2>/dev/null)"`,
  `  case "$iv" in ''|*[!A-Za-z0-9._+~-]*|[!A-Za-z0-9]*) ;; *) printf '${IP_MARK.imgver}|%s|%s\\n' "$1" "$iv";; esac`,
];

// ───────────────────────────── what a Coolify container looks like (read-only) ─────────────────────────────

/**
 * Per recorded container: its restart policy, the id of the image it runs, the exact image it runs (registry digests and the image's own
 * version label) and its mounts. No environment, no other label, no command line.
 * A container that is gone or whose identity changed prints nothing and the parser reports it missing.
 */
export function buildContainerDetailScript(containers: readonly RecordedCtr[]): string {
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
    "}",
    ...containers.map((c) => `detail ${shq(c.id)} ${shq(c.name)} ${shq(c.image)}`),
    `echo ${IP_MARK.detailEnd}`,
    "",
  ].join("\n");
}

export interface CtrMount {
  type: "volume" | "bind" | "tmpfs" | "other";
  /** Volume name (type volume) or host path (type bind). */
  source: string;
  destination: string;
  rw: boolean;
}
export interface CtrDetail {
  id: string;
  restart: InPlaceRestartPolicy;
  /** `sha256:<64 hex>` of the image the container runs. */
  imageId: string;
  /** The registry digests (`repo@sha256:...`) docker recorded for that image; absent when the host reported none (a locally built image). */
  repoDigests?: string[];
  /** The image's own `org.opencontainers.image.version` label; absent when it has none. */
  imageVersion?: string;
  mounts: CtrMount[];
}

const VOL_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;
const PATH_RE = /^\/[\x21-\x7e]{0,500}$/;

/** Parse the detail output. `null` for a cut output; a container with no restart and image line is absent from the result. */
export function parseContainerDetail(out: string, ids: readonly string[]): Map<string, CtrDetail> | null {
  if (out.includes("…(truncated)")) return null;
  const lines = out.split(/\r?\n/);
  if (!lines.includes(IP_MARK.detailEnd)) return null;
  const want = new Set(ids);
  const restart = new Map<string, InPlaceRestartPolicy>();
  const image = new Map<string, string>();
  const mounts = new Map<string, CtrMount[]>();
  const digests = new Map<string, string[]>();
  const versions = new Map<string, string>();
  for (const l of lines) {
    const f = l.split("|");
    if (f[0] === IP_MARK.restart && f.length === 3 && want.has(f[1])) {
      const p = f[2] === "" ? "no" : f[2];
      if ((POLICIES as readonly string[]).includes(p)) restart.set(f[1], p as InPlaceRestartPolicy);
    } else if (f[0] === IP_MARK.image && f.length === 3 && want.has(f[1]) && /^sha256:[0-9a-f]{64}$/.test(f[2])) {
      image.set(f[1], f[2]);
    } else if (f[0] === IP_MARK.rdig && f.length === 3 && want.has(f[1]) && REPO_DIGEST_RE.test(f[2])) {
      const have = digests.get(f[1]) ?? [];
      if (have.length < 8 && !have.includes(f[2])) digests.set(f[1], [...have, f[2]]);
    } else if (f[0] === IP_MARK.imgver && f.length === 3 && want.has(f[1]) && VERSION_LABEL_RE.test(f[2])) {
      versions.set(f[1], f[2]);
    } else if (f[0] === IP_MARK.mount && f.length === 7 && want.has(f[1])) {
      const [, , type, name, source, dest, rw] = f;
      if (!PATH_RE.test(dest) || (rw !== "true" && rw !== "false")) continue;
      const t = type === "volume" || type === "bind" || type === "tmpfs" ? type : "other";
      const src = t === "volume" ? name : source;
      if (t === "volume" && !VOL_RE.test(src)) continue;
      if (t === "bind" && !PATH_RE.test(src)) continue;
      mounts.set(f[1], [...(mounts.get(f[1]) ?? []), { type: t, source: t === "tmpfs" ? "" : src, destination: dest, rw: rw === "true" }]);
    }
  }
  const out2 = new Map<string, CtrDetail>();
  for (const id of ids) {
    const r = restart.get(id);
    const i = image.get(id);
    if (r && i) out2.set(id, { id, restart: r, imageId: i, ...(digests.has(id) ? { repoDigests: digests.get(id) } : {}), ...(versions.has(id) ? { imageVersion: versions.get(id) } : {}), mounts: mounts.get(id) ?? [] });
  }
  return out2;
}

// ───────────────────────────── reuse the image Coolify built ─────────────────────────────

/** Tag the image Coolify built as the Tugra app's versioned tag. Adds a name, never removes one; the image itself is untouched. */
export function buildAdoptImageScript(o: { image: string; tag: string }): string {
  if (!IMAGE_RE.test(o.image)) throw new Error("inplace: invalid image");
  if (!/^[a-z0-9_][a-z0-9_.-]{0,127}:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(o.tag)) throw new Error("inplace: invalid tag");
  return [
    "set -u",
    `if ! docker image inspect ${shq(o.image)} >/dev/null 2>&1; then echo "${IP_MARK.adopt}|missing"; exit 0; fi`,
    `if docker tag ${shq(o.image)} ${shq(o.tag)} >/dev/null 2>&1; then echo "${IP_MARK.adopt}|ok"; else echo "${IP_MARK.adopt}|failed"; fi`,
    "",
  ].join("\n");
}

export type AdoptOutcome = "ok" | "missing" | "failed";
export function parseAdopt(out: string): AdoptOutcome | null {
  if (out.includes("…(truncated)")) return null;
  const l = out.split(/\r?\n/).find((x) => x.startsWith(`${IP_MARK.adopt}|`));
  const v = l?.split("|")[1];
  return v === "ok" || v === "missing" || v === "failed" ? v : null;
}

/**
 * Make the Tugra app's named volume point at the data Coolify's volume already holds, with no copy: a local-driver bind volume whose
 * device is the other volume's data directory. A Tugra volume that already exists is left alone (and reported `present`, or `foreign`
 * when it is not such an alias, which the takeover refuses). The Coolify volume must exist.
 */
export function buildVolumeAliasScript(pairs: ReadonlyArray<{ from: string; to: string }>): string {
  for (const p of pairs) if (!VOL_RE.test(p.from) || !VOL_RE.test(p.to)) throw new Error("inplace: invalid volume name");
  return [
    "set -u",
    "alias_one() {",
    `  src="$(docker volume inspect -f '{{.Mountpoint}}' "$1" 2>/dev/null)" || { printf '${IP_MARK.alias}|%s|nosource\\n' "$2"; return; }`,
    '  case "$src" in /*) ;; *) printf \'' + IP_MARK.alias + "|%s|nosource\\n' \"$2\"; return;; esac",
    '  if docker volume inspect "$2" >/dev/null 2>&1; then',
    `    dev="$(docker volume inspect -f '{{index .Options "device"}}' "$2" 2>/dev/null)"`,
    `    if [ "$dev" = "$src" ]; then printf '${IP_MARK.alias}|%s|present\\n' "$2"; else printf '${IP_MARK.alias}|%s|foreign\\n' "$2"; fi`,
    "    return",
    "  fi",
    `  if docker volume create --driver local --opt type=none --opt o=bind --opt "device=$src" "$2" >/dev/null 2>&1; then printf '${IP_MARK.alias}|%s|created\\n' "$2"; else printf '${IP_MARK.alias}|%s|failed\\n' "$2"; fi`,
    "}",
    ...pairs.map((p) => `alias_one ${shq(p.from)} ${shq(p.to)}`),
    "",
  ].join("\n");
}

export type AliasOutcome = "created" | "present" | "foreign" | "nosource" | "failed";
export function parseAlias(out: string, targets: readonly string[]): Map<string, AliasOutcome> | null {
  if (out.includes("…(truncated)")) return null;
  const want = new Set(targets);
  const res = new Map<string, AliasOutcome>();
  for (const l of out.split(/\r?\n/)) {
    const f = l.split("|");
    if (f[0] !== IP_MARK.alias || f.length !== 3 || !want.has(f[1])) continue;
    if (["created", "present", "foreign", "nosource", "failed"].includes(f[2])) res.set(f[1], f[2] as AliasOutcome);
  }
  return want.size === res.size ? res : null;
}

// ───────────────────────────── restart policy of Coolify's containers ─────────────────────────────

/**
 * `docker update --restart=<policy>` on exactly the recorded containers: `no` before the switch (a reboot must not bring Coolify's
 * container back next to Tugra's on the same data), the recorded policy on the way back. Identity is checked first.
 */
export function buildRestartPolicyScript(containers: ReadonlyArray<RecordedCtr & { policy: InPlaceRestartPolicy }>): string {
  assertRecorded(containers);
  for (const c of containers) if (!(POLICIES as readonly string[]).includes(c.policy)) throw new Error("inplace: invalid restart policy");
  return [
    "set -u",
    ...IDENT,
    "set_policy() {",
    '  ident "$1" "$2" "$3"; r=$?',
    `  [ "$r" = 2 ] && { printf '${IP_MARK.policy}|%s|gone\\n' "$1"; return; }`,
    `  [ "$r" = 1 ] && { printf '${IP_MARK.policy}|%s|mismatch\\n' "$1"; return; }`,
    `  if docker update --restart="$4" "$1" >/dev/null 2>&1; then printf '${IP_MARK.policy}|%s|ok\\n' "$1"; else printf '${IP_MARK.policy}|%s|failed\\n' "$1"; fi`,
    "}",
    ...containers.map((c) => `set_policy ${shq(c.id)} ${shq(c.name)} ${shq(c.image)} ${shq(c.policy)}`),
    "",
  ].join("\n");
}

export type PolicyOutcome = "ok" | "gone" | "mismatch" | "failed";
export function parsePolicy(out: string, ids: readonly string[]): Map<string, PolicyOutcome> {
  const want = new Set(ids);
  const res = new Map<string, PolicyOutcome>();
  for (const l of out.split(/\r?\n/)) {
    const f = l.split("|");
    if (f[0] !== IP_MARK.policy || f.length !== 3 || !want.has(f[1])) continue;
    if (["ok", "gone", "mismatch", "failed"].includes(f[2])) res.set(f[1], f[2] as PolicyOutcome);
  }
  return res;
}

/**
 * Run `script` on the box's own network. The agent runs in a container on Docker's default bridge, so inside it 127.0.0.1 is the agent
 * itself and the bridge of Tugra's proxy is isolated from it: a probe of the box's :443 or of the proxy's bridge address never connects.
 * The script is handed to a throwaway container of the agent's own image (already on the box, nothing is pulled) on the host network,
 * with the Docker socket so `docker inspect` still works. When the agent's image cannot be found the script runs as it is.
 */
export function onHostNetwork(script: string): string {
  const b64 = Buffer.from(script, "utf8").toString("base64");
  return [
    'IMG=""',
    'if command -v docker >/dev/null 2>&1; then IMG=$(docker inspect -f "{{.Image}}" "$(hostname)" 2>/dev/null || true); fi',
    '[ -n "$IMG" ] || IMG="${TUGRA_AGENT_IMAGE:-}"',
    'if [ -n "$IMG" ]; then',
    `  printf '%s' '${b64}' | base64 -d | docker run --rm -i --network host -v /var/run/docker.sock:/var/run/docker.sock --entrypoint bash "$IMG" -s`,
    "else",
    `  printf '%s' '${b64}' | base64 -d | bash -s`,
    "fi",
    "",
  ].join("\n");
}

// ───────────────────────────── test every domain by Host header: status and content hash ─────────────────────────────

/** Which proxy a probe talks to. `coolify`: the box's :443 while Coolify's proxy owns it. `tugra-dark`: Tugra's proxy by its own bridge address, no host port. `local`: the box's :443 once Tugra's proxy owns it. */
export type ProbeVia = "coolify" | "tugra-dark" | "local";

/**
 * For each host: the HTTP status and a SHA-256 of the response body, through the chosen proxy, TLS verification off (the certificate is
 * judged by its own check, not here). The body is hashed on the host and never printed. `twice` fetches twice so a page that changes on
 * every request (a timestamp, a nonce) can be told from one that is the same each time: both hashes are printed.
 */
export function buildInPlaceProbeScript(o: { via: ProbeVia; hosts: readonly string[]; path: string; twice?: boolean }): string {
  assertHosts(o.hosts);
  if (!PROBE_PATH_RE.test(o.path)) throw new Error("inplace: invalid path");
  const target =
    o.via === "tugra-dark"
      ? [
          `IP=$(docker container inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' tugra-proxy 2>/dev/null | awk '{print $1}')`,
          `case "$IP" in ''|*[!0-9.]*) echo "${IP_MARK.probe}|NOPROXY"; echo ${IP_MARK.probeEnd}; exit 0;; esac`,
        ]
      : ["IP=127.0.0.1"];
  // status, size and (for a redirect) where to, as one word each; the query string and fragment of a redirect never leave the host
  const one = (n: number) => [
    `  o${n}=$(curl -ksS -o "$T" -m 10 -w '%{http_code} %{size_download} %{redirect_url}' --resolve "$H:443:$IP" "https://$H$P" 2>/dev/null) || o${n}="000 0 "`,
    `  c${n}=\${o${n}%% *}; r${n}=\${o${n}#* }; z${n}=\${r${n}%% *}; l${n}=\${r${n}#* }`,
    `  h${n}=$(hashfile "$T")`,
  ];
  return [
    "set -u",
    `P=${shq(o.path)}`,
    ...target,
    `command -v curl >/dev/null 2>&1 || { echo "${IP_MARK.probe}|NOCURL"; echo ${IP_MARK.probeEnd}; exit 0; }`,
    "hashfile() {",
    '  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d" " -f1',
    '  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d" " -f1',
    '  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 "$1" | sed "s/.*= //"',
    "  else echo none; fi",
    "}",
    "T=$(mktemp) || exit 0",
    `trap 'rm -f "$T"' EXIT`,
    `for H in ${o.hosts.map(shq).join(" ")}; do`,
    ...one(1),
    ...(o.twice ? one(2) : ["  c2=$c1; h2=$h1"]),
    '  l1=${l1%%[?#]*}; l1=$(printf %s "$l1" | tr -d \'|\\r\\n\' | cut -c1-200)',
    `  printf '${IP_MARK.probe}|%s|%s|%s|%s|%s|%s\\n' "$H" "\${c1:-000}" "\${h1:-none}" "\${h2:-none}" "\${z1:-0}" "$l1"`,
    "done",
    `echo ${IP_MARK.probeEnd}`,
    "",
  ].join("\n");
}

export interface ProbeResult {
  /** HTTP status; null for 000 / no answer. */
  status: number | null;
  /** SHA-256 hex of the body, or null when the host could not hash. */
  hash: string | null;
  /** Hash of a second fetch; equal to `hash` for a page that does not change. */
  hash2: string | null;
  /** Bytes of the body of the first fetch, when the host reported it (absent in a record written by an older hub). */
  size?: number | null;
  /** Where the first fetch redirected to (no query string, no fragment), when it did. */
  location?: string | null;
}
export type ProbeOutput = { kind: "noproxy" } | { kind: "nocurl" } | { kind: "ok"; hosts: Record<string, ProbeResult> };

/** Parse a probe. `null` for a cut output or one with no END marker (never a partial pass). Hosts not asked for are ignored. */
export function parseInPlaceProbe(out: string, requested: readonly string[]): ProbeOutput | null {
  if (out.includes("…(truncated)")) return null;
  const lines = out.split(/\r?\n/);
  if (!lines.includes(IP_MARK.probeEnd)) return null;
  if (lines.includes(`${IP_MARK.probe}|NOPROXY`)) return { kind: "noproxy" };
  if (lines.includes(`${IP_MARK.probe}|NOCURL`)) return { kind: "nocurl" };
  const want = new Set(requested);
  const hosts: Record<string, ProbeResult> = {};
  const h = (v: string): string | null => (HEX64.test(v) ? v : null);
  for (const l of lines) {
    const f = l.split("|");
    if (f[0] !== IP_MARK.probe || (f.length !== 5 && f.length !== 7) || !want.has(f[1]) || !/^\d{3}$/.test(f[2])) continue;
    const status = Number(f[2]);
    const size = f.length === 7 && /^\d{1,12}$/.test(f[5]) ? Number(f[5]) : null;
    const loc = f.length === 7 && /^[\x21-\x7e]{1,200}$/.test(f[6]) ? f[6] : null;
    hosts[f[1]] = { status: status === 0 ? null : status, hash: h(f[3]), hash2: h(f[4]), size, location: loc };
  }
  return { kind: "ok", hosts };
}

// ───────────────────────────── is the app's container up? ─────────────────────────────

/** What the box shows of one container: docker's state, its health (`none` = no health check) and its restart count. */
export interface AppProbe {
  name: string;
  /** docker's state: `running`, `restarting`, `exited`, `created`, `dead`, `paused`; `absent` when there is no such container. */
  state: string;
  health: "healthy" | "unhealthy" | "starting" | "none";
  restarts: number;
}

/** Read-only: the state, health and restart count of each named container (Tugra's copy of an app is `tugra_<appId>`). Prints `absent` for one that does not exist. */
export function buildAppReadyScript(names: readonly string[]): string {
  for (const n of names) if (!NAME_RE.test(n)) throw new Error("inplace: invalid container name");
  const M = IP_MARK.app;
  return [
    "set -u",
    `for N in ${names.map(shq).join(" ")}; do`,
    `  docker container inspect -f '${M}|{{.Name}}|{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.RestartCount}}' "$N" 2>/dev/null || printf '${M}|/%s|absent|none|0\\n' "$N"`,
    "done",
    `echo ${IP_MARK.appEnd}`,
    "",
  ].join("\n");
}

/** Parse the containers. `null` for a cut output or one with no END marker; a line that fails any check is dropped (never trusted as a pass). */
export function parseAppReady(out: string): AppProbe[] | null {
  if (out.includes("…(truncated)")) return null;
  const lines = out.split(/\r?\n/);
  if (!lines.includes(IP_MARK.appEnd)) return null;
  const res: AppProbe[] = [];
  for (const l of lines) {
    const f = l.split("|");
    if (f[0] !== IP_MARK.app || f.length !== 5) continue;
    const name = f[1].replace(/^\//, "");
    if (!NAME_RE.test(name) || !/^[a-z]{3,12}$/.test(f[2]) || !/^\d{1,9}$/.test(f[4])) continue;
    const health = f[3] === "healthy" || f[3] === "unhealthy" || f[3] === "starting" || f[3] === "none" ? f[3] : null;
    if (!health) continue;
    res.push({ name, state: f[2], health, restarts: Number(f[4]) });
  }
  return res;
}

// ───────────────────────────── fallback certificate (Coolify's, short-lived) and the new-certificate check ─────────────────────────────

const certFileBase = (host: string): string => `fb-${host.replace(/[^a-z0-9]/g, "-")}`;

/**
 * Serve Coolify's certificate for each host from the Tugra proxy's own dynamic directory until the new Let's Encrypt one is verified.
 * The certificate and key are read from Coolify's acme.json ON THE HOST and written (key 0600) beside the proxy's config; nothing but
 * the host name and the certificate serial is printed. A host Coolify has no certificate for prints `absent` (and nothing is written).
 */
export function buildFallbackInstallScript(o: { hosts: readonly string[]; acmePath?: string }): string {
  assertHosts(o.hosts);
  const acme = o.acmePath ?? COOLIFY_ACME_DEFAULT;
  if (!ACME_PATH_RE.test(acme) || acme.includes("..")) throw new Error("inplace: invalid acme path");
  const M = IP_MARK.fallback;
  return [
    "set -u",
    `A=${shq(acme)}`,
    `D=${shq(PROXY_DYNAMIC_DIR)}`,
    `C=${shq(FALLBACK_CERT_DIR)}`,
    `[ -r "$A" ] || { for H in ${o.hosts.map(shq).join(" ")}; do printf '${M}|%s|noacme|-\\n' "$H"; done; exit 0; }`,
    'mkdir -p "$C" && chmod 700 "$C" 2>/dev/null',
    // acme.json flattened to one line; one match per certificate: <main> <certificate b64> <key b64>, in file order
    `FLAT=$(tr -d '\\n\\r\\t ' < "$A")`,
    "triples() {",
    `  printf '%s' "$FLAT" | grep -oE '"main":"[^"]+"[^}]*\\}[^"]*"certificate":"[A-Za-z0-9+/=]+","key":"[A-Za-z0-9+/=]+"' \\`,
    `    | sed -E 's|^"main":"([^"]+)".*"certificate":"([A-Za-z0-9+/=]+)","key":"([A-Za-z0-9+/=]+)"$|\\1 \\2 \\3|'`,
    "}",
    "one() {",
    `  line=$(triples | awk -v h="$1" '$1==h {l=$0} END{print l}')`,
    `  [ -n "$line" ] || { printf '${M}|%s|absent|-\\n' "$1"; return; }`,
    '  b=$2; cert=$(printf %s "$line" | cut -d" " -f2); key=$(printf %s "$line" | cut -d" " -f3)',
    "  umask 077",
    '  if ! { printf %s "$cert" | base64 -d > "$C/$b.crt.tmp" 2>/dev/null && printf %s "$key" | base64 -d > "$C/$b.key.tmp" 2>/dev/null; }; then',
    '    rm -f "$C/$b.crt.tmp" "$C/$b.key.tmp"',
    `    printf '${M}|%s|bad|-\\n' "$1"; return`,
    "  fi",
    '  chmod 600 "$C/$b.key.tmp"',
    '  mv "$C/$b.crt.tmp" "$C/$b.crt" && mv "$C/$b.key.tmp" "$C/$b.key"',
    `  printf 'tls:\\n  certificates:\\n    - certFile: /dynamic/certs/%s.crt\\n      keyFile: /dynamic/certs/%s.key\\n' "$b" "$b" > "$D/.tls-$b.yml.tmp" && mv "$D/.tls-$b.yml.tmp" "$D/tls-$b.yml"`,
    '  ser=$(openssl x509 -in "$C/$b.crt" -noout -serial 2>/dev/null | sed "s/^serial=//")',
    `  printf '${M}|%s|installed|%s\\n' "$1" "\${ser:--}"`,
    "}",
    ...o.hosts.map((h) => `one ${shq(h)} ${shq(certFileBase(h))}`),
    "",
  ].join("\n");
}

export type FallbackOutcome = "installed" | "absent" | "bad" | "noacme";
export interface FallbackResult {
  outcome: FallbackOutcome;
  /** Serial of the installed certificate (hex), or null when the host could not read it. */
  serial: string | null;
}
export function parseFallbackInstall(out: string, hosts: readonly string[]): Map<string, FallbackResult> | null {
  if (out.includes("…(truncated)")) return null;
  const want = new Set(hosts);
  const res = new Map<string, FallbackResult>();
  for (const l of out.split(/\r?\n/)) {
    const f = l.split("|");
    if (f[0] !== IP_MARK.fallback || f.length !== 4 || !want.has(f[1])) continue;
    if (!["installed", "absent", "bad", "noacme"].includes(f[2])) continue;
    res.set(f[1], { outcome: f[2] as FallbackOutcome, serial: /^[0-9A-Fa-f]{1,64}$/.test(f[3]) ? f[3].toUpperCase() : null });
  }
  return want.size === res.size ? res : null;
}

/** Remove the fallback certificate of the given hosts from the proxy's dynamic directory (the files this lane wrote, by name; nothing else). */
export function buildFallbackRemoveScript(hosts: readonly string[]): string {
  assertHosts(hosts);
  return [
    "set -u",
    ...hosts.flatMap((h) => {
      const b = certFileBase(h);
      return [`rm -f ${shq(`${PROXY_DYNAMIC_DIR}/tls-${b}.yml`)} ${shq(`${FALLBACK_CERT_DIR}/${b}.crt`)} ${shq(`${FALLBACK_CERT_DIR}/${b}.key`)}`];
    }),
    "echo TUGRA_IP_FALLBACK_REMOVED",
    "",
  ].join("\n");
}

/**
 * What certificate does the box serve for this host right now: its serial and issuer, read with a real TLS handshake on :443 (SNI)
 * and compared by the hub with the fallback's serial. Prints no certificate body.
 */
export function buildNewCertCheckScript(host: string): string {
  assertHosts([host]);
  return [
    "set -u",
    `H=${shq(host)}`,
    `command -v openssl >/dev/null 2>&1 || { echo "${IP_MARK.cert}|$H|noopenssl|-|-"; exit 0; }`,
    `out=$(printf '' | openssl s_client -connect 127.0.0.1:443 -servername "$H" 2>/dev/null | openssl x509 -noout -serial -issuer 2>/dev/null) || out=""`,
    `ser=$(printf %s "$out" | sed -n 's/^serial=//p' | head -n1)`,
    `iss=$(printf %s "$out" | sed -n 's/^issuer=//p' | head -n1 | tr -c 'A-Za-z0-9 .,=_-' ' ' | cut -c1-120)`,
    `[ -n "$ser" ] || { echo "${IP_MARK.cert}|$H|none|-|-"; exit 0; }`,
    `printf '${IP_MARK.cert}|%s|served|%s|%s\\n' "$H" "$ser" "$iss"`,
    "",
  ].join("\n");
}

export type ServedCert = { state: "served"; serial: string; issuer: string } | { state: "none" } | { state: "noopenssl" };
export function parseNewCertCheck(out: string, host: string): ServedCert | null {
  if (out.includes("…(truncated)")) return null;
  for (const l of out.split(/\r?\n/)) {
    const f = l.split("|");
    if (f[0] !== IP_MARK.cert || f[1] !== host) continue;
    if (f[2] === "noopenssl") return { state: "noopenssl" };
    if (f[2] === "none") return { state: "none" };
    if (f[2] === "served" && f.length >= 5 && /^[0-9A-Fa-f]{1,64}$/.test(f[3])) return { state: "served", serial: f[3].toUpperCase(), issuer: f.slice(4).join("|").trim() };
  }
  return null;
}

/** Is a served certificate a NEW Let's Encrypt one (a different serial than the fallback's, issued by Let's Encrypt)? */
export function isNewLetsEncryptCert(served: ServedCert, fallbackSerial: string | null): boolean {
  return served.state === "served" && /let'?s encrypt|\bO=ISRG\b|\bCN=(R|E)\d{1,2}\b/i.test(served.issuer) && (fallbackSerial === null || served.serial !== fallbackSerial.toUpperCase());
}

// ───────────────────────────── is the database the same? (read-only, by the container's own environment) ─────────────────────────────

/** Engines the takeover can check (the others are refused: nothing could say the data survived). */
export type FingerprintEngine = "POSTGRES" | "MYSQL" | "MARIADB" | "REDIS" | "KEYDB" | "DRAGONFLY" | "MONGO";
export const FINGERPRINT_ENGINES: readonly FingerprintEngine[] = ["POSTGRES", "MYSQL", "MARIADB", "REDIS", "KEYDB", "DRAGONFLY", "MONGO"];
export type DbCheckLevel = "counts" | "alive";
/** How each engine is checked: exact row counts where the container's own env can log in, else "does it answer". */
export const checkLevelOf = (e: FingerprintEngine): DbCheckLevel => (e === "POSTGRES" || e === "MYSQL" || e === "MARIADB" ? "counts" : "alive");
export const isFingerprintEngine = (e: string): e is FingerprintEngine => (FINGERPRINT_ENGINES as readonly string[]).includes(e);

/** A name docker accepts for a container, used to address the Tugra side (which has no recorded id). */
const CTR_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

// What is sent to the database inside the container: a query that writes one count statement per table, which a second pass runs.
const PG_LIST = "select format('select %L, count(*) from %I.%I;', n.nspname || '.' || c.relname, n.nspname, c.relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind = 'r' and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_toast%' order by n.nspname, c.relname limit 500;";
const MY_LIST = "select concat('select \\'', table_schema, '.', table_name, '\\', count(*) from `', table_schema, '`.`', table_name, '`;') from information_schema.tables where table_type = 'BASE TABLE' and table_schema not in ('mysql', 'information_schema', 'performance_schema', 'sys') order by table_schema, table_name limit 500;";

export type DbTarget = { engine: FingerprintEngine; ref: { kind: "recorded"; ctr: RecordedCtr } | { kind: "name"; name: string } };

/**
 * For each container (a RECORDED id with its identity checked, or the name Tugra gave its own): can the database be read, and how many
 * tables and rows does it hold? Printed as `<level>|<state>|<tables>|<rows>|<sha256 of the sorted per-table counts>`: no table name, no
 * value, no credential. The login happens INSIDE the container with the variables the image itself was started with; the hub never sees a
 * password. The level is `alive` for engines whose rows cannot be counted that way (the redis family, mongo): the engine answers (or asks for
 * a password, which is also an answer) and the numbers are `-`. Nothing here writes, and nothing removes anything.
 */
export function buildDbFingerprintScript(targets: readonly DbTarget[]): string {
  const M = IP_MARK.dbfp;
  for (const t of targets) {
    if (!isFingerprintEngine(t.engine)) throw new Error("inplace: unsupported engine");
    if (t.ref.kind === "recorded") assertRecorded([t.ref.ctr]);
    else if (!CTR_NAME_RE.test(t.ref.name)) throw new Error("inplace: invalid container name");
  }
  const pgcli = `PGPASSWORD="$POSTGRES_PASSWORD" exec psql -X -q -At -F "|" -U "\${POSTGRES_USER:-postgres}" -d "\${POSTGRES_DB:-\${POSTGRES_USER:-postgres}}" -v ON_ERROR_STOP=1`;
  const mycli = `C=$(command -v mariadb || command -v mysql) || exit 127; exec "$C" -uroot -p"\${MARIADB_ROOT_PASSWORD:-\${MYSQL_ROOT_PASSWORD:-}}" -N -B`;
  return [
    "set -u",
    ...IDENT,
    "hashstdin() {",
    '  if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -d" " -f1',
    '  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 | cut -d" " -f1',
    "  else echo none; fi",
    "}",
    "summarize() {",
    `  awk -F'|' 'NF>=2 { t++; r+=$NF } END { printf "%d|%d\\n", t+0, r+0 }'`,
    "}",
    "pgcounts() {",
    `  docker exec -i "$1" sh -c '${pgcli}' <<'SQL' | docker exec -i "$1" sh -c '${pgcli}'`,
    PG_LIST,
    "SQL",
    "}",
    "mycounts() {",
    `  docker exec -i "$1" sh -c '${mycli}' <<'SQL' | docker exec -i "$1" sh -c '${mycli}'`,
    MY_LIST,
    "SQL",
    "}",
    "alive() {",
    '  case "$2" in',
    `    REDIS|KEYDB|DRAGONFLY) r=$(docker exec "$1" sh -c 'redis-cli ping 2>&1 || keydb-cli ping 2>&1' 2>/dev/null) ;;`,
    `    MONGO) r=$(docker exec "$1" sh -c 'mongosh --quiet --eval "db.adminCommand({ping:1}).ok" 2>&1 || mongo --quiet --eval "db.adminCommand({ping:1}).ok" 2>&1' 2>/dev/null) ;;`,
    '    *) r="" ;;',
    "  esac",
    '  case "$r" in *PONG*|*NOAUTH*|*1*) return 0 ;; esac',
    "  return 1",
    "}",
    "fp() {",
    // $1 = container ref (id or name), $2 = engine, $3 = the label printed back
    '  out=""; lv=alive',
    '  case "$2" in',
    `    POSTGRES) lv=counts; out=$(pgcounts "$1" 2>/dev/null) && st=ok || st=failed ;;`,
    `    MYSQL|MARIADB) lv=counts; out=$(mycounts "$1" 2>/dev/null) && st=ok || st=failed ;;`,
    `    *) if alive "$1" "$2"; then st=ok; else st=failed; fi ;;`,
    "  esac",
    '  if [ "$lv" = counts ] && [ "$st" = ok ]; then',
    `    sum=$(printf '%s\\n' "$out" | summarize); h=$(printf '%s\\n' "$out" | sort | hashstdin)`,
    `    printf '${M}|%s|%s|%s|%s|%s\\n' "$3" "$lv" "$st" "$sum" "$h"`,
    "  else",
    `    printf '${M}|%s|%s|%s|-|-|-\\n' "$3" "$lv" "$st"`,
    "  fi",
    "}",
    "one_recorded() {",
    '  ident "$1" "$2" "$3"; r=$?',
    `  [ "$r" = 2 ] && { printf '${M}|%s|-|absent|-|-|-\\n' "$1"; return; }`,
    `  [ "$r" = 1 ] && { printf '${M}|%s|-|mismatch|-|-|-\\n' "$1"; return; }`,
    '  fp "$1" "$4" "$1"',
    "}",
    "one_named() {",
    `  docker inspect "$1" >/dev/null 2>&1 || { printf '${M}|%s|-|absent|-|-|-\\n' "$1"; return; }`,
    '  fp "$1" "$2" "$1"',
    "}",
    ...targets.map((t) => (t.ref.kind === "recorded" ? `one_recorded ${shq(t.ref.ctr.id)} ${shq(t.ref.ctr.name)} ${shq(t.ref.ctr.image)} ${shq(t.engine)}` : `one_named ${shq(t.ref.name)} ${shq(t.engine)}`)),
    "",
  ].join("\n");
}

export type DbFingerprintState = "ok" | "failed" | "absent" | "mismatch";
export interface DbFingerprint {
  level: DbCheckLevel | null;
  state: DbFingerprintState;
  tables: number | null;
  rows: number | null;
  hash: string | null;
}

/** Parse the fingerprint output, keyed by the ref asked for. A missing or malformed line is absent from the map (never a pass). */
export function parseDbFingerprint(out: string, refs: readonly string[]): Map<string, DbFingerprint> | null {
  if (out.includes("…(truncated)")) return null;
  const want = new Set(refs);
  const res = new Map<string, DbFingerprint>();
  for (const l of out.split(/\r?\n/)) {
    const f = l.split("|");
    if (f[0] !== IP_MARK.dbfp || f.length !== 7 || !want.has(f[1])) continue;
    const [, ref, lv, st, tables, rows, hash] = f;
    if (!["ok", "failed", "absent", "mismatch"].includes(st)) continue;
    const level = lv === "counts" || lv === "alive" ? lv : null;
    const n = (v: string): number | null => (/^\d{1,12}$/.test(v) ? Number(v) : null);
    res.set(ref, { level, state: st as DbFingerprintState, tables: n(tables), rows: n(rows), hash: HEX64.test(hash) ? hash : null });
  }
  return res;
}

/**
 * Is what Tugra's container shows the same as what Coolify's container showed? `counts` needs both to have been read, with the same tables,
 * rows and hash; `alive` needs the Tugra side to answer (there is nothing to compare). Anything unread is a failure, never a pass.
 */
export function sameDatabase(before: DbFingerprint | null | undefined, after: DbFingerprint | null | undefined): boolean {
  if (!after || after.state !== "ok") return false;
  if (after.level === "alive") return true;
  if (!before || before.state !== "ok" || before.level !== "counts" || after.level !== "counts") return false;
  return before.hash !== null && before.hash === after.hash && before.tables === after.tables && before.rows === after.rows;
}
