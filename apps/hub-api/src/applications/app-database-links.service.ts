import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { Application, Database } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService, canAccessResource } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";
import { CryptoService } from "../crypto/crypto.service";
import { DatabasesService } from "../databases/databases.service";
import { loadProjectCtx } from "../common/resource-project";
import { hasNetworkOpt } from "../deploy/deploy-script";
import { isLinkEnvKeyAllowed } from "../common/env-key";
import type { DbEngine } from "../databases/database-script";
import { linkRoute, linkRouteReasonText, defaultEnvVar, derivedEnvVar } from "./db-link";

/** One link as returned by the read API — NEVER the URI/host/password (those live only on the DB's own
 *  connection card + in the deploy env-file). A DB the caller can't access is a `restricted` placeholder. */
export interface DatabaseLinkView {
  linkId: string;
  envVar: string;
  restricted?: boolean;
  databaseId?: string;
  name?: string;
  engine?: string;
  serverId?: string;
  route?: "internal" | null;
  reason?: string;
  shadowedBy?: "app-env" | null;
  dbStatus?: string;
  createdAt?: string;
}

/**
 * Database<->App links: attach a managed database to an app so its connection URI is auto-injected into
 * the app's runtime env at deploy time (recomputed fresh each deploy). v1 is node-local (tugra-net)
 * internal linking only — eligibility lives in db-link.ts.
 */
