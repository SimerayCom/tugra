import { ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { ApplicationsService } from "../applications/applications.service";
import { ImporterService } from "./importer.service";
import { GitLinkResolverService, groupGitLinks, type GitLinkRow, type GitLinkStatus } from "./git-link-resolver.service";
import type { ImportGitLinksInput, ImportGitRelinkInput } from "./dto";

export interface GitLinksView {
  rows: GitLinkRow[];
  groups: Array<{ host: string; owner: string; apps: number; status: GitLinkStatus; sourceName?: string }>;
}

export type RelinkOutcome = "linked" | "already_linked" | "not_linked" | "invalid_choice" | "failed";
export interface RelinkResult {
  itemRef: string;
  name: string;
  outcome: RelinkOutcome;
  status: GitLinkStatus;
  sourceName?: string;
  /** For an ambiguous app with no (valid) pick yet: the sources that can see the repo (ids + names), so the UI can offer a choice. */
  candidates?: { id: string; name: string }[];
}

/**
 * The two operator-facing git-link flows around an import (the "connect a GitHub App once, link N apps" story):
 *  - `list`: BEFORE apply, resolve every git app of the connected source against the target team's sources;
 *  - `relink`: AFTER apply, re-resolve the created apps that are still unlinked and link the ones that are now
 *    covered (e.g. after the operator connected a GitHub App), honouring explicit picks for ambiguous rows.
 * No credential is ever read or returned: the resolver works with repo names and source names/ids only.
 */
@Injectable()
export class ImportGitLinksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly importer: ImporterService,
    private readonly resolver: GitLinkResolverService,
    private readonly apps: ApplicationsService,
  ) {}

  async list(userId: string, input: ImportGitLinksInput): Promise<GitLinksView> {
    const { source } = await this.importer.openSession(userId, input.sessionId); // session ownership + team authz
    try {
      const server = await this.prisma.server.findUnique({ where: { id: input.targetServerId } });
      if (!server) throw new NotFoundException("target server not found");
      await this.access.requirePermission(userId, server.teamId, "apps:config");
      const fleet = await source.discover();
      const map = await this.resolver.resolve(server.teamId, fleet.apps);
      // Stable order: the fleet's app order, so the UI list does not reshuffle between re-checks.
      const rows = fleet.apps.map((a) => map.get(a.sourceRef)).filter((r): r is GitLinkRow => !!r);
      return { rows, groups: groupGitLinks(rows) };
    } finally {
      await source.close();
    }
  }

  async relink(userId: string, opId: string, input: ImportGitRelinkInput): Promise<{ results: RelinkResult[]; linked: number }> {
    const op = await this.prisma.bulkOperation.findUnique({ where: { id: opId }, include: { tasks: { orderBy: { itemRef: "asc" } } } });
    if (!op || op.kind !== "import") throw new NotFoundException("import operation not found");
    if (op.actorId !== userId) throw new ForbiddenException("not your operation");
    const meta = typeof op.meta === "object" && op.meta ? (op.meta as { serverId?: string; rolledBackAt?: string }) : {};
    if (meta.rolledBackAt) throw new ConflictException("operation was rolled back");
    if (!meta.serverId) throw new ConflictException("operation has no target server");
    const server = await this.prisma.server.findUnique({ where: { id: meta.serverId } });
    if (!server) throw new ConflictException("target server not found");
    await this.access.requirePermission(userId, server.teamId, "apps:config");

    const done = op.tasks.filter((t) => t.kind === "app" && t.status === "DONE" && t.resourceType === "application" && !!t.resourceId && !!t.itemRef);
    const rowsDb = done.length
      ? await this.prisma.application.findMany({ where: { id: { in: done.map((t) => t.resourceId as string) }, teamId: server.teamId }, select: { id: true, name: true, gitUrl: true, gitSourceId: true } })
      : [];
    const appById = new Map(rowsDb.map((a) => [a.id, a]));

    const results: RelinkResult[] = [];
    const todo: Array<{ key: string; itemRef: string; name: string; url: string | null }> = [];
    for (const t of done) {
      const app = appById.get(t.resourceId as string);
      if (!app || !app.gitUrl) continue; // not a git app (or it no longer exists)
      if (app.gitSourceId) {
        results.push({ itemRef: t.itemRef as string, name: app.name, outcome: "already_linked", status: "linked" });
        continue;
      }
      todo.push({ key: app.id, itemRef: t.itemRef as string, name: app.name, url: app.gitUrl });
    }
    const resolved = await this.resolver.resolveRepos(server.teamId, todo);

    let linked = 0;
    for (const item of todo) {
      const row = resolved.get(item.key);
      if (!row) continue;
      let sourceId: string | undefined;
      let rewriteUrl: string | undefined;
      let sourceName = row.sourceName;
      const choice = input.choices?.[item.itemRef];
      if (row.status === "linked") {
        sourceId = row.sourceId;
        rewriteUrl = row.rewriteUrl;
      } else if (row.status === "ambiguous" && choice !== undefined) {
        const picked = row.candidates?.find((c) => c.id === choice);
        if (!picked) {
          results.push({ itemRef: item.itemRef, name: item.name, outcome: "invalid_choice", status: row.status, ...(row.candidates ? { candidates: row.candidates } : {}) });
          continue;
        }
        sourceId = picked.id;
        sourceName = picked.name;
      }
      if (!sourceId) {
        results.push({ itemRef: item.itemRef, name: item.name, outcome: "not_linked", status: row.status, ...(row.status === "ambiguous" && row.candidates ? { candidates: row.candidates } : {}) });
        continue;
      }
      try {
        // setSource enforces its own team + host checks. Only the link is written; an ssh GitHub URL a connected
        // installation covers is switched to its https twin in the same call (an App token never authenticates ssh).
        await this.apps.setSource(userId, item.key, { gitSourceId: sourceId, ...(rewriteUrl ? { gitUrl: rewriteUrl } : {}) });
        linked++;
        results.push({ itemRef: item.itemRef, name: item.name, outcome: "linked", status: "linked", ...(sourceName ? { sourceName } : {}) });
      } catch {
        results.push({ itemRef: item.itemRef, name: item.name, outcome: "failed", status: row.status });
      }
    }
    await this.audit.log({ actor: userId, action: "import.git_relink", target: opId, meta: { candidates: todo.length, linked, failed: results.filter((r) => r.outcome === "failed").length } });
    return { results, linked };
  }
}
