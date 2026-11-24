import { z } from "zod";
import { CONTAINER_REF_RE, NO_DOCKER_MARKER, classifyTugraOwned, isProjectAnchor } from "../migrator/discover-script";
import {
  MARKER_SOFTWARE,
  WELL_KNOWN_PORTS,
  softwareById,
  softwareForImage,
  softwareForUnit,
  type SoftwareKind,
  type SoftwareRef,
} from "./server-scan-software";

/**
 * Server scan ("What runs on this server"): a READ-ONLY inventory of a host, built from two probes the hub runs through
 * the existing `sendCommand` channel (capability "bulk", no new capability):
 *   1. a docker probe in the agent's own shell: one compact line per container (name, image, state, compose labels,
 *      Coolify flag, published ports) — no env values, no full label set;
 *   2. a host probe: the agent image's `scan` subcommand in a sandboxed helper container that sees the host filesystem
 *      READ-ONLY (PM2 homes, nginx/apache vhosts, systemd unit names, panel marker paths, listening sockets).
 * Everything an agent sends back is UNTRUSTED: each field is matched against a strict schema, capped, and anything that
 * does not fit is dropped before it is stored or relayed to a browser. Nothing here changes the host.
 */

export const SCAN_DOCKER_BEGIN = "TUGRA_SCAN_DOCKER_BEGIN";
export const SCAN_DOCKER_END = "TUGRA_SCAN_DOCKER_END";
export const SCAN_HOST_BEGIN = "TUGRA_SCAN_HOST_BEGIN";
export const SCAN_HOST_END = "TUGRA_SCAN_HOST_END";
export const SCAN_HOST_UNAVAILABLE = "TUGRA_SCAN_HOST_UNAVAILABLE";
export const SCAN_HOST_FAILED = "TUGRA_SCAN_HOST_FAILED";

/** Most containers one scan reads (the agent's command output is capped at 64 KB). */
export const MAX_SCAN_CONTAINERS = 250;

const PATH = "export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/** One line per container: a JSON array. Only the labels the report needs are indexed (never the whole label set or env). */
const DOCKER_FORMAT =
  "[{{json .Name}},{{json .Config.Image}},{{json .State.Status}}," +
  '{{json (index .Config.Labels "com.docker.compose.project")}},{{json (index .Config.Labels "com.docker.compose.service")}},' +
  '{{json (index .Config.Labels "com.docker.compose.project.working_dir")}},{{json (index .Config.Labels "coolify.managed")}},' +
  '{{json (index .Config.Labels "tugra.role")}},"{{range $p, $b := .HostConfig.PortBindings}}{{range $b}}{{.HostPort}} {{end}}{{end}}"]';

/** Parameterless docker probe: a pure constant, nothing from the hub or the request is interpolated. */
export function buildDockerScanScript(): string {
  return [
    PATH,
    `if ! command -v docker >/dev/null 2>&1; then echo ${NO_DOCKER_MARKER}; exit 0; fi`,
    `echo ${SCAN_DOCKER_BEGIN}`,
    `ids=$(docker ps -aq --no-trunc 2>/dev/null | head -n ${MAX_SCAN_CONTAINERS + 1})`,
    `if [ -n "$ids" ]; then docker inspect --format '${DOCKER_FORMAT}' $ids 2>/dev/null; fi`,
    `echo ${SCAN_DOCKER_END}`,
    "exit 0",
  ].join("\n");
}

/**
 * Host probe. The helper is the agent's OWN image (from the trusted $TUGRA_AGENT_IMAGE only, `--pull never`), run with:
 * the host root mounted READ-ONLY, the host PID and network namespaces (so /proc lists host processes and listening
 * sockets), every capability dropped except DAC_READ_SEARCH (read files whose mode hides them from root, e.g. a 0750
 * home directory; it cannot write), no new privileges, a read-only root filesystem and small pid/memory limits. It runs
 * `tugra-agent scan`, which only reads a fixed list of paths (see agent/internal/scan). An agent image without the
 * subcommand prints nothing; the hub reports that as "update the agent".
 */
