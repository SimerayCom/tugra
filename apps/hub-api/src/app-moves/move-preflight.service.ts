import { Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Application, Server } from "@prisma/client";
import { AGENT_FEATURE_HUB_ORIGIN_ENV } from "@tugra/shared";
import { PrismaService } from "../prisma/prisma.service";
import { CryptoService } from "../crypto/crypto.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
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
  collectReservedPorts,
  declaredVolumes,
  hostMountPaths,
  parseExtraPorts,
  partBytesFromEnv,
  type MoveAppFacts,
  type MoveDbFacts,
  type MoveServerFacts,
  type PreflightFacts,
} from "./move-preflight";
import { adoptedCompose } from "../deploy/compose-script";
import { asArray } from "./move-types";
import type { MoveAckInput, MoveAppPreflightResult } from "./dto";

/**
 * Gathers everything the pure preflight assembly needs (DB facts + the two agents' read-only probes + the optional
 * link test) and assembles the verdict. Shared by the preflight endpoint, the start (which re-runs it server-side) and
 * the runner's PRECHECK (which re-runs it and compares it with the frozen plan).
 */
@Injectable()
export class MovePreflightService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly agentWs: AgentWsServer,
    private readonly crypto: CryptoService,
    private readonly config: ConfigService,
    private readonly transfers: PartTransferService,
  ) {}

  /** The instance-owner predicate the owner-override endpoint uses (InstanceOwnerGuard). */
  async isInstanceOwner(userId: string): Promise<boolean> {
    const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { isInstanceOwner: true } });
    return !!u?.isInstanceOwner;
  }

  /** The whole preflight for (app, target): gather DB facts, probe both agents, assemble. Also what `start` re-runs. */
  async computePreflight(app: Application, target: Server, acks: Partial<MoveAckInput>, userId: string, probeLink: boolean, excludeMoveId?: string): Promise<MoveAppPreflightResult> {
    const source = await this.prisma.server.findUnique({ where: { id: app.serverId } });
    if (!source) throw new NotFoundException("server not found");
    const facts = await this.gatherFacts(app, source, target, acks, userId, excludeMoveId);
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
      const r = await this.agentWs.sendCommand(srv.id, script, "backup", MOVE_TIMEOUTS.probe);
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
  async gatherFacts(app: Application, source: Server, target: Server, acks: Partial<MoveAckInput>, userId: string, excludeMoveId?: string): Promise<PreflightFacts> {
    const [previews, dbLinkCount, rolloutActive, deployActive, active, activeOnServer, latest, targetApps, targetDbs, archives, backupRows, recentDeploys, domainRows, serviceDomainCount, callerIsOwner, importActive] = await Promise.all([
      this.prisma.application.findMany({ where: { parentAppId: app.id }, select: { prNumber: true } }),
      this.prisma.appDatabaseLink.count({ where: { appId: app.id } }),
      this.prisma.rolloutTarget.count({ where: { kind: "app_deploy", resourceId: app.id, active: true } }),
      // Before the move exists (preflight, start) a QUEUED or RUNNING deploy blocks. The runner's PRECHECK re-run
      // (excludeMoveId set) is inside the live move, where claimNext already holds every queued non-move deploy until the
      // move ends: only one that is RUNNING right now is a conflict, a queued one simply waits (as the CHANGELOG says).
      this.prisma.deployment.count({
        where: { appId: app.id, status: excludeMoveId ? "RUNNING" : { in: ["QUEUED", "RUNNING"] }, OR: [{ idempotencyKey: null }, { NOT: { idempotencyKey: { startsWith: "move:" } } }] },
      }),
      this.prisma.appMove.findFirst({ where: { appId: app.id, phase: { notIn: APP_MOVE_TERMINAL }, ...(excludeMoveId ? { id: { not: excludeMoveId } } : {}) }, select: { id: true } }),
      this.prisma.appMove.findFirst({
        where: {
          appId: { not: app.id },
          phase: { notIn: APP_MOVE_TERMINAL },
          OR: [{ sourceServerId: { in: [source.id, target.id] } }, { targetServerId: { in: [source.id, target.id] } }],
        },
        select: { id: true },
      }),
      this.prisma.appMove.findFirst({ where: { appId: app.id, ...(excludeMoveId ? { id: { not: excludeMoveId } } : {}) }, orderBy: { createdAt: "desc" }, select: { phase: true, sourcePurgedAt: true, targetPurgedAt: true } }),
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
      this.importActiveFor(app.id),
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
    const reserved = collectReservedPorts(targetApps, targetDbs, app.id);

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
      adoptedCompose: adoptedCompose(app) !== null,
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
        importActive,
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

  /**
   * Is a migration import (BulkOperation kind "import") still working on this app? The app is one of the op's DONE app
   * tasks, the op was neither cancelled nor rolled back, and the op can still write: a task not yet finished
   * (PENDING / RUNNING / AWAITING_CUTOVER) or a live migration token (an untrusted source host may still stream volume data
   * into the app's destination volumes - data that would vanish, or 409, once the app is on another server).
   */
  private async importActiveFor(appId: string): Promise<boolean> {
    const rows = await this.prisma.bulkTask.findMany({
      where: { kind: "app", resourceType: "application", resourceId: appId, status: "DONE", operation: { kind: "import", cancelRequestedAt: null } },
      select: { operation: { select: { meta: true, migrationTokenHash: true, migrationTokenExpiresAt: true, tasks: { select: { status: true } } } } },
    });
    const now = Date.now();
    return rows.some(({ operation: op }) => {
      const meta = typeof op.meta === "object" && op.meta ? (op.meta as { rolledBackAt?: string }) : {};
      if (meta.rolledBackAt) return false;
      const unfinished = op.tasks.some((t) => t.status === "PENDING" || t.status === "RUNNING" || t.status === "AWAITING_CUTOVER");
      const tokenLive = !!op.migrationTokenHash && !!op.migrationTokenExpiresAt && op.migrationTokenExpiresAt.getTime() > now;
      return unfinished || tokenLive;
    });
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
}
