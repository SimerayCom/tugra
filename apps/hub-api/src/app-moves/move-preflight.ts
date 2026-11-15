/**
 * Pure assembly of the app-move preflight: DB facts + the two hosts' probe results in, a structured verdict out.
 * No I/O, no DI — the service gathers the facts (queries + probes) and this decides. The rule it never breaks:
 * an offline agent, a failed probe or an unparseable marker is a BLOCKER, never "assume OK".
 *
 * Blocker kinds: HARD (cannot be acknowledged) and ACK (the operator can accept the consequence; reported with
 * `ack: true` until `acknowledge.<ack>` is set). `ok` = no blocker left.
 */
import { APP_MOVE_ACK_BLOCKERS, type AppMoveAck, type AppMoveBlockerCode, type AppMoveWarningCode } from "@tugra/shared";
import { appVolumeName } from "../deploy/deploy-script";
import { composeVolumes } from "../deploy/compose-script";
import { magicDomain } from "../applications/magic-domain";
import {
  DOCKER_ROOT,
  MOVE_STAGING_ROOT,
  MOVE_TOOLS,
  isValidDockerName,
  probeHostPathKey,
  type MoveProbe,
} from "./app-move-scripts";
import { cpusetExceedsTarget, gpuNotReadyOnTarget, hasHostMounts, hasPrivilegedGrant } from "./move-target-fit";
import { rebaseSelfUrls } from "./rebase-self-urls";
import type { MoveAppPreflightResult } from "./dto";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

export const DEFAULT_PART_MIB = 256;
export const MIN_PART_MIB = 32;
export const MAX_PART_MIB = 1024;

/** `MOVE_PART_MIB` clamped to 32..1024 (default 256), as bytes. */
export function partBytesFromEnv(raw: string | undefined): number {
  const n = raw === undefined || raw === "" ? DEFAULT_PART_MIB : Number(raw);
  const mib = Number.isFinite(n) ? Math.min(MAX_PART_MIB, Math.max(MIN_PART_MIB, Math.floor(n))) : DEFAULT_PART_MIB;
  return mib * MiB;
}

export interface MoveAppFacts {
  id: string;
  name: string;
  teamId: string;
  source: "IMAGE" | "GIT" | "COMPOSE";
  serverId: string;
  status: "NEW" | "RUNNING" | "STOPPED" | "FAILED";
  clusterId: string | null;
  isPreview: boolean;
  dbNetwork: boolean;
  hostPort: number | null;
  extraPorts: { hostPort: number }[];
  portMappings: { hostPort: number }[];
  containerAlias: string | null;
  networkAliases: string[];
  volumes: { name: string; path: string }[];
  composeFile: string | null;
  configMounts: unknown;
  /** installConfig.templateSlug-derived: only template compose apps get their self-URLs rebased. */
  isTemplate: boolean;
  hostMounts: unknown;
  gpus: string | null;
  cpusetCpus: string | null;
  allowPrivilegedDockerOptions: boolean;
  domain: string | null;
  domainKind: string;
  certType: string;
  tunnelExposed: boolean;
  hasCustomCert: boolean;
  pushToRegistry: boolean;
  buildServerId: string | null;
  /** Any custom / extra / per-service domain, or a Tugra-managed Domain row: DNS has to follow the app. */
  hasCustomDomains: boolean;
  /** Env var NAMES whose decrypted value mentions the old server ip / magic host (values never leave the hub). */
  envKeysReferencingOldHost: string[];
  localBackupCount: number;
  /** durationMs of the last 5 SUCCESS deploys (newest first) for the downtime estimate. */
  recentDeployMs: number[];
}

export interface MoveServerFacts {
  id: string;
  name: string;
  teamId: string;
  publicIp: string | null;
  publicIpv6: string | null;
  wildcardDomain: string | null;
  magicSuffix: string | null;
  proxyBind: string;
  cpuCores: number | null;
  gpuInventory: unknown;
  swarmRole: string | null;
  online: boolean;
  supportsOriginEnv: boolean;
  /** Capabilities the hub has granted this server (deploy AND backup are both required). */
  grants: { deploy: boolean; backup: boolean };
}

