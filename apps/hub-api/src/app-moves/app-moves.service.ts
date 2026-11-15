import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Application, AppMove, Server } from "@prisma/client";
import { AGENT_FEATURE_HUB_ORIGIN_ENV, APP_MOVE_TERMINAL_PHASES } from "@tugra/shared";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { CryptoService } from "../crypto/crypto.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { loadProjectCtx } from "../common/resource-project";
import { APP_MOVE_TERMINAL } from "../common/app-move-guard";
import {
  LINK_PROBE_BYTES,
  MOVE_TIMEOUTS,
  buildMoveCleanupScript,
  buildMoveLinkProbeFileScript,
  buildMoveProbeScript,
  newLinkProbeId,
  parseMovePart,
  parseMoveProbe,
  scrubMoveOutput,
  type MoveProbe,
} from "./app-move-scripts";
import { PartTransferService } from "./part-transfer.service";
import {
  assemblePreflight,
  declaredVolumes,
  hostMountPaths,
  partBytesFromEnv,
  type MoveAppFacts,
  type MoveDbFacts,
  type MoveServerFacts,
  type PreflightFacts,
} from "./move-preflight";
import type { AppMoveView, MoveAckInput, MoveAppPreflightInput, MoveAppPreflightResult } from "./dto";

const PROBE_TIMEOUT_MS = 600_000; // du on a large volume can take a while

