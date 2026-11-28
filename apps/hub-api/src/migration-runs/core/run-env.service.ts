import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../../audit/audit.service";
import { TeamAccessService } from "../../common/team-access.service";
import { isRemoteSourceKind } from "../../importer/dto";
import { ImporterService } from "../../importer/importer.service";
import type { RunEnvPort, RunNotification, RunSessionInfo, RunSinkPort } from "./run-ports";

/** Production {@link RunEnvPort}: teams, servers and import sessions, read through the existing services. */
@Injectable()
export class RunEnvService implements RunEnvPort {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly importer: ImporterService,
  ) {}

  teamIds(userId: string): Promise<string[]> {
    return this.access.teamIds(userId);
  }

  async standing(userId: string, teamId: string): Promise<{ member: boolean; appsConfig: boolean; databases: boolean }> {
    const perms = await this.access.membershipPermissions(userId, teamId);
    return { member: !!perms, appsConfig: !!perms?.has("apps:config"), databases: !!perms?.has("databases") };
  }

  server(serverId: string): Promise<{ id: string; name: string; teamId: string; status?: string; capabilities?: string[] } | null> {
    return this.prisma.server.findUnique({ where: { id: serverId }, select: { id: true, name: true, teamId: true, status: true, capabilities: true } });
  }

  async servers(ids: readonly string[]): Promise<Map<string, string>> {
    if (!ids.length) return new Map();
    const rows = await this.prisma.server.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, name: true } });
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  async session(userId: string, sessionId: string): Promise<RunSessionInfo | null> {
    const s = await this.prisma.importSession.findUnique({ where: { id: sessionId } });
    if (!s || s.actorId !== userId || !isRemoteSourceKind(s.sourceKind)) return null;
    let host = "";
    try {
      host = new URL(s.baseUrl).host.toLowerCase();
    } catch {
      host = "";
    }
    return {
      id: s.id,
      teamId: s.teamId,
      sourceKind: s.sourceKind,
      baseUrl: s.baseUrl,
      scopeKey: s.scopeKey,
      host,
      state: s.status !== "active" ? "revoked" : s.expiresAt.getTime() <= Date.now() ? "expired" : "active",
      expiresAt: s.expiresAt,
      sourceTeamRef: s.sourceTeamRef ?? null,
    };
  }

  async connectSession(userId: string, input: { teamId: string; sourceKind: "coolify" | "dokploy"; baseUrl: string; token: string; scopeLabel?: string }): Promise<{ sessionId: string; expiresAt: Date }> {
    return this.importer.connect(userId, input);
  }

  async renewSessions(sessionIds: readonly string[]): Promise<void> {
    await this.importer.renewSessions(sessionIds);
  }

  async connectAgentSession(userId: string, input: { teamId: string; serverId: string; sourceTeamRef?: string | null; scopeLabel?: string }): Promise<{ sessionId: string; expiresAt: Date }> {
    const r = await this.importer.connectAgent(userId, { sourceKind: "coolify", teamId: input.teamId, serverId: input.serverId, ...(input.scopeLabel ? { scopeLabel: input.scopeLabel } : {}), ...(input.sourceTeamRef ? { sourceTeamRef: input.sourceTeamRef } : {}) });
    return { sessionId: r.sessionId, expiresAt: r.expiresAt };
  }

  async endSession(userId: string, sessionId: string): Promise<void> {
    await this.importer.revokeSession(userId, sessionId).catch(() => undefined);
  }

  objectMigration(id: string): Promise<{ id: string; teamId: string; createdById: string } | null> {
    return this.prisma.objectMigration.findUnique({ where: { id }, select: { id: true, teamId: true, createdById: true } });
  }

  async campaignCancelled(teamId: string, label: string): Promise<boolean> {
    return (await this.prisma.migrationCampaign.count({ where: { teamId, label, status: "cancelled" } })) > 0;
  }
}

/**
 * Production {@link RunSinkPort}: `migration.run.*` entries in the audit log (ids and codes only). Team notifications
 * (Slack/e-mail channels) need new event types registered in the shared notification catalog, which is outside this lane:
 * until they exist the run's state changes are logged, and every one of them is also an event in the run's own log.
 */
@Injectable()
export class RunSinkService implements RunSinkPort {
  private readonly logger = new Logger("MigrationRun");

  constructor(private readonly auditLog: AuditService) {}

  async audit(entry: { actor: string; action: string; target: string; meta?: Record<string, unknown> }): Promise<void> {
    await this.auditLog.log(entry);
  }

  async notify(teamId: string, event: RunNotification): Promise<void> {
    this.logger.log(`run ${event.runId} (${event.mode}) ${event.kind}${event.stepKey ? ` at ${event.stepKey}` : ""}${event.code ? `: ${event.code}` : ""} [team ${teamId}]`);
  }
}