export function buildHostScanScript(): string {
  return [
    PATH,
    'IMG="$TUGRA_AGENT_IMAGE"',
    `[ -n "$IMG" ] || { echo "${SCAN_HOST_UNAVAILABLE} reason=no-image"; exit 0; }`,
    "for o in $(timeout 10 docker ps -aq --filter label=tugra.role=scan-helper 2>/dev/null); do timeout 10 docker rm -f \"$o\" >/dev/null 2>&1; done",
    'pn="tugra-scan-$$-$(date +%s)"',
    `echo ${SCAN_HOST_BEGIN}`,
    'out=$(timeout -k 5 40 docker run --rm --pull never --name "$pn" --label tugra.role=scan-helper \\',
    "  --network host --pid host --userns host --read-only --cap-drop ALL --cap-add DAC_READ_SEARCH \\",
    "  --security-opt no-new-privileges --security-opt label=disable --pids-limit 32 --memory 128m \\",
    '  -v /:/host:ro --entrypoint tugra-agent "$IMG" scan --root=/host --proc=/proc 2>/dev/null); rc=$?',
    '[ $rc -eq 0 ] || { timeout 10 docker rm -f "$pn" >/dev/null 2>&1; echo "' + SCAN_HOST_FAILED + ' rc=$rc"; }',
    `[ $rc -eq 0 ] && printf '%s\\n' "$out" | head -c 48000`,
    `echo ${SCAN_HOST_END}`,
    "exit 0",
  ].join("\n");
}

// ── schemas ─────────────────────────────────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const text = (max: number) =>
  z
    .string()
    .transform((s) => s.replace(CONTROL, " ").replace(/\s+/g, " ").trim().slice(0, max))
    .pipe(z.string().max(max));
const port = z.number().int().min(1).max(65535);

const HostPm2ProcSchema = z.object({
  name: text(120).pipe(z.string().min(1)),
  script: text(200).optional().default(""),
  cwd: text(200).optional().default(""),
  mode: z.enum(["fork", "cluster"]).optional(),
  instances: z.number().int().min(1).max(1023).optional(),
  status: z.enum(["online", "stopped"]),
  port: port.optional(),
  envCount: z.number().int().min(0).max(100000).optional().default(0),
});
const HostPm2UserSchema = z.object({
  user: text(64).pipe(z.string().min(1)),
  daemon: z.boolean(),
  procs: z.array(z.unknown()).max(100),
});
const HostSiteSchema = z.object({
  server: z.enum(["nginx", "apache"]),
  names: z.array(text(120).pipe(z.string().min(1))).min(1).max(20),
  root: text(200).optional().default(""),
  kind: z.enum(["php", "proxy", "static", "other"]),
  port: port.optional(),
  php: z.string().regex(/^\d\.\d$/).optional(),
  ssl: z.boolean(),
  panel: z.literal("cloudpanel").optional(),
  siteUser: text(64).optional(),
});
const HostServiceSchema = z.object({
  unit: z.string().regex(/^[A-Za-z0-9@._:-]{1,100}$/),
  kind: z.enum(["web", "php", "database", "runtime", "panel", "tool", "app"]),
  enabled: z.boolean(),
  running: z.boolean().optional(),
  exec: text(40).optional(),
  workDir: text(200).optional(),
});
const HostPortSchema = z.object({ port, proto: z.literal("tcp"), scope: z.enum(["public", "local"]) });

/** Keep the items that validate, drop the rest (one malformed row must not discard the whole section). */
function lenient<S extends z.ZodTypeAny>(schema: S, max: number) {
  return z
    .array(z.unknown())
    .max(max * 2)
    .catch([])
    .transform((arr) => {
      const out: z.infer<S>[] = [];
      for (const item of arr) {
        const r = schema.safeParse(item);
        if (r.success) out.push(r.data);
        if (out.length >= max) break;
      }
      return out;
    });
}

const Pm2UserOut = z.object({
  user: z.string(),
  daemon: z.boolean(),
  procs: z.array(HostPm2ProcSchema),
});
export type ScanPm2Proc = z.infer<typeof HostPm2ProcSchema>;
export type ScanPm2User = z.infer<typeof Pm2UserOut>;
export type ScanSite = z.infer<typeof HostSiteSchema>;
export type ScanService = z.infer<typeof HostServiceSchema>;

export const HostScanSchema = z.object({
  v: z.literal(1),
  markers: z.array(z.string().max(30)).max(40).catch([]),
  pm2: lenient(HostPm2UserSchema, 50).transform((users) =>
    users.map((u) => ({
      user: u.user,
      daemon: u.daemon,
      procs: (() => {
        const procs: ScanPm2Proc[] = [];
        for (const p of u.procs) {
          const r = HostPm2ProcSchema.safeParse(p);
          if (r.success) procs.push(r.data);
          if (procs.length >= 100) break;
        }
        return procs;
      })(),
    })),
  ),
  sites: lenient(HostSiteSchema, 150),
  services: lenient(HostServiceSchema, 60),
  ports: lenient(HostPortSchema, 150),
});
export type HostScan = z.infer<typeof HostScanSchema>;

