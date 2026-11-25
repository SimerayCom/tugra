import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Role } from "@prisma/client";
import { agentSessionBaseUrl, type AgentPlanAdditions } from "@tugra/shared";
import { PrismaService } from "../prisma/prisma.service";
import { CryptoService } from "../crypto/crypto.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { MigratorService } from "../migrator/migrator.service";
import { LocalDockerSource } from "./sources/local-docker.source";
import { ImportSourceFactory } from "./sources/import-source.factory";
import { assertAllowedUrl } from "./sources/ssrf-guard";
import { ns, planImport } from "./import-planner";
import { buildPreflight } from "./preflight";
import { buildCoverage } from "./coverage";
import type { ForeignFleet, ImportPlan, PreflightHost } from "./foreign-fleet";
import type { ImportSource } from "./import-source";
import { isRemoteSourceKind, type ImportConnectAgentInput, type ImportConnectInput, type ImportTestInput, type ImportMappingPutInput, type ImportMappingResolveInput, type ImportPlanRequestInput, type ImportServicesPreviewInput, type RemoteSourceKind } from "./dto";
import { mapLimit } from "./sources/map-limit";
import { validateServiceChoices } from "./service-choices";
import { buildServicePreview, type ServicePreview } from "./service-preview";
import { ImportMappingService, type MappingSession } from "./import-mapping.service";
import type { ResolvedMapping } from "./import-mapping";
import { baseUrlHost, matchTugraServer, type MatchCandidate, type TugraMatch } from "./server-match";
import { classifyConnectFailure, suggestScopeLabel, type ConnectFailureCode } from "./connect-check";
import { HostMatchService, preflightMatchOf } from "../coolify-takeover/host-match.service";
import type { CoolifyHostInput } from "../coolify-takeover/host-match";

/** The plan as returned to a client: the (planHash-covered) plan plus the additive, hash-excluded mapping block. */
export type ImportPlanResponse = ImportPlan & { mapping?: { features: string[]; stored: unknown; storedVersion: number | null; scopeKey: string } };

/** The connection test's answer: a refusal (`ok: false`) carries a stable `code`; a success carries the one-line facts (null = the source cannot tell). */
export type ImportTestResult =
  | { ok: false; code: ConnectFailureCode; message: string }
  | { ok: true; team?: string; suggestedLabel?: string; apps: number | null; databases: number | null; services: number | null; sensitive: boolean | null };

/** The source-server ref of an item that lives on no named server (a Dokploy panel box); see `ns` in the planner. */
const UNKNOWN_HOST_REF = "_";

const SESSION_TTL_MS = 60 * 60_000; // 1h — long enough to review → apply, short enough to limit a stored token

/**
 * Importer orchestration — the DRY-RUN side: connect to a remote source (encrypted session) and preview an
 * import plan. Authorization is team-scoped (`apps:config`); the local-docker source additionally reuses the
 * migrator's per-server check. The remote API token is encrypted at rest and never returned.
 */
@Injectable()
export class ImporterService {
  private readonly logger = new Logger(ImporterService.name);

  constructor(
    private readonly migrator: MigratorService,
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly sources: ImportSourceFactory,
    // Trailing + optional so the mapping-free construction (and every pre-existing spec) is unchanged.
    private readonly mappings?: ImportMappingService,
    // Trailing + optional for the same reason: the agent transport's host matching (Coolify hub takeover, lane D).
    private readonly hostMatch?: HostMatchService,
  ) {}

  /** Verify a remote source is reachable with the given token, then store an encrypted, expiring session. */
  async connect(userId: string, input: ImportConnectInput): Promise<{ sessionId: string; expiresAt: Date }> {
    await this.access.requirePermission(userId, input.teamId, "apps:config");
    try {
      assertAllowedUrl(input.baseUrl); // scheme / credentials / blocked-IP-literal — a 400, not a 500
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : "invalid base URL");
    }
    // Opportunistic GC: expired sessions are dead weight (encrypted + unusable); purge them on connect.
    await this.prisma.importSession.deleteMany({ where: { expiresAt: { lt: new Date() } } });