@Injectable()
export class AppDatabaseLinksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly databases: DatabasesService,
    private readonly crypto: CryptoService,
  ) {}

  // ---- deploy-time resolution ----------------------------------------------

  /**
   * Env auto-injected from this app's database links, computed FRESH on every deploy. Each link
   * contributes one variable: its connection URI under the link's `envVar`. A link whose key the app
   * sets explicitly is SKIPPED (the explicit value wins); any other unresolvable link FAILS the deploy
   * with a non-secret message, rather than silently dropping the variable.
   */
  async resolveLinkedEnv(app: Application, shadowedKeys: ReadonlySet<string>): Promise<Record<string, string>> {
    const out: Record<string, string> = Object.create(null) as Record<string, string>;
    if (app.isPreview) return out; // a preview is a throwaway clone and carries no links of its own

    const links = await this.prisma.appDatabaseLink.findMany({
      where: { appId: app.id },
      orderBy: { createdAt: "asc" },
      include: { database: true },
    });
    if (links.length === 0) return out;

    const appInfo = this.routeApp(app);
    for (const link of links) {
      if (shadowedKeys.has(link.envVar)) continue; // explicit app-env value wins — this link is moot
      const db = link.database;
      if (!db) throw new BadRequestException(`linked database for ${link.envVar} no longer exists — unlink it`);
      if (db.teamId !== app.teamId) throw new BadRequestException(`linked database for ${link.envVar} is not in this app's team — unlink it`);
      const route = linkRoute(appInfo, { serverId: db.serverId });
      if (route.route !== "internal") {
        throw new BadRequestException(`cannot inject ${link.envVar} from database "${db.name}": ${linkRouteReasonText(route.reason!)}`);
      }
      try {
        out[link.envVar] = this.databases.internalConnectionUri(db);
      } catch {
        throw new BadRequestException(`could not build the connection URI for ${link.envVar} (database "${db.name}")`);
      }
    }
    return out;
  }

  // ---- read ----------------------------------------------------------------

  /** This app's links for the config card. No secrets; a DB the caller can't access is a placeholder. */
  async list(userId: string, appId: string): Promise<DatabaseLinkView[]> {
    const app = await this.requireAppRead(userId, appId);
    const links = await this.prisma.appDatabaseLink.findMany({
      where: { appId },
      orderBy: { createdAt: "asc" },
      include: { database: true },
    });
    if (links.length === 0) return [];
    const membership = await this.access.membershipAccess(userId, app.teamId);
    const appKeys = this.appEnvKeys(app);
    const appInfo = this.routeApp(app);
    const views: DatabaseLinkView[] = [];
    for (const link of links) {
      const db = link.database;
      // A DB that is gone or in another team, or one a restricted member can't reach, is withheld.
      if (!db || db.teamId !== app.teamId) {
        views.push({ linkId: link.id, envVar: link.envVar, restricted: true });
        continue;
      }
      const projectId = await loadProjectCtx(this.prisma, db.environmentId).then((c) => c.projectId);
      if (!canAccessResource(membership, db.id, projectId)) {
        views.push({ linkId: link.id, envVar: link.envVar, restricted: true });
        continue;
      }
      const route = linkRoute(appInfo, { serverId: db.serverId });
      views.push({
        linkId: link.id,
        envVar: link.envVar,
        databaseId: db.id,
        name: db.name,
        engine: db.engine,
        serverId: db.serverId,
        route: route.route,
        reason: route.reason ? linkRouteReasonText(route.reason) : undefined,
        shadowedBy: appKeys.has(link.envVar) ? "app-env" : null,
        dbStatus: db.status,
        createdAt: link.createdAt.toISOString(),
      });
    }
    return views;
  }

  // ---- mutate --------------------------------------------------------------

  /**
   * Attach a database to an app. Requires apps:config + resource access on the app AND the `databases`
   * permission + resource access on the database (linking hands the app the DB's credentials, so it is
   * gated exactly like reading the password). The database must be in the app's team — a miss is 404, not
   * 403, so a caller can't probe another team's ids. Refuses ineligible topologies with a reason, never a
   * dead link. Auto-joins the managed-DB network, and (only with `adoptEnv`) removes a literal app-env key
   * the link would otherwise be shadowed by.
   */
  async create(
    userId: string,
    appId: string,
    input: { databaseId: string; envVar?: string; adoptEnv?: boolean },
  ): Promise<DatabaseLinkView> {
    const app = await this.requireAppConfig(userId, appId);
    if (app.isPreview) throw new BadRequestException("preview apps can't be linked directly");

    // Same-team lookup only — a cross-team / unknown id is 404 (no existence oracle).
    const db = await this.prisma.database.findFirst({ where: { id: input.databaseId, teamId: app.teamId } });
    if (!db) throw new NotFoundException("database not found");
    await this.access.requirePermission(userId, db.teamId, "databases");
    await this.requireDbAccess(userId, db);

    const route = linkRoute(this.routeApp(app), { serverId: db.serverId });
    if (route.route !== "internal") {
      throw new BadRequestException(`can't link this database: ${linkRouteReasonText(route.reason!)}`);
    }

    // Idempotent: the same DB is already linked -> return the existing link unchanged.
    const existing = await this.prisma.appDatabaseLink.findUnique({
      where: { appId_databaseId: { appId, databaseId: db.id } },
    });
    if (existing) return this.viewOf(app, db, existing, route.route);

    const envVar = this.chooseEnvVar(input.envVar, db, await this.takenEnvVars(appId));

    const adopt = input.adoptEnv === true && this.appEnvKeys(app).has(envVar);
    await this.prisma.$transaction(async (tx) => {
      if (!app.dbNetwork) await tx.application.update({ where: { id: appId }, data: { dbNetwork: true } });
      if (adopt) {
        const env = this.appEnv(app);
        delete env[envVar];
        await tx.application.update({ where: { id: appId }, data: { envEnc: this.crypto.encrypt(JSON.stringify(env)) } });
      }
      await tx.appDatabaseLink.create({ data: { appId, databaseId: db.id, envVar, createdBy: userId } });
    });

    if (!app.dbNetwork) await this.audit.log({ actor: userId, action: "app.db_network.update", target: appId, meta: { on: true } });
    if (adopt) await this.audit.log({ actor: userId, action: "app.env.update", target: appId, meta: { adoptedKey: envVar } });
    await this.audit.log({ actor: userId, action: "app.database_link.create", target: appId, meta: { databaseId: db.id, envVar, engine: db.engine } });
    await this.audit.log({ actor: userId, action: "database.link.attach", target: db.id, meta: { appId, envVar } });

    const created = await this.prisma.appDatabaseLink.findUniqueOrThrow({ where: { appId_databaseId: { appId, databaseId: db.id } } });
    // Re-read the app so shadowedBy reflects the post-adopt env (the adopted key is gone now).
    const freshApp = await this.loadApp(appId);
    return this.viewOf(freshApp, db, created, "internal");
  }

  /** Detach a database from an app. apps:config + resource access on the app; a foreign linkId is 404. */
  async remove(userId: string, appId: string, linkId: string): Promise<void> {
    await this.requireAppConfig(userId, appId);
    const link = await this.prisma.appDatabaseLink.findFirst({ where: { id: linkId, appId } });
    if (!link) throw new NotFoundException("link not found");
    await this.prisma.appDatabaseLink.delete({ where: { id: link.id } });
    await this.audit.log({ actor: userId, action: "app.database_link.delete", target: appId, meta: { databaseId: link.databaseId, envVar: link.envVar } });
    await this.audit.log({ actor: userId, action: "database.link.detach", target: link.databaseId, meta: { appId, envVar: link.envVar } });
  }

  // ---- helpers -------------------------------------------------------------

  private routeApp(app: Application) {
    return { clusterId: app.clusterId, source: app.source, serverId: app.serverId, hasCustomNetwork: hasNetworkOpt(app.dockerOptions) };
  }

  private chooseEnvVar(requested: string | undefined, db: Database, taken: Set<string>): string {
    if (requested !== undefined) {
      if (!isLinkEnvKeyAllowed(requested)) throw new BadRequestException(`invalid env var name: ${JSON.stringify(requested)}`);
      if (taken.has(requested)) throw new ConflictException(`env var ${requested} is already used by another link`);
      return requested;
    }
    const preferred = defaultEnvVar(db.engine as DbEngine);
    if (!taken.has(preferred)) return preferred;
    const derived = derivedEnvVar(db.name, db.engine as DbEngine);
    if (!taken.has(derived) && isLinkEnvKeyAllowed(derived)) return derived;
    throw new ConflictException(`env var ${preferred} is already linked — pass a distinct envVar`);
  }

  private async takenEnvVars(appId: string): Promise<Set<string>> {
    const rows = await this.prisma.appDatabaseLink.findMany({ where: { appId }, select: { envVar: true } });
    return new Set(rows.map((r) => r.envVar));
  }

  private viewOf(app: Application, db: Database, link: { id: string; envVar: string; createdAt: Date }, route: "internal" | null): DatabaseLinkView {
    return {
      linkId: link.id,
      envVar: link.envVar,
      databaseId: db.id,
      name: db.name,
      engine: db.engine,
      serverId: db.serverId,
      route,
      shadowedBy: this.appEnvKeys(app).has(link.envVar) ? "app-env" : null,
      dbStatus: db.status,
      createdAt: link.createdAt.toISOString(),
    };
  }

  private appEnv(app: Application): Record<string, string> {
    if (!app.envEnc) return {};
    try {
      return JSON.parse(this.crypto.decrypt(app.envEnc)) as Record<string, string>;
    } catch {
      return {};
    }
  }

  private appEnvKeys(app: Application): Set<string> {
    return new Set(Object.keys(this.appEnv(app)));
  }

  private async requireAppConfig(userId: string, appId: string): Promise<Application> {
    const app = await this.loadApp(appId);
    await this.access.requirePermission(userId, app.teamId, "apps:config");
    await this.access.requireResourceAccess(userId, app.teamId, {
      resourceId: app.id,
      resolveProjectId: () => loadProjectCtx(this.prisma, app.environmentId).then((c) => c.projectId),
    });
    return app;
  }

  private async requireAppRead(userId: string, appId: string): Promise<Application> {
    const app = await this.loadApp(appId);
    await this.access.requireResourceAccess(userId, app.teamId, {
      resourceId: app.id,
      resolveProjectId: () => loadProjectCtx(this.prisma, app.environmentId).then((c) => c.projectId),
    });
    return app;
  }

  private async requireDbAccess(userId: string, db: Database): Promise<void> {
    await this.access.requireResourceAccess(userId, db.teamId, {
      resourceId: db.id,
      resolveProjectId: () => loadProjectCtx(this.prisma, db.environmentId).then((c) => c.projectId),
    });
  }

  private async loadApp(appId: string): Promise<Application> {
    const app = await this.prisma.application.findUnique({ where: { id: appId } });
    if (!app) throw new NotFoundException("application not found");
    return app;
  }
}