export interface MoveDbFacts {
  previewPrs: number[];
  dbLinkCount: number;
  rolloutActive: boolean;
  deployActive: boolean;
  moveActive: boolean;
  moveActiveOnServer: boolean;
  needsAttention: boolean;
  aliasConflict: boolean;
  networkAliasConflict: boolean;
  /** Ports other apps' (hostPort / portMappings / extraPorts) and managed databases already reserve on the target. */
  targetReservedPorts: number[];
  /** docker volume names of unpurged COMPLETED moves of THIS app whose source was the target (archives we may overwrite). */
  priorArchiveDockerNames: string[];
  /** The target already runs apps with a domain (so a Tugra proxy is almost certainly there). */
  targetHasDomainApps: boolean;
  /** null = the app has no separate build server. */
  buildServerOnline: boolean | null;
}

export interface PreflightFacts {
  app: MoveAppFacts;
  source: MoveServerFacts;
  target: MoveServerFacts;
  db: MoveDbFacts;
  callerIsOwner: boolean;
  acks: Partial<Record<AppMoveAck, boolean>>;
  /** Parsed probe per side; null = that agent was offline or its probe output was unusable. */
  sourceProbe: MoveProbe | null;
  targetProbe: MoveProbe | null;
  /** Which sides a probe was attempted on but failed (offline is reported separately). */
  probeFailed: { source: boolean; target: boolean };
  link: { ok: boolean; mbps: number | null; hint?: string } | null;
  partBytes: number;
  hostPortRange: { min: number; max: number };
  defaultMagicSuffix: string;
}

interface Blocker {
  code: AppMoveBlockerCode;
  message: string;
  details?: Record<string, unknown>;
  ack?: boolean;
}

/** What the cutover will do to the app's domain on the target (shared with the runner so plan == action). */
export function deriveTargetDomain(
  app: Pick<MoveAppFacts, "name" | "domain" | "domainKind">,
  target: Pick<MoveServerFacts, "publicIp" | "publicIpv6" | "wildcardDomain" | "magicSuffix" | "proxyBind">,
  defaultMagicSuffix: string,
): { kind: string; from: string | null; to: string | null; dropped: boolean } {
  if (app.domainKind !== "magic") return { kind: app.domainKind, from: app.domain, to: app.domain, dropped: false };
  // A tunnel-only target without a wildcard cannot serve a box-IP magic domain (same rule as regenerateMagicForServer).
  if (target.proxyBind === "none" && !target.wildcardDomain) return { kind: "magic", from: app.domain, to: null, dropped: true };
  const label = (app.domain ?? "").split(".")[0] || undefined;
  const to = magicDomain({
    name: app.name,
    label,
    publicIp: target.publicIp,
    publicIpv6: target.publicIpv6,
    wildcardDomain: target.wildcardDomain,
    suffix: target.magicSuffix ?? defaultMagicSuffix,
  });
  return { kind: "magic", from: app.domain, to, dropped: to == null };
}

/** Absolute host paths of the app's bind mounts (malformed entries dropped). */
export function hostMountPaths(hostMounts: unknown): string[] {
  if (!Array.isArray(hostMounts)) return [];
  return hostMounts
    .map((m) => (m && typeof m === "object" ? (m as { hostPath?: unknown }).hostPath : null))
    .filter((p): p is string => typeof p === "string" && p.startsWith("/"));
}