export interface StoredVolume {
  name: string;
  dockerName: string;
  kind: "app" | "compose";
  sizeBytes: number | null;
  state: "PENDING" | "PACKED" | "TRANSFERRED" | "APPLIED" | "SKIPPED";
  parts: number;
  partsDone: number;
  bytesDone: number;
  entries: number | null;
  createdOnTarget: boolean;
  archiveOverwritten: boolean;
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

function parseExtraPorts(raw: unknown): { hostPort: number }[] {
  return asArray<{ hostPort?: unknown }>(raw).filter((p) => p && typeof p.hostPort === "number") as { hostPort: number }[];
}

@Injectable()
export class AppMovesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly agentWs: AgentWsServer,
    private readonly crypto: CryptoService,
    private readonly config: ConfigService,
    private readonly transfers: PartTransferService,
  ) {}

  // ───────────────────────────── authorization ─────────────────────────────

  /** Preflight / start / cancel / purge: apps:config AND apps:deploy AND backups (a move edits config, redeploys and
   *  copies volume data) plus the caller's per-resource scoping. */
  async authorizeMutate(userId: string, appId: string): Promise<Application> {
    const app = await this.prisma.application.findUnique({ where: { id: appId } });
    if (!app) throw new NotFoundException("application not found");
    await this.access.requirePermission(userId, app.teamId, "apps:config");
    await this.access.requirePermission(userId, app.teamId, "apps:deploy");
    await this.access.requirePermission(userId, app.teamId, "backups");
    await this.access.requireResourceAccess(userId, app.teamId, {
      resourceId: app.id,
      resolveProjectId: () => loadProjectCtx(this.prisma, app.environmentId).then((c) => c.projectId),
    });
    return app;
  }

  /** GET routes: any team member with access to the app (the writer-only fields are stripped in the view). */
  private async authorizeRead(userId: string, appId: string): Promise<{ app: Application; canWrite: boolean }> {
    const app = await this.prisma.application.findUnique({ where: { id: appId } });
    if (!app) throw new NotFoundException("application not found");
    if (!(await this.access.teamRole(userId, app.teamId))) throw new ForbiddenException("not a member of this team");
    await this.access.requireResourceAccess(userId, app.teamId, {
      resourceId: app.id,
      resolveProjectId: () => loadProjectCtx(this.prisma, app.environmentId).then((c) => c.projectId),
    });
    const perms = await this.access.membershipPermissions(userId, app.teamId);
    return { app, canWrite: perms?.has("apps:config") ?? false };
  }

  /** The target server must exist AND be in the app's team — a uniform 404 otherwise (no cross-team existence oracle). */
  async requireTarget(app: Application, targetServerId: string): Promise<Server> {
    const target = await this.prisma.server.findUnique({ where: { id: targetServerId } });
    if (!target || target.teamId !== app.teamId) throw new NotFoundException("server not found");
    return target;
  }

  /** The instance-owner predicate the owner-override endpoint uses (InstanceOwnerGuard). */
  async isInstanceOwner(userId: string): Promise<boolean> {
    const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { isInstanceOwner: true } });
    return !!u?.isInstanceOwner;
  }

  // ───────────────────────────── preflight ─────────────────────────────

  /** POST /apps/:id/move/preflight — read-only (it probes the agents but changes nothing). */
  async preflight(userId: string, appId: string, input: MoveAppPreflightInput): Promise<MoveAppPreflightResult> {
    const app = await this.authorizeMutate(userId, appId);
    const target = await this.requireTarget(app, input.targetServerId);
    return this.computePreflight(app, target, input.acknowledge, userId, input.probeLink);
  }

  /** The whole preflight for (app, target): gather DB facts, probe both agents, assemble. Also what `start` re-runs. */
  async computePreflight(app: Application, target: Server, acks: Partial<MoveAckInput>, userId: string, probeLink: boolean): Promise<MoveAppPreflightResult> {
    const source = await this.prisma.server.findUnique({ where: { id: app.serverId } });
    if (!source) throw new NotFoundException("server not found");
    const facts = await this.gatherFacts(app, source, target, acks, userId);
    const cheap = app.status === "NEW";
    if (!cheap) {
      const { vols } = declaredVolumes(facts.app);
      const names = vols.filter((v) => v.state === "move").map((v) => v.dockerName);
      const hostPaths = hostMountPaths(app.hostMounts);
      const [sp, tp] = await Promise.all([
        this.probe(source, { dockerVolumes: names }),
        this.probe(target, { dockerVolumes: names, hostPaths }),
      ]);
      facts.sourceProbe = sp.probe;
      facts.targetProbe = tp.probe;
      facts.probeFailed = { source: sp.failed, target: tp.failed };
      if (probeLink) facts.link = await this.probeLinkBetween(source, target);
    }
    return assemblePreflight(facts);
  }

  /** Run the read-only probe on one host. `failed` = it was attempted and gave no usable result (fail closed). */
  private async probe(srv: Server, input: { dockerVolumes: string[]; hostPaths?: string[] }): Promise<{ probe: MoveProbe | null; failed: boolean }> {
    if (!this.agentWs.isOnline(srv.id)) return { probe: null, failed: false }; // reported as agent_offline_*
    if (!srv.capabilities.includes("backup")) return { probe: null, failed: false }; // reported as capability_missing
    try {
      const names = input.dockerVolumes;
      const hostPaths = (input.hostPaths ?? []).filter((h) => !/[\u0000-\u001f]/.test(h));
      const script = buildMoveProbeScript({ dockerVolumes: names, hostPaths });
      const r = await this.agentWs.sendCommand(srv.id, script, "backup", PROBE_TIMEOUT_MS);
      if (r.exitCode !== 0) return { probe: null, failed: true };
      const parsed = parseMoveProbe(r.output, { dockerVolumes: names, hostPaths });
      return parsed ? { probe: parsed, failed: false } : { probe: null, failed: true };
    } catch {
      return { probe: null, failed: true };
    }
  }

  /**
   * The optional link test: ONE real 16 MiB part through the same relay + send/recv scripts a move uses, measuring
   * throughput. A failure is `link_probe_failed` with a scrubbed hint (hub origin unreachable from an agent, a proxy
   * body limit, ...). It cannot detect a fronting proxy that caps bodies ABOVE 16 MiB — lower MOVE_PART_MIB for that.
   * Both hosts delete the probe file afterwards, success or not. Returns null when a side cannot take part at all
   * (the preflight already reports that as its own blocker).
   */
  async probeLinkBetween(source: Server, target: Server): Promise<{ ok: boolean; mbps: number | null; hint?: string } | null> {
    const usable = (s: Server): boolean => this.agentWs.isOnline(s.id) && this.agentWs.agentSupports(s.id, AGENT_FEATURE_HUB_ORIGIN_ENV) && s.capabilities.includes("backup");
    if (!usable(source) || !usable(target)) return null;
    const probeId = newLinkProbeId();
    const cleanup = (srv: Server): Promise<unknown> => this.agentWs.sendCommand(srv.id, buildMoveCleanupScript(probeId), "backup", MOVE_TIMEOUTS.drop).catch(() => undefined);
    try {
      const made = await this.agentWs.sendCommand(source.id, buildMoveLinkProbeFileScript(probeId), "backup", MOVE_TIMEOUTS.stat);
      const part = made.exitCode === 0 ? parseMovePart(made.output) : null;
      if (!part || part.size !== LINK_PROBE_BYTES) return { ok: false, mbps: null, hint: "could not create the probe file on the source" };
      const started = Date.now();
      let r = await this.transfers.transfer({ moveId: probeId, idx: 0, part: 0, size: part.size, sha256: part.sha256, srcServerId: source.id, dstServerId: target.id, maxTimeSec: 120, timeoutMs: 150_000 });
      for (let i = 0; i < 5 && !r.ok && r.busy; i++) {
        await new Promise((res) => setTimeout(res, 1000 * (i + 1)));
        r = await this.transfers.transfer({ moveId: probeId, idx: 0, part: 0, size: part.size, sha256: part.sha256, srcServerId: source.id, dstServerId: target.id, maxTimeSec: 120, timeoutMs: 150_000 });
      }
      if (!r.ok) return { ok: false, mbps: null, hint: scrubMoveOutput(r.detail).slice(0, 300) };
      const seconds = Math.max((Date.now() - started) / 1000, 0.05);
      return { ok: true, mbps: Math.round(((part.size * 8) / 1e6 / seconds) * 10) / 10 };
    } catch (e) {
      return { ok: false, mbps: null, hint: scrubMoveOutput(e instanceof Error ? e.message : String(e)).slice(0, 300) };
    } finally {
      await Promise.all([cleanup(source), cleanup(target)]);
    }
  }

  private serverFacts(s: Server): MoveServerFacts {
    return {
      id: s.id,
      name: s.name,
      teamId: s.teamId,
      publicIp: s.publicIp,
      publicIpv6: s.publicIpv6,
      wildcardDomain: s.wildcardDomain,
      magicSuffix: s.magicSuffix,
      proxyBind: s.proxyBind,
      cpuCores: s.cpuCores,
      gpuInventory: s.gpuInventory,
      swarmRole: s.swarmRole,
      online: this.agentWs.isOnline(s.id),
      supportsOriginEnv: this.agentWs.agentSupports(s.id, AGENT_FEATURE_HUB_ORIGIN_ENV),
      grants: { deploy: s.capabilities.includes("deploy"), backup: s.capabilities.includes("backup") },
    };
  }

  /** Everything the pure assembly needs that comes from the database (and the agents' liveness). */
  async gatherFacts(app: Application, source: Server, target: Server, acks: Partial<MoveAckInput>, userId: string): Promise<PreflightFacts> {
    const [previews, dbLinkCount, rolloutActive, deployActive, active, activeOnServer, latest, targetApps, targetDbs, archives, backupRows, recentDeploys, domainRows, serviceDomainCount, callerIsOwner] = await Promise.all([
      this.prisma.application.findMany({ where: { parentAppId: app.id }, select: { prNumber: true } }),
      this.prisma.appDatabaseLink.count({ where: { appId: app.id } }),
      this.prisma.rolloutTarget.count({ where: { kind: "app_deploy", resourceId: app.id, active: true } }),
      this.prisma.deployment.count({
        where: { appId: app.id, status: { in: ["QUEUED", "RUNNING"] }, OR: [{ idempotencyKey: null }, { NOT: { idempotencyKey: { startsWith: "move:" } } }] },
      }),
      this.prisma.appMove.findFirst({ where: { appId: app.id, phase: { notIn: APP_MOVE_TERMINAL } }, select: { id: true } }),
      this.prisma.appMove.findFirst({
        where: {
          appId: { not: app.id },
          phase: { notIn: APP_MOVE_TERMINAL },
          OR: [{ sourceServerId: { in: [source.id, target.id] } }, { targetServerId: { in: [source.id, target.id] } }],
        },
        select: { id: true },
      }),
      this.prisma.appMove.findFirst({ where: { appId: app.id }, orderBy: { createdAt: "desc" }, select: { phase: true, sourcePurgedAt: true, targetPurgedAt: true } }),
      this.prisma.application.findMany({
        where: { serverId: target.id },
        select: { id: true, teamId: true, hostPort: true, portMappings: true, extraPorts: true, containerAlias: true, networkAliases: true, networks: true, domain: true },
      }),
      this.prisma.database.findMany({ where: { serverId: target.id }, select: { hostPort: true } }),
      this.prisma.appMove.findMany({ where: { appId: app.id, sourceServerId: target.id, phase: "COMPLETED", sourcePurgedAt: null }, select: { volumes: true } }),
      this.prisma.volumeBackup.findMany({ where: { appId: app.id, status: "SUCCESS" }, select: { destinationId: true } }),
      this.prisma.deployment.findMany({ where: { appId: app.id, status: "SUCCESS" }, orderBy: { createdAt: "desc" }, take: 5, select: { durationMs: true } }),
      this.prisma.domain.count({ where: { applicationId: app.id } }),
      this.prisma.appServiceDomain.count({ where: { applicationId: app.id } }),
      this.isInstanceOwner(userId),
    ]);

    // Other apps on the target: alias / network collisions and reserved ports.
    const others = targetApps.filter((a) => a.id !== app.id);
    const otherContainerAliases = new Set(others.map((a) => a.containerAlias).filter((x): x is string => !!x));
    const otherNetworkAliases = new Set(others.flatMap((a) => a.networkAliases));
    // (serverId, containerAlias) is unique, and an alias must not equal another app's network alias either way.
    const aliasConflict =
      (!!app.containerAlias && (otherContainerAliases.has(app.containerAlias) || otherNetworkAliases.has(app.containerAlias))) ||
      app.networkAliases.some((a) => otherContainerAliases.has(a));
    const networkAliasConflict =
      app.networkAliases.some((a) => otherNetworkAliases.has(a)) ||
      (app.networks.length > 0 && others.some((o) => o.teamId !== app.teamId && o.networks.some((n) => app.networks.includes(n))));
    const reserved = new Set<number>();
    for (const o of others) {
      if (typeof o.hostPort === "number") reserved.add(o.hostPort);
      for (const m of asArray<{ hostPort?: unknown }>(o.portMappings)) if (typeof m?.hostPort === "number") reserved.add(m.hostPort);
      for (const p of parseExtraPorts(o.extraPorts)) reserved.add(p.hostPort);
    }
    for (const d of targetDbs) if (typeof d.hostPort === "number") reserved.add(d.hostPort);

    // LOCAL backups: no destination, or a non-S3 destination.
    const destIds = [...new Set(backupRows.map((b) => b.destinationId).filter((x): x is string => !!x))];
    const dests = destIds.length ? await this.prisma.backupDestination.findMany({ where: { id: { in: destIds } }, select: { id: true, type: true } }) : [];
    const s3 = new Set(dests.filter((d) => d.type === "S3").map((d) => d.id));
    const localBackupCount = backupRows.filter((b) => !b.destinationId || !s3.has(b.destinationId)).length;

    const priorArchiveDockerNames = archives.flatMap((m) => asArray<{ dockerName?: unknown }>(m.volumes).map((v) => v.dockerName).filter((x): x is string => typeof x === "string"));

    const appFacts: MoveAppFacts = {
      id: app.id,
      name: app.name,
      teamId: app.teamId,
      source: app.source,
      serverId: app.serverId,
      status: app.status,
      clusterId: app.clusterId,
      isPreview: app.isPreview,
      dbNetwork: !!app.dbNetwork,
      hostPort: app.hostPort,
      extraPorts: parseExtraPorts(app.extraPorts),
      portMappings: asArray<{ hostPort?: unknown }>(app.portMappings).filter((m) => m && typeof m.hostPort === "number") as { hostPort: number }[],
      containerAlias: app.containerAlias,
      networkAliases: app.networkAliases,
      volumes: asArray<{ name: string; path: string }>(app.volumes).filter((v) => v && typeof v.name === "string"),
      composeFile: app.composeFile,
      configMounts: app.configMounts,
      isTemplate: !!app.templateSlug,
      hostMounts: app.hostMounts,
      gpus: app.gpus,
      cpusetCpus: app.cpusetCpus,
      allowPrivilegedDockerOptions: !!app.allowPrivilegedDockerOptions,
      domain: app.domain,
      domainKind: app.domainKind,
      certType: app.certType,
      tunnelExposed: app.tunnelExposed,
      hasCustomCert: !!app.certPem,
      pushToRegistry: !!app.pushToRegistry,
      buildServerId: app.buildServerId,
      hasCustomDomains: (app.extraDomains ?? []).length > 0 || serviceDomainCount > 0 || domainRows > 0,
      envKeysReferencingOldHost: this.envKeysReferencing(app, source),
      localBackupCount,
      recentDeployMs: recentDeploys.map((d) => d.durationMs).filter((x): x is number => typeof x === "number"),
    };
    return {
      app: appFacts,
      source: this.serverFacts(source),
      target: this.serverFacts(target),
      db: {
        previewPrs: previews.map((p) => p.prNumber).filter((n): n is number => typeof n === "number"),
        dbLinkCount,
        rolloutActive: rolloutActive > 0,
        deployActive: deployActive > 0,
        moveActive: !!active,
        moveActiveOnServer: !!activeOnServer,
        needsAttention: latest?.phase === "FAILED" && !latest.sourcePurgedAt && !latest.targetPurgedAt,
        aliasConflict,
        networkAliasConflict,
        targetReservedPorts: [...reserved],
        priorArchiveDockerNames,
        targetHasDomainApps: others.some((o) => !!o.domain),
        buildServerOnline: app.buildServerId && app.buildServerId !== app.serverId ? this.agentWs.isOnline(app.buildServerId) : null,
      } satisfies MoveDbFacts,
      callerIsOwner,
      acks,
      sourceProbe: null,
      targetProbe: null,
      probeFailed: { source: false, target: false },
      link: null,
      partBytes: partBytesFromEnv(String(this.config.get("MOVE_PART_MIB") ?? "")),
      hostPortRange: { min: Number(this.config.get("TUGRA_HOSTPORT_MIN") ?? 20000), max: Number(this.config.get("TUGRA_HOSTPORT_MAX") ?? 45000) },
      defaultMagicSuffix: String(this.config.get("MAGIC_DOMAIN_SUFFIX") ?? process.env.MAGIC_DOMAIN_SUFFIX ?? "sslip.io"),
    };
  }

  /** Env var NAMES whose value mentions the source server's address or the app's magic domain. Values never leave. */
  private envKeysReferencing(app: Application, source: Server): string[] {
    let env: Record<string, string> = {};
    try {
      env = app.envEnc ? (JSON.parse(this.crypto.decrypt(app.envEnc)) as Record<string, string>) : ((app.env as Record<string, string>) ?? {});
    } catch {
      return [];
    }
    const needles = [source.publicIp, source.publicIpv6, app.domainKind === "magic" ? app.domain : null].filter((x): x is string => !!x);
    if (!needles.length) return [];
    return Object.entries(env)
      .filter(([, v]) => typeof v === "string" && needles.some((n) => v.includes(n)))
      .map(([k]) => k)
      .sort();
  }

  // ───────────────────────────── views ─────────────────────────────

  async list(userId: string, appId: string, opts: { active?: boolean; limit?: number } = {}): Promise<AppMoveView[]> {
    const { canWrite } = await this.authorizeRead(userId, appId);
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const rows = await this.prisma.appMove.findMany({
      where: { appId, ...(opts.active ? { phase: { notIn: APP_MOVE_TERMINAL } } : {}) },
      orderBy: { createdAt: "desc" },
      take: opts.active ? 1 : limit,
    });
    return rows.map((m) => this.toView(m, canWrite));
  }

  async get(userId: string, appId: string, moveId: string): Promise<AppMoveView> {
    const { canWrite } = await this.authorizeRead(userId, appId);
    const m = await this.prisma.appMove.findFirst({ where: { id: moveId, appId } });
    if (!m) throw new NotFoundException("move not found");
    return this.toView(m, canWrite);
  }

  /** The row → the API view. `plan`, `acks` and `logTail` only for writers; the secret-free `snapshotBefore` never. */
  toView(m: AppMove, canWrite: boolean): AppMoveView {
    const vols = asArray<StoredVolume>(m.volumes);
    const moving = vols.filter((v) => v.state !== "SKIPPED");
    const bytesTotal = moving.reduce((a, v) => a + (v.sizeBytes ?? 0), 0);
    const bytesDone = moving.reduce((a, v) => a + (v.bytesDone ?? 0), 0);
    const firstOpen = moving.findIndex((v) => v.state !== "APPLIED");
    const pastCutover = ["DEPLOYING", "FINALIZING", "COMPLETED", "ROLLING_BACK", "ROLLED_BACK", "FAILED"].includes(m.phase);
    const terminal = (APP_MOVE_TERMINAL_PHASES as readonly string[]).includes(m.phase);
    return {
      id: m.id,
      appId: m.appId,
      appName: m.appName,
      phase: m.phase,
      prevStatus: m.prevStatus,
      sourceServerId: m.sourceServerId,
      targetServerId: m.targetServerId,
      volumes: vols.map((v) => ({ name: v.name, state: v.state, sizeBytes: v.sizeBytes ?? null, parts: v.parts ?? 0, partsDone: v.partsDone ?? 0, bytesDone: v.bytesDone ?? 0 })),
      progress: { volumeIndex: firstOpen === -1 ? moving.length : firstOpen, volumeCount: moving.length, bytesDone, bytesTotal },
      warnings: asArray<{ code: string; details?: Record<string, unknown> }>(m.warnings),
      failureReason: m.failureReason,
      failurePhase: m.failurePhase,
      deploymentId: m.deploymentId,
      cutoverAt: m.cutoverAt?.toISOString() ?? null,
      finishedAt: m.finishedAt?.toISOString() ?? null,
      archiveUntil: m.archiveUntil?.toISOString() ?? null,
      sourcePurgedAt: m.sourcePurgedAt?.toISOString() ?? null,
      createdAt: m.createdAt.toISOString(),
      canCancel: !terminal && !pastCutover && !m.cancelRequested,
      needsAttention: m.phase === "FAILED" && !m.sourcePurgedAt && !m.targetPurgedAt,
      plan: canWrite ? ((m.plan as Record<string, unknown>) ?? null) : null,
      acks: canWrite ? ((m.acks as Record<string, boolean>) ?? null) : null,
      logTail: canWrite ? m.logTail : null,
    };
  }
}
