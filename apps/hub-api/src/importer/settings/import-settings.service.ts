import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { TeamAccessService } from "../../common/team-access.service";
import { AuditService } from "../../audit/audit.service";
import { ImporterService } from "../importer.service";
import { NotificationsService } from "../../notifications/notifications.service";
import { DestinationsService } from "../../destinations/destinations.service";
import { SharedVariablesService } from "../../shared-variables/shared-variables.service";
import { ScheduledTasksService } from "../../scheduled-tasks/scheduled-tasks.service";
import { CleanupService } from "../../server-ops/cleanup.service";
import { TeamsService } from "../../teams/teams.service";
import { ApplicationsService } from "../../applications/applications.service";
import { DatabasesService } from "../../databases/databases.service";
import { channelName, providerConfig } from "./coolify-settings-map";
import { buildSettingsPlan, destinationKey, taskKey, type PlannedEntry, type SettingsPlan } from "./settings-plan";
import type { ImportSettingsApplyInput, ImportSettingsPreviewInput } from "./settings.dto";
import type { RawSettings, SettingsPreview, SettingsSection, TargetContext } from "./settings-types";

/** Outcome of one selected entry. Codes are fixed strings (the web translates them); no source text, no secret. */
export interface SettingsEntryResult {
  id: string;
  section: SettingsSection;
  status: "created" | "skipped" | "failed";
  code?: string;
  /** Tugra channels this entry created (so the review screen can offer "Send test message" per channel). */
  channels?: Array<{ id: string; name: string; skipped?: boolean }>;
  /** Shown ONCE: the data key of a new encrypted backup destination (it cannot be read again). */
  recoveryKey?: string;
  targetId?: string;
}

export interface SettingsApplyResult {
  results: SettingsEntryResult[];
  counts: { created: number; skipped: number; failed: number };
}

/** The status a thrown service error maps to, as a fixed code. */
interface ImportedRow {
  ref: string;
  kind: "application" | "database";
  id: string;
}

function failureCode(e: unknown): string {
  if (e instanceof ForbiddenException) return "forbidden";
  if (e instanceof ConflictException) return "conflict";
  if (e instanceof NotFoundException) return "not_found";
  if (e instanceof BadRequestException) return "invalid";
  if (e instanceof HttpException) return "failed";
  return "failed";
}

/**
 * Carry the SETTINGS of a connected source (Coolify) to the session's Tugra team. Everything goes through the same
 * services the product's own screens use, so each write enforces its own permission (`integrations`, `variables`,
 * `apps:config`, `servers:ops`, team admin) and its own validation; the session fixes the team. Secrets are read on the hub
 * at apply time and encrypted by those services; the preview and the result carry none (the one exception is a new
 * backup destination's recovery key, which Tugra shows exactly once by design).
 */
@Injectable()
export class ImportSettingsService {
  private readonly logger = new Logger(ImportSettingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly importer: ImporterService,
    private readonly notifications: NotificationsService,
    private readonly destinations: DestinationsService,
    private readonly sharedVars: SharedVariablesService,
    private readonly tasks: ScheduledTasksService,
    private readonly cleanup: CleanupService,
    private readonly teams: TeamsService,
    private readonly apps: ApplicationsService,
    private readonly databases: DatabasesService,
    private readonly access: TeamAccessService,
  ) {}

  async preview(userId: string, input: ImportSettingsPreviewInput): Promise<SettingsPreview> {
    const { plan } = await this.load(userId, input);
    return plan ? { supported: true, sections: plan.sections } : { supported: false, sections: [] };
  }