export const SOFTWARE_KINDS = ["platform", "panel", "web", "runtime", "database", "app", "tool"] as const;

export const ScanSoftwareSchema = z.object({
  id: z.string().max(80),
  label: z.string().max(80),
  kind: z.enum(SOFTWARE_KINDS),
  logo: z.string().max(80).nullable(),
  count: z.number().int().min(1).max(100000),
  containers: z.array(z.string().max(128)).max(30),
});
export type ScanSoftware = z.infer<typeof ScanSoftwareSchema>;

export const ScanContainerSchema = z.object({
  name: z.string().max(128),
  image: z.string().max(255),
  state: z.string().max(20),
  project: z.string().max(100).nullable(),
  service: z.string().max(100).nullable(),
  software: z.string().max(80).nullable(),
  managedBy: z.enum(["coolify", "dokploy"]).nullable(),
  ports: z.array(port).max(20),
  adoptable: z.boolean(),
});
export type ScanContainer = z.infer<typeof ScanContainerSchema>;

export const ScanReportSchema = z.object({
  v: z.literal(1),
  scannedAt: z.string(),
  host: z.object({ status: z.enum(["ok", "unavailable"]), reason: z.enum(["agent_outdated", "no_image", "failed"]).nullable() }),
  docker: z.object({
    available: z.boolean(),
    total: z.number().int().min(0),
    running: z.number().int().min(0),
    tugra: z.number().int().min(0),
    truncated: z.boolean(),
  }),
  software: z.array(ScanSoftwareSchema).max(80),
  containers: z.array(ScanContainerSchema).max(MAX_SCAN_CONTAINERS),
  composeProjects: z.array(z.object({ name: z.string().max(100), services: z.number().int().min(0), running: z.number().int().min(0) })).max(150),
  pm2: z.array(Pm2UserOut).max(50),
  sites: z.array(HostSiteSchema).max(150),
  services: z.array(HostServiceSchema).max(60),
  ports: z.array(z.object({ port, scope: z.enum(["public", "local"]), owner: z.string().max(128).nullable() })).max(150),
});
export type ScanReport = z.infer<typeof ScanReportSchema>;

export const ScanViewSchema = z.object({ report: ScanReportSchema.nullable() });
export type ScanView = z.infer<typeof ScanViewSchema>;

/** Read a stored Json column back: a corrupt / old-shape row degrades to null (= never scanned), never a throw. */
export function parseStoredReport(json: unknown): ScanReport | null {
  const r = ScanReportSchema.safeParse(json);
  return r.success ? r.data : null;
}

// ── docker probe parsing ────────────────────────────────────────────────────────────────────────────────────────────

export interface DockerRow {
  name: string;
  image: string;
  state: string;
  project: string | null;
  service: string | null;
  workingDir: string | null;
  coolifyManaged: boolean;
  tugraRole: boolean;
  ports: number[];
}

export type DockerScan = { available: false } | { available: true; rows: DockerRow[]; truncated: boolean };

const STATES = new Set(["created", "running", "paused", "restarting", "removing", "exited", "dead"]);

