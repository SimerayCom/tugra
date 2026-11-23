import { gitSourcesUsableBy } from "../git-sources/source-scope";
import { ConflictException, Injectable, Logger, UnprocessableEntityException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import type { ForeignFleet, ImportPlan } from "./foreign-fleet";
import type { RiskAck } from "./import-executor.logic";
import {
  ImportMappingDocSchema,
  type ImportMappingDoc,
  type ResolvedMapping,
  type TargetSnapshot,
  blockingErrors,
  docHash,
  isEmptyDoc,
  normalizeBaseUrl,
  resolveMapping,
  unackedConflicts,
} from "./import-mapping";
import { hasServerMap, placementFor, placementTargets, serverRefOfItemRef } from "./server-map";

/** The slice of an import session the mapping profile is keyed by. */
export interface MappingSession {
  id: string;
  teamId: string;
  sourceKind: string;
  baseUrl: string;
  scopeKey: string;
}

/** The mapping-related fields of a remote apply request. */
export interface ApplyMappingInput {
  mapping?: ImportMappingDoc;
  mappingHash?: string;
  reconcile?: boolean;
  ignoreStoredMapping?: boolean;
  saveMapping?: boolean;
  /** Operator risk acks (the apply's `acks`): bound into the mappingHash and used by the resolver's runnable predicate. */
  acks?: readonly RiskAck[];
  /** Multi-host placement (source server ref to Tugra server id): per-item "already imported here" and the alias clash
   *  scan follow each item's own target, and a non-empty map binds the mappingHash. */
  serverMap?: Readonly<Record<string, string>>;
}

export interface StoredProfile {
  doc: ImportMappingDoc;
  version: number;
  label: string | null;
  lastAppliedAt: Date | null;
  mappingHash: string;
}

const FEATURES = ["mapping-v1"] as const;
const conflict = (code: string, message: string, extra: Record<string, unknown> = {}) => new ConflictException({ statusCode: 409, message, code, ...extra });

/**
 * The persisted, editable import mapping: one profile per (team, source kind, normalized base URL, scope label),
 * the target snapshot the resolver validates against, and the apply-time fail-closed gate. The profile key is
 * derived SERVER-SIDE from the import session (never client-supplied), so there is no cross-team id to guess.
 * A mapping carries names and placement only — never a secret.
 */
@Injectable()
export class ImportMappingService {
  private readonly logger = new Logger(ImportMappingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
  ) {}

  private keyOf(s: MappingSession) {
    return { teamId: s.teamId, sourceKind: s.sourceKind, baseUrl: normalizeBaseUrl(s.baseUrl), scopeKey: s.scopeKey };
  }

  /** The stored profile for a session's scope, or null (also null if the stored JSON no longer parses). */
  async getProfile(session: MappingSession): Promise<StoredProfile | null> {
    const row = await this.prisma.importMapping.findUnique({ where: { teamId_sourceKind_baseUrl_scopeKey: this.keyOf(session) } });
    if (!row) return null;
    const parsed = ImportMappingDocSchema.safeParse(row.mapping);
    if (!parsed.success) {
      this.logger.warn(`import mapping profile ${row.id} no longer parses — ignored`);
      return null;
    }
    return { doc: parsed.data, version: row.version, label: row.label, lastAppliedAt: row.lastAppliedAt, mappingHash: row.mappingHash };
  }

  /** The additive block `plan` returns: the feature flag (an old hub omits it) + the editable stored default. */
  async planBlock(session: MappingSession) {
    const p = await this.getProfile(session);
    return { features: [...FEATURES], stored: p?.doc ?? null, storedVersion: p?.version ?? null, scopeKey: session.scopeKey };
  }

  async putProfile(userId: string, session: MappingSession, input: { mapping: ImportMappingDoc; label?: string; expectedVersion?: number }) {
    const key = this.keyOf(session);
    const data = { mapping: input.mapping as unknown as Prisma.InputJsonValue, mappingHash: docHash(input.mapping), label: input.label ?? null };
    const existing = await this.prisma.importMapping.findUnique({ where: { teamId_sourceKind_baseUrl_scopeKey: key }, select: { id: true, version: true } });
    let version: number;
    if (!existing) {
      if (input.expectedVersion !== undefined) throw conflict("import.mapping_version_conflict", "the saved mapping changed since you loaded it — reload and review again");
      const row = await this.prisma.importMapping.create({ data: { ...key, ...data, createdById: userId } });
      version = row.version;
    } else {
      // Optimistic concurrency: with an expectedVersion the write only lands if nobody saved in between.
      const where = input.expectedVersion !== undefined ? { id: existing.id, version: input.expectedVersion } : { id: existing.id };
      const r = await this.prisma.importMapping.updateMany({ where, data: { ...data, version: { increment: 1 } } });
      if (r.count === 0) throw conflict("import.mapping_version_conflict", "the saved mapping changed since you loaded it — reload and review again");
      version = existing.version + 1;
      if (input.expectedVersion === undefined) {
        const fresh = await this.prisma.importMapping.findUnique({ where: { id: existing.id }, select: { version: true } });
        version = fresh?.version ?? version;
      }
    }
    await this.audit.log({
      actor: userId,
      action: "import.mapping.save",
      target: session.id,
      meta: { items: Object.keys(input.mapping.items).length, projects: Object.keys(input.mapping.projects).length, gitSources: Object.keys(input.mapping.gitSources).length, acks: input.mapping.acks.length, version },
    });
    return { ok: true as const, version, mappingHash: data.mappingHash };
  }

  async deleteProfile(userId: string, session: MappingSession) {
    const r = await this.prisma.importMapping.deleteMany({ where: this.keyOf(session) });
    await this.audit.log({ actor: userId, action: "import.mapping.delete", target: session.id, meta: { deleted: r.count } });
    return { ok: true as const, deleted: r.count > 0 };
  }

  // ── target snapshot ────────────────────────────────────────────────────────────────────────────────

  /**
   * Everything the resolver needs to know about the target team/server. `apps:config` on the server's team is
   * checked FIRST — the same gate as apply — so a caller without it can never probe which names exist there.
   * Every query is team-scoped.
   */
  async buildSnapshot(userId: string, server: { id: string; teamId: string }, itemRefs: string[], serverMap?: Readonly<Record<string, string>> | null): Promise<TargetSnapshot> {
    await this.access.requirePermission(userId, server.teamId, "apps:config");
    const teamId = server.teamId;
    // Multi-host: every placement target must be a server of this team (a foreign server id is refused before anything is read).
    const targets = new Set(placementTargets(server.id, hasServerMap(serverMap) ? serverMap : null));
    const others = [...targets].filter((t) => t !== server.id);
    if (others.length) {
      const rows = await this.prisma.server.findMany({ where: { id: { in: others }, teamId }, select: { id: true } });
      if (rows.length !== others.length) {
        throw new UnprocessableEntityException({ statusCode: 422, message: "a server in the serverMap is not a server of this team", code: "import.server_map_invalid" });
      }
    }
    const targetOf = (itemRef: string): string => placementFor(server.id, serverMap, serverRefOfItemRef(itemRef));
    const perms = await this.access.membershipPermissions(userId, teamId);
    const [projectRows, apps, dbs, gitRows, taskRows] = await Promise.all([
      this.prisma.project.findMany({ where: { teamId }, select: { id: true, name: true, isDefault: true, environments: { select: { id: true, name: true, isDefault: true } } } }),
      this.prisma.application.findMany({ where: { teamId }, select: { id: true, name: true, environmentId: true, serverId: true, containerAlias: true, networkAliases: true } }),
      this.prisma.database.findMany({ where: { teamId }, select: { id: true, name: true, environmentId: true } }),
      this.prisma.gitSource.findMany({ where: gitSourcesUsableBy(teamId), select: { appId: true } }),
      itemRefs.length
        ? this.prisma.bulkTask.findMany({ where: { itemRef: { in: itemRefs }, status: "DONE", resourceType: { in: ["application", "database"] } }, select: { itemRef: true, resourceId: true, resourceType: true, serverId: true } })
        : Promise.resolve([] as Array<{ itemRef: string | null; resourceId: string | null; resourceType: string | null; serverId: string }>),
    ]);

    const projects: TargetSnapshot["projects"] = new Map();
    const envIds = new Set<string>();
    let defaultEnvironmentId: string | null = null;
    for (const p of projectRows) {
      const envs = new Map<string, string>();
      for (const e of p.environments) {
        envs.set(e.name, e.id);
        envIds.add(e.id);
        if (p.isDefault && e.isDefault) defaultEnvironmentId = e.id;
      }
      projects.set(p.name, { id: p.id, envs });
    }

    const namesByEnv: TargetSnapshot["namesByEnv"] = new Map();
    const slot = (envId: string) => {
      let s = namesByEnv.get(envId);
      if (!s) namesByEnv.set(envId, (s = { apps: new Map(), dbs: new Map() }));
      return s;
    };
    const aliasesOnServer = new Set<string>();
    const appById = new Map(apps.map((a) => [a.id, a]));
    const dbById = new Map(dbs.map((d) => [d.id, d]));
    for (const a of apps) {
      slot(a.environmentId).apps.set(a.name.toLowerCase(), a.id);
      if (targets.has(a.serverId)) {
        // Multi-host: an alias taken on ANY placement target counts (conservative: it never misses a clash on the item's own target).
        if (a.containerAlias) aliasesOnServer.add(a.containerAlias.toLowerCase());
        for (const n of a.networkAliases ?? []) aliasesOnServer.add(n.toLowerCase());
      }
    }
    for (const d of dbs) slot(d.environmentId).dbs.set(d.name.toLowerCase(), d.id);

    // Already imported HERE / imported on ANOTHER server — only tasks whose resource is still live IN THIS TEAM
    // count (so another team's tasks never match and are never revealed).
    const existing: TargetSnapshot["existing"] = new Map();
    const elsewhereServers = new Map<string, string>();
    const elsewhereRefs = new Map<string, string>();
    for (const t of taskRows) {
      if (!t.itemRef || !t.resourceId) continue;
      const isDb = t.resourceType === "database";
      const liveApp = isDb ? undefined : appById.get(t.resourceId);
      const liveDb = isDb ? dbById.get(t.resourceId) : undefined;
      const live = liveApp ?? liveDb;
      if (!live) continue;
      if (t.serverId === targetOf(t.itemRef)) {
        existing.set(t.itemRef, {
          resourceType: isDb ? "database" : "application",
          resourceId: t.resourceId,
          name: live.name,
          environmentId: live.environmentId,
          containerAlias: liveApp?.containerAlias,
        });
      } else {
        elsewhereRefs.set(t.itemRef, t.serverId);
        elsewhereServers.set(t.serverId, t.serverId);
      }
    }
    const elsewhere: TargetSnapshot["elsewhere"] = new Map();
    if (elsewhereRefs.size) {
      const servers = await this.prisma.server.findMany({ where: { id: { in: [...elsewhereServers.keys()] }, teamId }, select: { id: true, name: true } });
      const nameOf = new Map(servers.map((s) => [s.id, s.name]));
      for (const [ref, sid] of elsewhereRefs) if (!existing.has(ref) && nameOf.has(sid)) elsewhere.set(ref, { serverId: sid, serverName: nameOf.get(sid)! });
    }

    return {
      teamId,
      serverId: server.id,
      canCreateProjects: !!perms?.has("projects"),
      projects,
      envIds,
      defaultEnvironmentId,
      namesByEnv,
      aliasesOnServer,
      existing,
      elsewhere,
      gitSourcesByAppId: new Set(gitRows.map((g) => g.appId).filter((x): x is string => !!x)),
    };
  }

  /** The authoritative resolve (no side effects): snapshot + pure overlay. */
  async resolve(
    userId: string,
    session: MappingSession,
    fleet: ForeignFleet,
    plan: ImportPlan,
    server: { id: string; teamId: string },
    input: { mapping: ImportMappingDoc; environmentId?: string; reconcile?: boolean; acks?: readonly RiskAck[]; serverMap?: Readonly<Record<string, string>> },
  ): Promise<ResolvedMapping> {
    const snap = await this.buildSnapshot(userId, server, plan.items.map((i) => i.itemRef), input.serverMap);
    return resolveMapping(fleet, plan, input.mapping, snap, {
      planHash: plan.planHash,
      targetServerId: server.id,
      environmentId: input.environmentId,
      reconcile: !!input.reconcile,
      acks: input.acks,
      ...(hasServerMap(input.serverMap) ? { serverMap: input.serverMap } : {}),
      session: { sourceKind: session.sourceKind, scopeKey: session.scopeKey },
    });
  }

  /**
   * The apply-time gate, run BEFORE anything is created. Returns the resolved mapping when a mapping was sent
   * (and passed every check), or undefined for the legacy no-mapping path. Fail closed:
   *  - a non-empty stored profile exists and the apply carries no mapping -> 409 `import.mapping_required`
   *    (unless `ignoreStoredMapping`);
   *  - the reviewed hash no longer matches -> 409 `import.mapping_changed`;
   *  - mapping keys the fresh plan no longer has -> 409 `import.mapping_orphans`;
   *  - ERROR conflicts or un-acknowledged ones -> 422 `import.mapping_invalid` (the full list).
   */
  async resolveForApply(
    userId: string,
    session: MappingSession,
    fleet: ForeignFleet,
    plan: ImportPlan,
    server: { id: string; teamId: string },
    input: ApplyMappingInput & { environmentId?: string },
  ): Promise<ResolvedMapping | undefined> {
    if (input.mapping === undefined) {
      if (input.ignoreStoredMapping) return undefined;
      const stored = await this.getProfile(session);
      if (stored && !isEmptyDoc(stored.doc)) {
        throw conflict("import.mapping_required", "a saved mapping exists for this source — review and send it with the apply (or choose to ignore the saved mapping)");
      }
      return undefined;
    }
    if (!input.mappingHash) throw conflict("import.mapping_changed", "the mapping changed since it was reviewed — resolve it again and review");
    const res = await this.resolve(userId, session, fleet, plan, server, { mapping: input.mapping, environmentId: input.environmentId, reconcile: input.reconcile, acks: input.acks, serverMap: input.serverMap });
    if (res.mappingHash !== input.mappingHash) throw conflict("import.mapping_changed", "the mapping, the source or the target changed since it was reviewed — resolve it again and review");
    if (res.orphans.length) throw conflict("import.mapping_orphans", "the mapping refers to items the source no longer has — remove them and review again", { orphans: res.orphans });
    const errors = blockingErrors(res);
    const unacked = unackedConflicts(res);
    if (errors.length || unacked.length) {
      throw new UnprocessableEntityException({ statusCode: 422, message: "the mapping has errors or unacknowledged conflicts", code: "import.mapping_invalid", conflicts: [...errors, ...unacked] });
    }
    return res;
  }

  /** After the op row exists: persist the applied mapping as the editable profile. A failure is logged and never
   *  fails the apply (the op is already created). */
  async markApplied(userId: string, session: MappingSession, opId: string, doc: ImportMappingDoc): Promise<void> {
    try {
      const key = this.keyOf(session);
      const json = doc as unknown as Prisma.InputJsonValue;
      await this.prisma.importMapping.upsert({
        where: { teamId_sourceKind_baseUrl_scopeKey: key },
        create: { ...key, mapping: json, mappingHash: docHash(doc), createdById: userId, lastAppliedOpId: opId, lastAppliedAt: new Date() },
        update: { mapping: json, mappingHash: docHash(doc), lastAppliedOpId: opId, lastAppliedAt: new Date(), version: { increment: 1 } },
      });
    } catch (e) {
      this.logger.warn(`could not save the import mapping profile for op ${opId}: ${e instanceof Error ? e.message : "failed"}`);
    }
  }
}