  async apply(userId: string, input: ImportSettingsApplyInput): Promise<SettingsApplyResult> {
    // Only the sections that hold a selected entry are read from the source (the full read is a few hundred paced GETs).
    const only = new Set(input.select.map(sectionOf));
    const { plan, teamId } = await this.load(userId, input, only);
    if (!plan) throw new BadRequestException("this source carries no settings");
    const blockedById = new Map(plan.sections.flatMap((s) => s.entries.map((e) => [e.id, e.blocked] as const)));
    const results: SettingsEntryResult[] = [];
    const usedServers = new Set<string>();
    for (const id of [...new Set(input.select)]) {
      const entry = plan.planned.get(id);
      if (!entry) {
        results.push({ id, section: sectionOf(id), status: "skipped", code: blockedById.get(id) ?? "unknown_entry" });
        continue;
      }
      try {
        results.push(await this.applyOne(userId, teamId, id, entry, input, usedServers));
      } catch (e) {
        this.logger.warn(`settings import: ${entry.section} entry failed (${failureCode(e)})`);
        results.push({ id, section: entry.section, status: "failed", code: failureCode(e) });
      }
    }
    const counts = { created: 0, skipped: 0, failed: 0 };
    for (const r of results) counts[r.status] += 1;
    const bySection: Record<string, number> = {};
    for (const r of results) if (r.status === "created") bySection[r.section] = (bySection[r.section] ?? 0) + 1;
    await this.audit.log({ actor: userId, action: "import.settings.apply", target: input.sessionId, meta: { ...counts, bySection, ...(input.opId ? { opId: input.opId } : {}) } });
    return { results, counts };
  }

  // ── reading ────────────────────────────────────────────────────────────────────────────────────

  /**
   * Open the session (ownership + `apps:config`), read the source's settings and plan them against the TARGET team: the team
   * the import landed in (taken from the operation's imported resources), else the `teamId` the caller names (checked for
   * `apps:config`), else the session's own team.
   */
  private async load(userId: string, input: ImportSettingsPreviewInput, only?: ReadonlySet<SettingsSection>): Promise<{ plan?: SettingsPlan; teamId: string }> {
    const { source, session } = await this.importer.openSession(userId, input.sessionId, input.sourceKind);
    try {
      if (!source.readSettings) return { teamId: session.teamId };
      const imp = input.opId ? await this.importedResources(userId, input.opId) : undefined;
      // The settings read belong to the Coolify team the owner picked at connect time: they go to the Tugra team that team was mapped
      // to (the client's team and the team of the first placed server are only a fallback where no mapping says). A team left out has none.
      const mapped = session.sourceTeamRef && session.teamMap ? session.teamMap[session.sourceTeamRef] : undefined;
      if (mapped === null) throw new BadRequestException({ statusCode: 400, code: "team_left_out", message: "that Coolify team was left out of the move, so its settings go nowhere" });
      const teamId = mapped ?? imp?.teamId ?? input.teamId ?? session.teamId;
      if (teamId !== session.teamId) await this.access.requirePermission(userId, teamId, "apps:config");
      const raw: RawSettings = await source.readSettings(only);
      const ctx = await this.targetContext(userId, teamId, imp ? (imp.teamId === teamId ? imp.rows : []) : undefined);
      return { plan: buildSettingsPlan(raw, ctx), teamId };
    } finally {
      await source.close();
    }
  }

  /** What the session's team already has (names/keys only), and which source resources the operation imported. */
  private async targetContext(userId: string, teamId: string, importedRows?: ImportedRow[]): Promise<TargetContext> {
    const [channels, vars, dests, members, invites, actor] = await Promise.all([
      this.prisma.notificationChannel.findMany({ where: { teamId }, select: { name: true } }),
      this.prisma.sharedVariable.findMany({ where: { teamId }, select: { key: true } }),
      this.prisma.backupDestination.findMany({ where: { teamId, type: "S3" }, select: { s3Endpoint: true, s3Bucket: true } }),
      this.prisma.membership.findMany({ where: { teamId }, select: { user: { select: { email: true } } } }),
      this.prisma.teamInvitation.findMany({ where: { teamId }, select: { email: true } }),
      this.prisma.user.findUnique({ where: { id: userId }, select: { email: true } }),
    ]);
    const imported = new Map((importedRows ?? []).map((r) => [r.ref, { kind: r.kind, id: r.id }] as const));
    const appIds = [...imported.values()].filter((v) => v.kind === "application").map((v) => v.id);
    const existingTasks = appIds.length ? await this.prisma.scheduledTask.findMany({ where: { appId: { in: appIds } }, select: { appId: true, name: true, command: true } }) : [];
    return {
      channelNames: new Set(channels.map((c) => c.name)),
      sharedVarKeys: new Set(vars.map((v) => v.key)),
      destinationKeys: new Set(dests.filter((d) => d.s3Endpoint && d.s3Bucket).map((d) => destinationKey(d.s3Endpoint as string, d.s3Bucket as string))),
      memberEmails: new Set(members.map((m) => m.user.email.toLowerCase())),
      pendingInviteEmails: new Set(invites.map((i) => i.email.toLowerCase())),
      actorEmail: actor?.email,
      imported,
      hasOperation: !!importedRows,
      taskKeys: new Set(existingTasks.map((t) => taskKey(t.appId, t.name, t.command))),
    };
  }