function cleanStr(v: unknown, max: number): string {
  return typeof v === "string" ? v.replace(CONTROL, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";
}

/** The docker probe's output → rows. null when the probe printed neither marker (it did not run). */
export function parseDockerScan(output: string): DockerScan | null {
  if (output.includes(NO_DOCKER_MARKER)) return { available: false };
  const lines = output.split(/\r?\n/);
  const begin = lines.findIndex((l) => l.trim() === SCAN_DOCKER_BEGIN);
  if (begin < 0) return null;
  const rows: DockerRow[] = [];
  let truncated = !lines.some((l) => l.trim() === SCAN_DOCKER_END) || output.includes("(truncated)");
  for (let i = begin + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === SCAN_DOCKER_END) break;
    if (!line.startsWith("[")) continue;
    let a: unknown;
    try {
      a = JSON.parse(line);
    } catch {
      continue;
    }
    if (!Array.isArray(a) || a.length !== 9) continue;
    const name = cleanStr(a[0], 130).replace(/^\//, "");
    if (!CONTAINER_REF_RE.test(name)) continue;
    if (rows.length >= MAX_SCAN_CONTAINERS) {
      truncated = true;
      break;
    }
    const ports: number[] = [];
    for (const p of cleanStr(a[8], 400).split(" ")) {
      const n = /^\d{1,5}$/.test(p) ? Number(p) : 0;
      if (n >= 1 && n <= 65535 && !ports.includes(n) && ports.length < 20) ports.push(n);
    }
    const state = cleanStr(a[2], 20);
    rows.push({
      name,
      image: cleanStr(a[1], 255),
      state: STATES.has(state) ? state : "unknown",
      project: cleanStr(a[3], 100) || null,
      service: cleanStr(a[4], 100) || null,
      workingDir: cleanStr(a[5], 200) || null,
      coolifyManaged: cleanStr(a[6], 10).toLowerCase() === "true",
      tugraRole: cleanStr(a[7], 40) !== "",
      ports,
    });
  }
  return { available: true, rows, truncated };
}

// ── host probe parsing ──────────────────────────────────────────────────────────────────────────────────────────────

export type HostUnavailableReason = "agent_outdated" | "no_image" | "failed";
export type HostScanResult = { status: "ok"; data: HostScan } | { status: "unavailable"; reason: HostUnavailableReason };

export function parseHostScan(output: string): HostScanResult {
  if (output.includes(`${SCAN_HOST_UNAVAILABLE} reason=no-image`)) return { status: "unavailable", reason: "no_image" };
  if (output.includes(SCAN_HOST_FAILED)) return { status: "unavailable", reason: "failed" };
  const lines = output.split(/\r?\n/);
  const begin = lines.findIndex((l) => l.trim() === SCAN_HOST_BEGIN);
  if (begin < 0) return { status: "unavailable", reason: "failed" };
  const json = lines.slice(begin + 1).find((l) => l.trim().startsWith("{"));
  // An agent image without the `scan` subcommand ran its normal entrypoint, which prints nothing to stdout.
  if (!json) return { status: "unavailable", reason: "agent_outdated" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { status: "unavailable", reason: "failed" };
  }
  const r = HostScanSchema.safeParse(parsed);
  return r.success ? { status: "ok", data: r.data } : { status: "unavailable", reason: "failed" };
}

// ── report assembly ─────────────────────────────────────────────────────────────────────────────────────────────────

const KIND_RANK: Record<SoftwareKind, number> = { platform: 0, panel: 1, runtime: 2, web: 3, database: 4, app: 5, tool: 6 };
const COOLIFY_NAME_RE = /^coolify(-|$)/;
const DOKPLOY_NAME_RE = /^dokploy(-|$)/;

/** The foreign (non-Tugra) rows and how many were Tugra's own. */
function splitTugra(rows: DockerRow[]): { foreign: DockerRow[]; tugra: number } {
  const classified = rows.map((r) => ({
    r,
    reason: classifyTugraOwned({ name: r.name, image: r.image, composeProject: r.project, composeService: r.service, composeWorkingDir: r.workingDir, labelKeys: r.tugraRole ? ["tugra.role"] : [] }),
    anchor: isProjectAnchor({ image: r.image, composeProject: r.project, composeService: r.service, composeWorkingDir: r.workingDir }),
  }));
  const own = new Set(classified.filter((c) => c.anchor && c.r.project).map((c) => c.r.project as string));
  const foreign: DockerRow[] = [];
  let tugra = 0;
  for (const c of classified) {
    if (c.reason !== null || (c.r.project && own.has(c.r.project))) tugra++;
    else foreign.push(c.r);
  }
  return { foreign, tugra };
}

function managedByOf(r: DockerRow, sw: SoftwareRef | null): "coolify" | "dokploy" | null {
  if (r.coolifyManaged || COOLIFY_NAME_RE.test(r.name) || sw?.id === "coolify") return "coolify";
  if (DOKPLOY_NAME_RE.test(r.name) || sw?.id === "dokploy") return "dokploy";
  return null;
}

export interface BuildReportInput {
  docker: DockerScan | null;
  host: HostScanResult;
  now: Date;
}

export function buildScanReport({ docker, host, now }: BuildReportInput): ScanReport {
  const dockerOk = docker && docker.available ? docker : null;
  const allRows = dockerOk?.rows ?? [];
  const { foreign, tugra } = splitTugra(allRows);

  const containers: ScanContainer[] = foreign.map((r) => {
    const sw = softwareForImage(r.image);
    const managedBy = managedByOf(r, sw);
    return {
      name: r.name,
      image: r.image,
      state: r.state,
      project: r.project,
      service: r.service,
      software: sw?.id ?? null,
      managedBy,
      ports: r.ports,
      adoptable: r.project === null && managedBy === null && r.image !== "",
    };
  });

  const projects = new Map<string, { services: Set<string>; running: number }>();
  for (const c of containers) {
    if (!c.project) continue;
    const p = projects.get(c.project) ?? { services: new Set<string>(), running: 0 };
    p.services.add(c.service ?? c.name);
    if (c.state === "running") p.running++;
    projects.set(c.project, p);
  }
  const composeProjects = [...projects.entries()]
    .map(([name, p]) => ({ name, services: p.services.size, running: p.running }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 150);

  const hostData = host.status === "ok" ? host.data : null;

  // ── software strip ──
  const acc = new Map<string, { ref: SoftwareRef; count: number; containers: string[] }>();
  const bump = (ref: SoftwareRef | null, by: number, container?: string) => {
    if (!ref) return;
    const e = acc.get(ref.id) ?? { ref, count: 0, containers: [] };
    e.count += by;
    if (container && e.containers.length < 30 && !e.containers.includes(container)) e.containers.push(container);
    acc.set(ref.id, e);
  };
  for (const c of containers) {
    // A platform's own container (software === managedBy) is counted once, not as the product and as its platform.
    if (c.software && c.software !== c.managedBy) bump(softwareById(c.software) ?? softwareForImage(c.image), 1, c.name);
    if (c.managedBy) bump(softwareById(c.managedBy), 1, c.name);
  }
  // A platform whose containers were already counted above is not added again from the host marker.
  const hostIds = new Map<string, number>();
  const hostAdd = (id: string | null | undefined, n: number) => {
    if (!id) return;
    hostIds.set(id, Math.max(hostIds.get(id) ?? 0, n));
  };
  if (hostData) {
    const siteCount = (server: "nginx" | "apache") => hostData.sites.filter((s) => s.server === server).length;
    const cloudpanelSites = hostData.sites.filter((s) => s.panel === "cloudpanel").length;
    for (const m of hostData.markers) {
      const id = MARKER_SOFTWARE[m];
      if (!id) continue;
      hostAdd(id, id === "nginx" || id === "apache" ? Math.max(1, siteCount(id)) : id === "cloudpanel" ? Math.max(1, cloudpanelSites) : 1);
    }
    const pm2Procs = hostData.pm2.reduce((n, u) => n + u.procs.length, 0);
    if (hostData.pm2.length > 0) hostAdd("pm2", Math.max(1, pm2Procs));
    let phpUnits = 0;
    for (const s of hostData.services) {
      const id = softwareForUnit(s.unit);
      if (id === "php") phpUnits++;
      else if (id === "nginx" || id === "apache") hostAdd(id, Math.max(1, siteCount(id)));
      else hostAdd(id, 1);
    }
    if (phpUnits > 0) hostAdd("php", phpUnits);
    if (cloudpanelSites > 0) hostAdd("cloudpanel", cloudpanelSites);
  }
  if (dockerOk) hostAdd("docker", Math.max(1, allRows.filter((r) => r.state === "running").length));
  for (const [id, n] of hostIds) {
    const ref = softwareById(id);
    const existing = acc.get(id);
    // Containers of the same product already counted: the host copy adds to them only when it is a separate install.
    if (existing && (id === "coolify" || id === "dokploy")) continue;
    bump(ref, n);
  }
  const software: ScanSoftware[] = [...acc.values()]
    .map((e) => ({ id: e.ref.id, label: e.ref.label, kind: e.ref.kind, logo: e.ref.logo, count: Math.max(1, e.count), containers: e.containers }))
    .sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, 80);

  // ── ports ──
  const published = new Map<number, string>();
  for (const r of allRows) for (const p of r.ports) if (!published.has(p)) published.set(p, r.name);
  const ports = (hostData?.ports ?? []).map((p) => ({ port: p.port, scope: p.scope, owner: published.get(p.port) ?? WELL_KNOWN_PORTS[p.port] ?? null }));

  return {
    v: 1,
    scannedAt: now.toISOString(),
    host: host.status === "ok" ? { status: "ok", reason: null } : { status: "unavailable", reason: host.reason },
    docker: {
      available: dockerOk !== null,
      total: allRows.length,
      running: allRows.filter((r) => r.state === "running").length,
      tugra,
      truncated: dockerOk?.truncated ?? false,
    },
    software,
    containers,
    composeProjects,
    pm2: hostData?.pm2 ?? [],
    sites: hostData?.sites ?? [],
    services: hostData?.services ?? [],
    ports,
  };
}