/** The lowest free port in [min,max] not in `used`, or null. */
export function pickFreePort(used: Set<number>, min: number, max: number): number | null {
  for (let p = min; p <= max; p++) if (!used.has(p)) return p;
  return null;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** Downtime estimate in seconds (low = 0.6x, high = 1.8x of the nominal total). Pure. */
export function estimateDowntimeSec(opts: {
  volumeBytes: number[];
  linkMbps: number | null;
  recentDeployMs: number[];
  source: "IMAGE" | "GIT" | "COMPOSE";
  stop: boolean;
}): { low: number; high: number } {
  const effRate = opts.linkMbps && opts.linkMbps > 0 ? (opts.linkMbps * 1e6) / 8 : 20e6; // bytes/s
  let t = opts.stop ? 5 : 0;
  for (const b of opts.volumeBytes) t += b / 60e6 + b / effRate + b / 80e6;
  t += 10; // cutover
  const med = median(opts.recentDeployMs);
  t += med != null ? med / 1000 : opts.source === "IMAGE" ? 60 : 180;
  return { low: Math.max(1, Math.round(t * 0.6)), high: Math.max(2, Math.round(t * 1.8)) };
}

/** Sizing rule (spec 4.1): source staging, and target staging/docker-root with the same-device doubling. */
export function diskVerdict(opts: {
  totalBytes: number;
  sourceStagingFreeBytes: number | null;
  targetStagingFreeBytes: number | null;
  targetDockerFreeBytes: number | null;
  targetSameDevice: boolean;
}): { ok: boolean; unknown: boolean; details: Record<string, number | boolean | null> } {
  const B = opts.totalBytes;
  const details = { totalBytes: B, sourceStagingFreeBytes: opts.sourceStagingFreeBytes, targetStagingFreeBytes: opts.targetStagingFreeBytes, targetDockerFreeBytes: opts.targetDockerFreeBytes, targetSameDevice: opts.targetSameDevice };
  if (B <= 0) return { ok: true, unknown: false, details };
  const srcNeed = 1.02 * B + 512 * MiB;
  if (opts.sourceStagingFreeBytes == null || opts.targetStagingFreeBytes == null || opts.targetDockerFreeBytes == null) return { ok: false, unknown: true, details };
  let ok = opts.sourceStagingFreeBytes >= srcNeed;
  if (opts.targetSameDevice) ok = ok && opts.targetStagingFreeBytes >= 2.05 * B + GiB;
  else ok = ok && opts.targetStagingFreeBytes >= 1.02 * B + 512 * MiB && opts.targetDockerFreeBytes >= 1.05 * B + 512 * MiB;
  return { ok, unknown: false, details };
}

export interface PlannedVolume {
  name: string;
  dockerName: string;
  kind: "app" | "compose";
  sizeBytes: number | null;
  state: "move" | "absent_skip" | "external_skip";
}

/** The volumes the app declares: Tugra-owned app volumes + Tugra-owned compose volumes (tugra_<id>_<key>). A compose
 *  `external:`/`name:` volume is NOT transferred (external_skip) and needs the externalVolumes acknowledgement. */
export function declaredVolumes(app: Pick<MoveAppFacts, "id" | "source" | "volumes" | "composeFile">): { vols: PlannedVolume[]; hasExternal: boolean } {
  const vols: PlannedVolume[] = [];
  let hasExternal = false;
  for (const v of app.volumes ?? []) {
    vols.push({ name: v.name, dockerName: appVolumeName(app, v.name), kind: "app", sizeBytes: null, state: "move" });
  }
  if (app.source === "COMPOSE") {
    for (const cv of composeVolumes(app)) {
      if (cv.external || !cv.browsable) {
        hasExternal = true;
        vols.push({ name: cv.key, dockerName: cv.dockerName, kind: "compose", sizeBytes: null, state: "external_skip" });
      } else {
        vols.push({ name: cv.key, dockerName: cv.dockerName, kind: "compose", sizeBytes: null, state: "move" });
      }
    }
  }
  return { vols, hasExternal };
}

export function assemblePreflight(f: PreflightFacts): MoveAppPreflightResult {
  const { app, source, target, db } = f;
  const cheap = app.status === "NEW";
  const blockers: Blocker[] = [];
  const warnings: { code: AppMoveWarningCode; details?: Record<string, unknown> }[] = [];
  const requiredAcks = new Set<AppMoveAck>();

  const hard = (code: AppMoveBlockerCode, message: string, details?: Record<string, unknown>): void => {
    blockers.push({ code, message, ...(details ? { details } : {}) });
  };
  const needAck = (code: keyof typeof APP_MOVE_ACK_BLOCKERS, message: string, details?: Record<string, unknown>): void => {
    const ack = APP_MOVE_ACK_BLOCKERS[code];
    requiredAcks.add(ack);
    if (!f.acks[ack] && !blockers.some((b) => b.code === code)) blockers.push({ code, message, ack: true, ...(details ? { details } : {}) });
  };
  const warn = (code: AppMoveWarningCode, details?: Record<string, unknown>): void => {
    warnings.push({ code, ...(details ? { details } : {}) });
  };

  // ── identity / topology (DB facts; run for the cheap path too) ──
  if (source.id === target.id) hard("same_server", "The target is the server the app already runs on.");
  if (source.teamId !== target.teamId) hard("cross_team", "The target server belongs to another team.");
  if (app.isPreview) hard("app_is_preview", "A preview app cannot be moved; it follows its parent.");
  if (app.clusterId) hard("cluster_app", "Swarm/cluster apps cannot be moved with this tool.");
  if (target.swarmRole) hard("target_in_cluster", "The target server is a node of a cluster's swarm.");
  if (db.previewPrs.length) hard("previews_exist", "Delete the app's preview deployments first.", { prs: db.previewPrs });
  if (db.dbLinkCount > 0) hard("db_links_exist", "Unlink the app's managed databases first (their network routes are per-server).", { count: db.dbLinkCount });
  if (app.dbNetwork) hard("db_network", "Disable the database network first (it is node-local).");
  if (db.rolloutActive) hard("rollout_active", "A fleet rollout is touching this app.");
  if (db.deployActive) hard("deploy_active", "A deployment is queued or running; wait for it to finish.");
  if (db.moveActive) hard("move_active", "This app already has a move in progress.");
  if (db.moveActiveOnServer) hard("move_active_on_server", "Another move is using the source or target server.");
  if (db.needsAttention) hard("move_needs_attention", "The last move of this app failed and needs attention (purge or fix it first).");
  if (db.aliasConflict) hard("alias_conflict", "The app's container alias is already used by another app on the target.");
  if (db.networkAliasConflict) hard("network_alias_conflict", "A network alias or network name of the app collides on the target.");

  // ── volumes ──
  const { vols, hasExternal } = declaredVolumes(app);
  for (const v of vols) {
    if (!isValidDockerName(v.dockerName)) hard("bad_volume_name", "A volume name is not safe to hand to docker.", { volume: v.name });
  }
  if (hasExternal) needAck("external_volume", "Compose external/named volumes are not transferred; compose will create them empty on the target.");
  if (hasHostMounts(app.hostMounts)) {
    const missing = hostMountPaths(app.hostMounts).filter((h) => f.targetProbe?.hostPaths[probeHostPathKey(h)] === false);
    needAck("host_mounts", "Host bind-mount data is not transferred.", { count: (app.hostMounts as unknown[]).length, ...(missing.length ? { missingOnTarget: missing } : {}) });
  }

  // ── host-bound settings ──
  if (hasPrivilegedGrant(app)) {
    if (!f.callerIsOwner) hard("privileged_not_owner", "Only the instance owner can move an app that holds the host-privileged docker options grant.");
    else needAck("privileged_options", "The host-privileged docker options grant and the stored docker options are cleared on the target.");
  }
  if (gpuNotReadyOnTarget(app, target.gpuInventory)) needAck("gpus_unavailable", "The target is not ready for the app's GPU request; the GPU request is dropped.");
  if (cpusetExceedsTarget(app.cpusetCpus, target.cpuCores)) needAck("cpuset_exceeds", "The app's CPU pinning names a core the target does not have; it is reset.");

  // ── ports (DB-known reservations always; the live listening ports only when probed) ──
  const used = new Set<number>(db.targetReservedPorts);
  if (!cheap && f.targetProbe) for (const p of f.targetProbe.ports) used.add(p);
  const baked = [...app.extraPorts.map((p) => p.hostPort), ...app.portMappings.map((p) => p.hostPort)].filter((p): p is number => typeof p === "number");
  const clash = [...new Set(baked.filter((p) => used.has(p)))].sort((a, b) => a - b);
  if (clash.length) hard("ports_conflict", "Published ports of the app are already in use on the target.", { ports: clash });
  let hostPortTo: number | null = app.hostPort;
  if (app.hostPort != null && used.has(app.hostPort)) {
    hostPortTo = pickFreePort(new Set([...used, ...baked]), f.hostPortRange.min, f.hostPortRange.max);
    needAck("host_port_changed", "The app's host port is busy on the target; a new one is allocated.", { from: app.hostPort, to: hostPortTo });
  }

  // ── domain ──
  const dom = deriveTargetDomain(app, target, f.defaultMagicSuffix);
  const magicChanges = app.domainKind === "magic" && dom.from !== dom.to;
  if (magicChanges) {
    needAck("domain_changes", "The app's generated domain changes with the server address.", { from: dom.from, to: dom.to });
    warn("magic_domain_changes", { from: dom.from, to: dom.to });
  }
  const targetIp = target.publicIp ?? target.publicIpv6 ?? null;
  if (app.hasCustomDomains || app.domainKind === "custom") {
    needAck("domain_changes", "Your custom domain(s) must point at the target server after the move.");
    warn("dns_manual_repoint", { ip: targetIp });
    if (app.certType === "le-http") warn("tls_http01_gap");
  }

  // ── always-on informational warnings ──
  if (app.tunnelExposed) warn("tunnel_resync");
  if (app.hasCustomCert) warn("custom_cert_redelivered");
  if (app.localBackupCount > 0) warn("local_backups_stranded", { count: app.localBackupCount });
  if (app.envKeysReferencingOldHost.length) warn("env_may_reference_old_host", { keys: app.envKeysReferencingOldHost });
  if (app.isTemplate && app.source === "COMPOSE") {
    const r = rebaseSelfUrls(
      { composeFile: app.composeFile, configMounts: app.configMounts },
      { ip: source.publicIp, domain: dom.from },
      { ip: target.publicIp, domain: dom.to },
    );
    if (r.changed) warn("self_urls_rewritten");
  }
  if (app.domain && !db.targetHasDomainApps) warn("proxy_will_be_installed");

  // ── agent-side checks (skipped for a never-deployed app: nothing to stop, copy or run) ──
  let plannedVolumes: PlannedVolume[] = vols.map((v) => ({ ...v }));
  let totalBytes = 0;
  let sourceStagingFree: number | null = null;
  let targetFree: number | null = null;
  const linkPlan = f.link ? { ok: f.link.ok, mbps: f.link.mbps } : null;

  if (!cheap) {
    for (const [side, srv] of [["source", source], ["target", target]] as const) {
      if (!srv.online) hard(side === "source" ? "agent_offline_source" : "agent_offline_target", `The ${side} server's agent is offline.`, { serverId: srv.id });
    }
    for (const srv of [source, target]) {
      if (srv.online && !srv.supportsOriginEnv) {
        hard("agent_too_old", "The agent on this server is too old for app moves — update it first (Servers → Update agent). An agent that cannot self-update cleanly must be moved by hand once.", { serverId: srv.id });
      }
      for (const cap of ["deploy", "backup"] as const) {
        if (!srv.grants[cap]) hard("capability_missing", `The "${cap}" capability is not granted to this server.`, { subject: `${srv.id}:${cap}` });
      }
    }
    for (const [side, srv, probe, failed] of [
      ["source", source, f.sourceProbe, f.probeFailed.source],
      ["target", target, f.targetProbe, f.probeFailed.target],
    ] as const) {
      if (!srv.online) continue; // already reported as offline
      if (!probe) {
        if (failed) hard("probe_failed", `The ${side} server's preflight probe failed or returned unusable output.`, { serverId: srv.id });
        continue;
      }
      if (!probe.tools.curl) hard("no_curl", "curl is not installed on this server.", { serverId: srv.id });
      const missing = MOVE_TOOLS.filter((t) => t !== "curl" && t !== "helper" && !probe.tools[t]);
      if (missing.length) hard("no_tool", `Required tools are missing on this server: ${missing.join(", ")}.`, { serverId: srv.id, tools: missing });
    }

    // sizes + states from the source probe
    if (f.sourceProbe) {
      plannedVolumes = plannedVolumes.map((v) => {
        if (v.state !== "move") return v;
        const pv = f.sourceProbe!.vols[v.dockerName];
        if (!pv) return v;
        if (!pv.exists) {
          warn("source_volume_absent", { volume: v.name });
          return { ...v, state: "absent_skip" as const };
        }
        return { ...v, sizeBytes: pv.kb == null ? null : pv.kb * 1024 };
      });
      const unsized = plannedVolumes.filter((v) => v.state === "move" && v.sizeBytes == null).map((v) => v.name);
      if (unsized.length) hard("probe_failed", "Could not measure the size of a volume on the source.", { serverId: source.id, volumes: unsized });
      totalBytes = plannedVolumes.filter((v) => v.state === "move").reduce((a, v) => a + (v.sizeBytes ?? 0), 0);
    }

    // target volume collisions
    if (f.targetProbe) {
      const archives = new Set(db.priorArchiveDockerNames);
      for (const v of plannedVolumes) {
        if (v.state !== "move") continue;
        const tv = f.targetProbe.vols[v.dockerName];
        if (!tv?.exists) continue;
        if (archives.has(v.dockerName)) warn("archive_overwritten", { volume: v.name });
        else hard("target_volume_exists", "A docker volume with this name already exists on the target.", { volume: v.name });
      }
    }

    // disk
    const sdf = f.sourceProbe?.df[MOVE_STAGING_ROOT];
    const tStage = f.targetProbe?.df[MOVE_STAGING_ROOT];
    const tDock = f.targetProbe?.df[DOCKER_ROOT];
    sourceStagingFree = sdf?.availKb != null ? sdf.availKb * 1024 : null;
    targetFree = tStage?.availKb != null ? tStage.availKb * 1024 : null;
    if (f.sourceProbe && f.targetProbe) {
      const v = diskVerdict({
        totalBytes,
        sourceStagingFreeBytes: sourceStagingFree,
        targetStagingFreeBytes: targetFree,
        targetDockerFreeBytes: tDock?.availKb != null ? tDock.availKb * 1024 : null,
        targetSameDevice: !!tStage?.dev && !!tDock?.dev && tStage.dev === tDock.dev,
      });
      if (v.unknown) hard("probe_failed", "Could not read free disk space on the source/target.", { subject: "df" });
      else if (!v.ok) hard("disk_insufficient", "Not enough free disk space for the transfer.", v.details);
    }

    if (db.buildServerOnline === false) hard("build_server_offline", "The app's build server is offline.", { serverId: app.buildServerId });
    if (f.link && !f.link.ok) hard("link_probe_failed", "The link test between the two servers failed.", f.link.hint ? { hint: f.link.hint } : undefined);

    if (app.status === "STOPPED" || app.status === "FAILED") warn("stopped_app_started_briefly");
    if (app.source === "IMAGE") warn("image_may_differ");
    if (app.source === "GIT" && !app.pushToRegistry) warn("git_rebuild");
    if (totalBytes > 0) warn("xattrs_acl_not_preserved");
    warn("history_splits");
  }

  const moveBytes = plannedVolumes.filter((v) => v.state === "move").map((v) => v.sizeBytes ?? 0);
  const estimate = cheap
    ? { low: 0, high: 0 }
    : estimateDowntimeSec({ volumeBytes: moveBytes, linkMbps: f.link?.mbps ?? null, recentDeployMs: app.recentDeployMs, source: app.source, stop: app.status === "RUNNING" });
  if (!cheap) warn("downtime_estimate", { lowSec: estimate.low, highSec: estimate.high });
  const estimatedParts = moveBytes.reduce((a, b) => a + (b > 0 ? Math.ceil(b / f.partBytes) : 0), 0);

  return {
    ok: blockers.length === 0,
    blockers: blockers.map((b) => ({ ...b })),
    warnings: dedupeWarnings(warnings),
    requiredAcks: [...requiredAcks],
    plan: {
      cheap,
      volumes: cheap ? plannedVolumes.map((v) => ({ ...v, state: v.state === "external_skip" ? v.state : ("absent_skip" as const) })) : plannedVolumes,
      totalBytes,
      partBytes: f.partBytes,
      estimatedParts,
      sourceStagingFreeBytes: sourceStagingFree,
      targetFreeBytes: targetFree,
      estimatedDowntimeSec: estimate,
      domain: { kind: dom.kind, from: dom.from, to: dom.to },
      hostPort: { from: app.hostPort, to: hostPortTo },
      targetIp,
      link: linkPlan,
    },
  };
}

function dedupeWarnings<T extends { code: string; details?: Record<string, unknown> }>(ws: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const w of ws) {
    const k = `${w.code}:${JSON.stringify(w.details ?? {})}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(w);
  }
  return out;
}