  /**
   * The Tugra apps/databases an import operation created, by source ref, and the team they sit in. The operation must be
   * the caller's own import. The team is the one most of those resources are in (an import lands in its target server's
   * team); only resources that really sit in that team are returned. `teamId` is undefined when nothing was created.
   */
  private async importedResources(userId: string, opId: string): Promise<{ teamId?: string; rows: ImportedRow[] }> {
    const op = await this.prisma.bulkOperation.findUnique({ where: { id: opId }, include: { tasks: { where: { status: "DONE", resourceType: { in: ["application", "database"] } }, select: { itemRef: true, resourceType: true, resourceId: true } } } });
    if (!op || op.kind !== "import") throw new NotFoundException("import operation not found");
    if (op.actorId !== userId) throw new ForbiddenException("not your operation");
    const rows: ImportedRow[] = [];
    for (const t of op.tasks) {
      const ref = (t.itemRef ?? "").split(":").slice(2).join(":");
      if (ref && t.resourceId && (t.resourceType === "application" || t.resourceType === "database")) rows.push({ ref, kind: t.resourceType, id: t.resourceId });
    }
    const [apps, dbs] = await Promise.all([
      this.prisma.application.findMany({ where: { id: { in: rows.filter((r) => r.kind === "application").map((r) => r.id) } }, select: { id: true, teamId: true } }),
      this.prisma.database.findMany({ where: { id: { in: rows.filter((r) => r.kind === "database").map((r) => r.id) } }, select: { id: true, teamId: true } }),
    ]);
    const teamOf = new Map([...apps, ...dbs].map((r) => [r.id, r.teamId] as const));
    const counts = new Map<string, number>();
    for (const tid of teamOf.values()) counts.set(tid, (counts.get(tid) ?? 0) + 1);
    const teamId = [...counts.entries()].sort((x, y) => y[1] - x[1])[0]?.[0];
    return { teamId, rows: rows.filter((r) => teamOf.get(r.id) === teamId) };
  }

  // ── applying ───────────────────────────────────────────────────────────────────────────────────

