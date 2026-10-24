import { BadRequestException, Injectable } from "@nestjs/common";
import type { Application } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";
import { DatabasesService } from "../databases/databases.service";
import { hasNetworkOpt } from "../deploy/deploy-script";
import { linkRoute, linkRouteReasonText } from "./db-link";

/**
 * Database<->App links: attach a managed database to an app so its connection URI is auto-injected into
 * the app's runtime env at deploy time. This service owns link resolution (used by the deploy path) and,
 * in a later slice, link create/list/remove. v1 is node-local internal linking only — see db-link.ts.
 */
@Injectable()
export class AppDatabaseLinksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly databases: DatabasesService,
  ) {}

  /**
   * Env auto-injected from this app's database links, computed FRESH on every deploy (so a changed DB
   * host/port/password propagates without re-saving env). Each link contributes exactly one variable: its
   * connection URI under the link's `envVar`.
   *
   * A link whose key is already set in the app's own env is SKIPPED (the explicit value wins, so the link
   * is moot). Any other unresolvable link — database deleted, moved to another team/server, app no longer
   * eligible, or credentials unreadable — FAILS the deploy with a non-secret message, rather than silently
   * dropping the variable and booting the app without its DATABASE_URL.
   *
   * @param shadowedKeys env keys the app sets explicitly (these links are skipped).
   */
  async resolveLinkedEnv(app: Application, shadowedKeys: ReadonlySet<string>): Promise<Record<string, string>> {
    const out: Record<string, string> = Object.create(null) as Record<string, string>;
    // A preview is a throwaway clone; it never carries its own links, and failing a preview deploy over a
    // parent's link would be surprising. Nothing to resolve.
    if (app.isPreview) return out;

    const links = await this.prisma.appDatabaseLink.findMany({
      where: { appId: app.id },
      orderBy: { createdAt: "asc" },
      include: { database: true },
    });
    if (links.length === 0) return out;

    const appInfo = {
      clusterId: app.clusterId,
      source: app.source,
      serverId: app.serverId,
      hasCustomNetwork: hasNetworkOpt(app.dockerOptions),
    };
    for (const link of links) {
      if (shadowedKeys.has(link.envVar)) continue; // explicit app-env value wins — this link is moot
      const db = link.database;
      if (!db) throw new BadRequestException(`linked database for ${link.envVar} no longer exists — unlink it`);
      if (db.teamId !== app.teamId) throw new BadRequestException(`linked database for ${link.envVar} is not in this app's team — unlink it`);
      const route = linkRoute(appInfo, { serverId: db.serverId });
      if (route.route !== "internal") {
        throw new BadRequestException(`cannot inject ${link.envVar} from database "${db.name}": ${linkRouteReasonText(route.reason!)}`);
      }
      let uri: string;
      try {
        uri = this.databases.internalConnectionUri(db);
      } catch {
        throw new BadRequestException(`could not build the connection URI for ${link.envVar} (database "${db.name}")`);
      }
      out[link.envVar] = uri;
    }
    return out;
  }
}