    const source = this.sources.create(input.sourceKind, input.baseUrl, input.token);
    let ok: { ok: boolean; detail?: string };
    try {
      ok = await source.verify();
    } finally {
      await source.close();
    }
    if (!ok.ok) {
      throw new BadRequestException({
        statusCode: 400,
        message: `could not reach ${this.sources.label(input.sourceKind)}: ${ok.detail ?? "verification failed"}`,
        code: classifyConnectFailure(ok.detail),
      });
    }

    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    const session = await this.prisma.importSession.create({
      data: {
        teamId: input.teamId,
        actorId: userId,
        sourceKind: input.sourceKind,
        baseUrl: input.baseUrl,
        tokenEnc: this.crypto.encrypt(input.token), // never stored or returned in the clear
        ...(input.scopeLabel ? { scopeKey: input.scopeLabel } : {}),
        status: "active",
        expiresAt,
      },
    });
    await this.audit.log({ actor: userId, action: "import.connect", target: session.id, meta: { sourceKind: input.sourceKind, teamId: input.teamId, baseUrl: input.baseUrl } });
    return { sessionId: session.id, expiresAt };
  }

  /**
   * Connect Coolify through the agent on the Coolify host (no token, no URL). Needs: an owner/admin of the server's team, a server of
   * that team, and the server's own "Read this Coolify" opt-in (the consent for reading that host's Coolify database). The agent is
   * asked for one full read right now, so a bad host (agent offline, no Coolify, a session that is not read-only) fails here and not at
   * the first plan. The session stores no secret: its token column stays empty, and it holds only a short encrypted summary of the read.
   */
  async connectAgent(userId: string, input: ImportConnectAgentInput): Promise<{ sessionId: string; expiresAt: Date; read: NonNullable<AgentPlanAdditions["agentRead"]> }> {
    await this.access.requirePermission(userId, input.teamId, "apps:config");
    await this.access.requireRole(userId, input.teamId, [Role.OWNER, Role.ADMIN]);
    const server = await this.prisma.server.findUnique({ where: { id: input.serverId }, select: { id: true, teamId: true } });
    if (!server || server.teamId !== input.teamId) throw new NotFoundException("server not found");
    await this.requireAgentConsent(input.serverId, input.teamId);
    await this.prisma.importSession.deleteMany({ where: { expiresAt: { lt: new Date() } } });

    const source = this.sources.createAgent(input.serverId);
    let read: AgentPlanAdditions;
    try {
      const ok = await source.verify();
      if (!ok.ok) {
        throw new BadRequestException({ statusCode: 400, message: `could not read Coolify through the agent: ${ok.detail ?? "verification failed"}`, code: "agent_read_failed" });
      }
      read = (await source.agentPlan?.()) ?? {};
    } finally {
      await source.close();
    }
    if (!read.agentRead) throw new BadRequestException({ statusCode: 400, message: "the agent read returned nothing", code: "agent_read_failed" });

    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    const session = await this.prisma.importSession.create({
      data: {
        teamId: input.teamId,
        actorId: userId,
        sourceKind: "coolify",
        baseUrl: agentSessionBaseUrl(input.serverId),
        tokenEnc: "", // no token on this path (the rotation skips an empty value)
        transport: "agent",
        agentServerId: input.serverId,
        snapshotEnc: this.crypto.encrypt(JSON.stringify(read.agentRead)), // counts and versions only: no row, no value
        ...(input.scopeLabel ? { scopeKey: input.scopeLabel } : {}),
        status: "active",
        expiresAt,
      },
    });
    await this.audit.log({ actor: userId, action: "import.connect", target: session.id, meta: { sourceKind: "coolify", transport: "agent", teamId: input.teamId, serverId: input.serverId } });
    return { sessionId: session.id, expiresAt, read: read.agentRead };
  }

  /** The server's own opt-in must still stand: withdrawing it ends the agent session's reads at once. */
  private async requireAgentConsent(serverId: string, teamId: string): Promise<void> {
    const optIn = await this.prisma.coolifyInventory.findFirst({ where: { serverId, teamId }, select: { id: true } });
    if (!optIn) throw new ForbiddenException({ code: "not_enabled", message: "This server has not been opted in" });
  }

  /**
   * Check a token the moment it is pasted: reachable, which team it belongs to, how many apps/databases it sees and whether it
   * can read sensitive fields. Nothing is stored and no session is created. A refusal is a normal answer (`ok: false` with a
   * stable `code`), not an error, so the wizard can show only the note that fits the cause. Needs the same team permission as connect.
   */
  async test(userId: string, input: ImportTestInput): Promise<ImportTestResult> {
    await this.access.requirePermission(userId, input.teamId, "apps:config");
    try {
      assertAllowedUrl(input.baseUrl);
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : "invalid base URL");
    }
    const label = this.sources.label(input.sourceKind);
    const source = this.sources.create(input.sourceKind, input.baseUrl, input.token);
    try {
      const ok = await source.verify();
      if (!ok.ok) return { ok: false, code: classifyConnectFailure(ok.detail), message: `could not reach ${label}: ${ok.detail ?? "verification failed"}` };
      if (!source.probe) return { ok: true, apps: null, databases: null, services: null, sensitive: null };
      try {
        const p = await source.probe();
        return { ok: true, ...(p.team ? { team: p.team, suggestedLabel: suggestScopeLabel(p.team) } : {}), apps: p.apps, databases: p.databases, services: p.services, sensitive: p.sensitive };
      } catch (e) {
        const detail = e instanceof Error ? e.message : "verification failed";
        return { ok: false, code: classifyConnectFailure(detail), message: `could not reach ${label}: ${detail}` };
      }
    } finally {
      await source.close();
    }
  }

  async plan(userId: string, input: ImportPlanRequestInput): Promise<ImportPlanResponse> {
    if (input.sourceKind === "local-docker") {
      const source = new LocalDockerSource(this.migrator, userId, input.serverId);
      try {
        const fleet = await source.discover();
        const opts = { sourceKind: "local-docker", targetServerId: input.serverId };
        const coverage = buildCoverage(fleet, opts); // undefined for local-docker (adopts in place); kept for symmetry
        return { ...planImport(fleet, opts), preflight: { ...buildPreflight(fleet, opts), ...(coverage ? { coverage } : {}) } };
      } finally {
        await source.close();
      }
    }

    // remote source: resolve the owned, unexpired session → discover over the SSRF-safe client.
    const { source, session } = await this.openSession(userId, input.sessionId, input.sourceKind);
    try {
      const t0 = Date.now();
      const fleet = await source.discover();
      this.logger.log(
        `${input.sourceKind} discover: ${fleet.servers.length} servers, ${fleet.apps.length} apps, ${fleet.databases.length} dbs, ${fleet.services.length} services in ${Date.now() - t0}ms`,
      );
      await this.prisma.importSession.update({ where: { id: session.id }, data: { lastUsedAt: new Date() } });
      const opts = { sourceKind: input.sourceKind, ...(input.dbDataModes && Object.keys(input.dbDataModes).length ? { dbDataModes: input.dbDataModes } : {}) };
      const coverage = buildCoverage(fleet, opts);
      // The mapping block is additive and OUTSIDE planHash (computed from the plan alone, above).
      const mapping = this.mappings ? await this.mappings.planBlock(session) : undefined;
      const built = planImport(fleet, opts);
      const preflight = { ...buildPreflight(fleet, opts), ...(coverage ? { coverage } : {}) };
      const agentAdd = await source.agentPlan?.();
      const placement = await this.placementFacts(userId, session.baseUrl, fleet, preflight.hosts, built.items, source, session.agentServerId);
      return { ...built, preflight: { ...preflight, ...(agentAdd ?? {}), ...(placement.hosts ? { hosts: placement.hosts } : {}), ...(placement.panel ? { panel: placement.panel } : {}), ...(placement.sourceTeam ? { sourceTeam: placement.sourceTeam } : {}) }, ...(mapping ? { mapping } : {}) };
    } finally {
      await source.close();
    }
  }

  /**
   * For each source server, the registered Tugra server that is the same machine (by address, then host name), among the servers
   * the caller can write to. A verdict only: no source address leaves the hub. The Coolify control-plane box (its own address reads
   * `host.docker.internal`) and a Dokploy box with no server of its own are matched through the session's base URL host. The source
   * team's name rides along so the first step can default the target team. Best effort: a failure leaves the plan without matches.
   */
  private async placementFacts(
    userId: string,
    baseUrl: string,
    fleet: ForeignFleet,
    existing: readonly PreflightHost[] | undefined,
    items: ImportPlan["items"],
    source: ImportSource,
    agentServerId?: string | null,
  ): Promise<{ hosts?: PreflightHost[]; panel?: { tugra: TugraMatch }; sourceTeam?: string }> {
    try {
      const perms = await this.access.permissionsByTeam(userId);
      const teamIds = [...perms.entries()].filter(([, p]) => p.has("apps:config")).map(([id]) => id);
      const rows = teamIds.length
        ? await this.prisma.server.findMany({ where: { teamId: { in: teamIds } }, select: { id: true, name: true, teamId: true, status: true, publicIp: true, publicIpv6: true, hostname: true, reportedIps: true } })
        : [];
      const registered: MatchCandidate[] = rows;
      const panelHost = baseUrlHost(baseUrl);
      const addressOf = new Map(fleet.servers.map((s) => [s.ref, s.ip] as const));
      // Agent transport: the evidence ladder (identity confirms, an address is only probable). The token path keeps the address match.
      const ladder = agentServerId && this.hostMatch ? await this.ladderHosts(userId, fleet, agentServerId) : null;
      const hosts = (existing ?? []).map((h) => {
        const address = h.controlPlane ? panelHost : addressOf.get(h.ref);
        const m = registered.length ? matchTugraServer(address, registered) : null;
        // A move needs an agent on both ends: a source server is "covered" only when it matches a registered server whose agent is online.
        const online = (id: string | undefined): boolean => (id ? rows.find((r) => r.id === id)?.status === "ONLINE" : false);
        const v = ladder?.get(h.ref);
        if (!v) return m ? { ...h, tugra: m, agentOnline: online(m.serverId) } : { ...h, agentOnline: false };
        const best = v.candidates.find((c) => c.serverId === v.tugraServerId);
        const tugra = best && (v.status === "certain" || v.status === "probable")
          ? { serverId: best.serverId, name: best.name, teamId: best.teamId, via: m && m.serverId === best.serverId ? m.via : ("reported-ip" as const), confidence: v.status }
          : undefined;
        return { ...h, ...(tugra ? { tugra } : {}), match: preflightMatchOf(v), agentOnline: online(tugra?.serverId) };
      });
      // items that live on no named server (a Dokploy panel box) are matched through the panel's own address
      const unnamed = items.some((i) => i.itemRef.split(":")[1] === UNKNOWN_HOST_REF);
      const panelMatch = unnamed && registered.length ? matchTugraServer(panelHost, registered) : null;
      let sourceTeam: string | undefined;
      try {
        sourceTeam = await source.currentTeam?.();
      } catch {
        sourceTeam = undefined;
      }
      return { ...(hosts.length ? { hosts } : {}), ...(panelMatch ? { panel: { tugra: panelMatch } } : {}), ...(sourceTeam ? { sourceTeam } : {}) };
    } catch (e) {
      this.logger.warn(`placement match skipped: ${e instanceof Error ? e.message : "unknown"}`);
      return {};
    }
  }

  /** The ladder's verdict for every source server (by its Coolify uuid). The Coolify host itself is the machine the reading agent runs on. */
  private async ladderHosts(userId: string, fleet: ForeignFleet, agentServerId: string) {
    const inputs: CoolifyHostInput[] = fleet.servers.map((x) => ({ uuid: x.ref, address: x.ip ?? null, isLocal: x.controlPlane === true }));
    const verdicts = await this.hostMatch!.verdicts(userId, inputs, { localServerId: agentServerId });
    return new Map(verdicts.map((v) => [v.coolifyServerUuid, v] as const));
  }

  /** Authoritative mapping preview: re-discover + re-plan (no fleet caching — it may hold secrets), refuse a stale
   *  planHash, then resolve the document against the target server's team. Read-only. */
  async resolveMapping(userId: string, input: ImportMappingResolveInput): Promise<ResolvedMapping> {
    if (!this.mappings) throw new Error("mapping service unavailable");
    const { source, session } = await this.openSession(userId, input.sessionId, input.sourceKind);
    try {
      const fleet = await source.discover();
      const plan = planImport(fleet, { sourceKind: input.sourceKind, ...(input.dbDataModes && Object.keys(input.dbDataModes).length ? { dbDataModes: input.dbDataModes } : {}) });
      if (plan.planHash !== input.planHash) {
        throw new ConflictException("the plan changed since it was previewed — re-run the plan and review again");
      }
      const server = await this.prisma.server.findUnique({ where: { id: input.targetServerId }, select: { id: true, teamId: true } });
      if (!server) throw new NotFoundException("target server not found");
      return await this.mappings.resolve(userId, session, fleet, plan, server, input);
    } finally {
      await source.close();
    }
  }

  /** End a session now ("Start over"): the stored token stops being usable instead of waiting for its expiry. Owner only; idempotent. */
  async revokeSession(userId: string, sessionId: string): Promise<{ ok: true }> {
    const session = await this.prisma.importSession.findUnique({ where: { id: sessionId } });
    if (!session || !isRemoteSourceKind(session.sourceKind)) throw new NotFoundException("import session not found");
    if (session.actorId !== userId) throw new ForbiddenException("not your import session");
    if (session.status === "active") {
      await this.prisma.importSession.update({ where: { id: session.id }, data: { status: "revoked" } });
      await this.audit.log({ actor: userId, action: "import.session.revoke", target: session.id, meta: { sourceKind: session.sourceKind } });
    }
    return { ok: true };
  }

  /** The saved mapping profile for a session's source scope (`doc` is null when none is saved). */
  async getMapping(userId: string, sessionId: string) {
    if (!this.mappings) throw new Error("mapping service unavailable");
    const p = await this.mappings.getProfile(await this.requireSession(userId, sessionId));
    return { doc: p?.doc ?? null, version: p?.version ?? null, label: p?.label ?? null, lastAppliedAt: p?.lastAppliedAt ?? null };
  }

  async putMapping(userId: string, sessionId: string, input: ImportMappingPutInput) {
    if (!this.mappings) throw new Error("mapping service unavailable");
    return this.mappings.putProfile(userId, await this.requireSession(userId, sessionId), input);
  }

  async deleteMapping(userId: string, sessionId: string) {
    if (!this.mappings) throw new Error("mapping service unavailable");
    return this.mappings.deleteProfile(userId, await this.requireSession(userId, sessionId));
  }

  /** The owned, active, unexpired session (ownership + team authz + kind pin) WITHOUT building a source client —
   *  for the profile CRUD routes, which never talk to the source. */
  async requireSession(userId: string, sessionId: string, expectedKind?: RemoteSourceKind): Promise<MappingSession> {
    const session = await this.prisma.importSession.findUnique({ where: { id: sessionId } });
    const kind = session?.sourceKind;
    if (!session || !isRemoteSourceKind(kind) || (expectedKind && kind !== expectedKind)) {
      throw new NotFoundException("import session not found");
    }
    if (session.actorId !== userId) throw new ForbiddenException("not your import session");
    if (session.status !== "active" || session.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException("import session expired or revoked — reconnect");
    }
    await this.access.requirePermission(userId, session.teamId, "apps:config");
    return { id: session.id, teamId: session.teamId, sourceKind: kind, baseUrl: session.baseUrl, scopeKey: session.scopeKey ?? "" };
  }

  /**
   * Preview the SERVICE import: per discovered service, what the pure transform would do given the operator's choices and
   * (when the token can read them) the live variables and config files. Read-only; nothing is created. The response carries
   * variable NAMES, compose keys, volume keys, hostnames and fixed reasons only, never a value or a file's content. A choice
   * that names something the plan does not have is a 400 (the same validation the apply runs).
   */
  async previewServices(userId: string, input: ImportServicesPreviewInput): Promise<{ services: ServicePreview[] }> {
    const { source, session } = await this.openSession(userId, input.sessionId, input.sourceKind);
    try {
      const fleet = await source.discover();
      const plan = planImport(fleet, { sourceKind: session.sourceKind });
      const choices = validateServiceChoices(fleet, plan.items, input.choices);
      const services = [...fleet.services].sort((a, b) => (ns("service", a.serverRef, a.sourceRef) < ns("service", b.serverRef, b.sourceRef) ? -1 : 1));
      const cards = await mapLimit(services, 4, async (svc) => {
        let bundle;
        try {
          bundle = await source.fetchServiceBundle?.(svc.sourceRef);
        } catch {
          bundle = undefined; // a FIXED degrade: the card shows secretsAvailable:false, never the error text
        }
        return buildServicePreview(svc, choices[ns("service", svc.serverRef, svc.sourceRef)], bundle);
      });
      await this.prisma.importSession.update({ where: { id: session.id }, data: { lastUsedAt: new Date() } });
      return { services: cards };
    } finally {
      await source.close();
    }
  }

  /**
   * Resolve an owned, active, unexpired remote session into a live {@link ImportSource} (SSRF-safe client,
   * token decrypted in memory). Enforces session ownership + the session team's apps:config. Shared by the
   * plan path and the apply executor so session authz lives in exactly one place. The caller must close() it.
   *
   * `expectedKind` pins the session to the source the request is for, so a session minted for one source can
   * never be replayed through another source's plan/apply path. The returned `sourceKind` is the SESSION's —
   * callers key their op/plan on it rather than trusting the request body.
   */
  async openSession(
    userId: string,
    sessionId: string,
    expectedKind?: RemoteSourceKind,
  ): Promise<{ source: ImportSource; session: MappingSession & { sourceKind: RemoteSourceKind; agentServerId: string | null } }> {
    const session = await this.prisma.importSession.findUnique({ where: { id: sessionId } });
    const kind = session?.sourceKind;
    if (!session || !isRemoteSourceKind(kind) || (expectedKind && kind !== expectedKind)) {
      throw new NotFoundException("import session not found");
    }
    if (session.actorId !== userId) throw new ForbiddenException("not your import session");
    if (session.status !== "active" || session.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException("import session expired or revoked — reconnect");
    }
    await this.access.requirePermission(userId, session.teamId, "apps:config");
    const info = { id: session.id, teamId: session.teamId, sourceKind: kind, baseUrl: session.baseUrl, scopeKey: session.scopeKey ?? "", agentServerId: null as string | null };
    if (session.transport === "agent") {
      // Agent transport: no token. Still owner/admin of the team, and the server's opt-in must still stand (fail closed).
      if (kind !== "coolify" || !session.agentServerId) throw new NotFoundException("import session not found");
      await this.access.requireRole(userId, session.teamId, [Role.OWNER, Role.ADMIN]);
      await this.requireAgentConsent(session.agentServerId, session.teamId);
      return { source: this.sources.createAgent(session.agentServerId), session: { ...info, agentServerId: session.agentServerId } };
    }
    const token = this.crypto.decrypt(session.tokenEnc);
    return { source: this.sources.create(kind, session.baseUrl, token), session: info };
  }
}