  private async applyOne(userId: string, teamId: string, id: string, p: PlannedEntry, input: ImportSettingsApplyInput, usedServers: Set<string>): Promise<SettingsEntryResult> {
    switch (p.section) {
      case "notifications": {
        const channels: NonNullable<SettingsEntryResult["channels"]> = [];
        const existing = new Set((await this.prisma.notificationChannel.findMany({ where: { teamId }, select: { name: true } })).map((c) => c.name));
        for (const g of p.groups) {
          const name = channelName(p.channel.kind, g);
          if (existing.has(name)) {
            channels.push({ id: "", name, skipped: true });
            continue;
          }
          try {
            const created = await this.notifications.create(userId, { name, type: p.channel.providerType, teamId, config: providerConfig(p.channel, g), eventTypes: g.tugraEvents });
            channels.push({ id: created.id, name });
            if (!p.channel.enabled) await this.notifications.update(userId, created.id, { enabled: false });
          } catch (e) {
            // Channels already created stay listed (with their test button): a retry then reports them as existing.
            if (channels.some((c) => !c.skipped)) return { id, section: "notifications", status: "failed", code: failureCode(e), channels };
            throw e;
          }
        }
        const made = channels.filter((c) => !c.skipped);
        return { id, section: "notifications", status: made.length ? "created" : "skipped", ...(made.length ? {} : { code: "exists" }), channels };
      }
      case "sharedVariables": {
        // Never overwrite: the plan already left out a key the team has, and this re-checks right before the write.
        if (await this.prisma.sharedVariable.findUnique({ where: { teamId_key: { teamId, key: p.variable.key } }, select: { id: true } })) return { id, section: "sharedVariables", status: "skipped", code: "exists" };
        const v = await this.sharedVars.upsert(userId, teamId, p.variable.key, p.variable.value as string);
        return { id, section: "sharedVariables", status: "created", targetId: v.id };
      }
      case "storages": {
        const creds = input.s3Credentials?.[id];
        if (!creds) return { id, section: "storages", status: "failed", code: "credentials_required" };
        const s = p.storage;
        const created = await this.destinations.create(userId, {
          teamId,
          name: s.name,
          type: "S3",
          s3Bucket: s.bucket,
          s3Endpoint: s.endpoint,
          ...(s.region ? { s3Region: s.region } : {}),
          s3AccessKey: creds.accessKey,
          s3SecretKey: creds.secretKey,
        });
        return { id, section: "storages", status: "created", targetId: created.id, ...(created.recoveryKey ? { recoveryKey: created.recoveryKey } : {}) };
      }
      case "scheduledTasks": {
        const t = p.task;
        const view = await this.tasks.create(userId, p.appId, { name: t.name, schedule: p.cron, command: t.command, enabled: t.enabled, ...(t.timeoutSec ? { timeoutSec: t.timeoutSec } : {}) });
        return { id, section: "scheduledTasks", status: "created", targetId: view.id };
      }
      case "serverSettings": {
        const serverId = input.serverMap?.[p.cleanup.serverRef];
        if (!serverId) return { id, section: "serverSettings", status: "failed", code: "server_required" };
        // The cleanup is written to a server of the SESSION's team only (the service checks the caller's `servers:ops` there).
        const server = await this.prisma.server.findFirst({ where: { id: serverId, teamId }, select: { id: true } });
        if (!server) return { id, section: "serverSettings", status: "failed", code: "server_not_found" };
        // Each Tugra server holds ONE cleanup config: two source servers mapped onto it would overwrite each other.
        if (usedServers.has(server.id)) return { id, section: "serverSettings", status: "failed", code: "server_duplicate" };
        usedServers.add(server.id);
        await this.cleanup.setConfig(userId, server.id, { enabled: true, cron: p.cron, ...(p.cleanup.thresholdPct ? { thresholdPct: p.cleanup.thresholdPct } : {}), volumes: p.cleanup.deleteVolumes });
        return { id, section: "serverSettings", status: "created", targetId: server.id };
      }
      case "tags": {
        let changed = 0;
        for (const target of p.targets) {
          const row =
            target.kind === "application"
              ? await this.prisma.application.findFirst({ where: { id: target.id, teamId }, select: { tags: true } })
              : await this.prisma.database.findFirst({ where: { id: target.id, teamId }, select: { tags: true } });
          if (!row || row.tags.includes(p.tugraName)) continue;
          const next = [...row.tags, p.tugraName];
          if (target.kind === "application") await this.apps.setTags(userId, target.id, next);
          else await this.databases.setTags(userId, target.id, next);
          changed += 1;
        }
        return { id, section: "tags", status: changed ? "created" : "skipped", ...(changed ? {} : { code: "exists" }) };
      }
      case "members": {
        if (input.confirmInvites !== true) return { id, section: "members", status: "failed", code: "confirmation_required" };
        const role = input.memberRoles?.[id] ?? "VIEWER";
        try {
          const inv = await this.teams.invite(userId, teamId, p.member.email, role);
          return { id, section: "members", status: "created", targetId: inv.id };
        } catch (e) {
          if (e instanceof ConflictException) return { id, section: "members", status: "skipped", code: "exists" };
          throw e;
        }
      }
    }
  }
}

function sectionOf(id: string): SettingsSection {
  const head = id.split(":")[0];
  switch (head) {
    case "notification":
      return "notifications";
    case "variable":
      return "sharedVariables";
    case "storage":
      return "storages";
    case "task":
      return "scheduledTasks";
    case "server":
      return "serverSettings";
    case "tag":
      return "tags";
    default:
      return "members";
  }
}
