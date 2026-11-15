import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from "@nestjs/common";
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
import type { ImportPlan } from "./foreign-fleet";
import type { ImportSource } from "./import-source";
import { isRemoteSourceKind, type ImportConnectInput, type ImportMappingPutInput, type ImportMappingResolveInput, type ImportPlanRequestInput, type ImportServicesPreviewInput, type RemoteSourceKind } from "./dto";
import { mapLimit } from "./sources/map-limit";
import { validateServiceChoices } from "./service-choices";
import { buildServicePreview, type ServicePreview } from "./service-preview";
import { ImportMappingService, type MappingSession } from "./import-mapping.service";
import type { ResolvedMapping } from "./import-mapping";

/** The plan as returned to a client: the (planHash-covered) plan plus the additive, hash-excluded mapping block. */
export type ImportPlanResponse = ImportPlan & { mapping?: { features: string[]; stored: unknown; storedVersion: number | null; scopeKey: string } };

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
    if (!ok.ok) throw new BadRequestException(`could not reach ${this.sources.label(input.sourceKind)}: ${ok.detail ?? "verification failed"}`);

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
      return { ...planImport(fleet, opts), preflight: { ...buildPreflight(fleet, opts), ...(coverage ? { coverage } : {}) }, ...(mapping ? { mapping } : {}) };
    } finally {
      await source.close();
    }
  }

  /** Authoritative mapping preview: re-discover + re-plan (no fleet caching — it may hold secrets), refuse a stale
   *  planHash, then resolve the document against the target server's team. Read-only. */
  async resolveMapping(userId: string, input: ImportMappingResolveInput): Promise<ResolvedMapping> {
    if (!this.mappings) throw new Error("mapping service unavailable");
    const { source, session } = await this.openSession(userId, input.sessionId, input.sourceKind);
    try {
      const fleet = await source.discover();
      const plan = planImport(fleet, { sourceKind: input.sourceKind });
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
  ): Promise<{ source: ImportSource; session: MappingSession & { sourceKind: RemoteSourceKind } }> {
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
    const token = this.crypto.decrypt(session.tokenEnc);
    return {
      source: this.sources.create(kind, session.baseUrl, token),
      session: { id: session.id, teamId: session.teamId, sourceKind: kind, baseUrl: session.baseUrl, scopeKey: session.scopeKey ?? "" },
    };
  }
}
