import { ConflictException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { NotificationsService } from "../notifications/notifications.service";
import { BackupRunnerService } from "../backups/backup-runner.service";
import { scrubRunOutput } from "../backups/backup-script";
import { HUB_NS, buildHubDrillScript, hubBackupPassphrase, hubComposeProject, hubDest, parseDrillOutput } from "./hub-backup-script";

export const DRILL_TIMEOUT_MS = 1_200_000;
const DRILL_HISTORY_CAP = 24;
/** A drill older than this is "overdue" in the view (monthly schedule plus a week of slack). */
export const DRILL_OVERDUE_DAYS = 37;

export interface HubDrillItem {
  id: string;
  status: string;
  trigger: string;
  backupFilename: string | null;
  tables: number | null;
  checks: Record<string, number> | null;
  errorTail: string | null;
  durationMs: number | null;
  createdAt: string;
  completedAt: string | null;
}

/**
 * The monthly restore drill of the hub's own backup: the newest SUCCESS dump is restored into a throwaway Postgres
 * container (no network, removed afterwards) on the local agent and checked (tables exist, account tables hold rows).
 * A backup nobody ever restored is a hope, not a backup; a failing drill alerts through the backup notification path.
 */
@Injectable()
export class HubRestoreDrillService {
  private readonly logger = new Logger(HubRestoreDrillService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly agentWs: AgentWsServer,
    private readonly notifications: NotificationsService,
    private readonly backups: BackupRunnerService,
    private readonly config: ConfigService,
  ) {}

  async list(): Promise<HubDrillItem[]> {
    return (await this.prisma.hubBackupDrill.findMany({ orderBy: { createdAt: "desc" }, take: 12 })).map((r) => this.item(r));
  }

  async run(trigger: "schedule" | "manual", actor = "scheduler"): Promise<HubDrillItem> {
    const local = await this.prisma.server.findFirst({ where: { isLocal: true } });
    if (!local) throw new ConflictException("no local agent: the restore drill needs the 'This machine' server");
    if (!local.capabilities.includes("backup")) throw new ConflictException("the local agent is not granted the 'backup' capability");
    const inflight = await this.prisma.hubBackupDrill.findFirst({ where: { status: "RUNNING", createdAt: { gt: new Date(Date.now() - 2 * DRILL_TIMEOUT_MS) } } });
    if (inflight) return this.item(inflight);

    const started = Date.now();
    const row = await this.prisma.hubBackupDrill.create({ data: { status: "RUNNING", trigger } });
    const backup = await this.prisma.hubBackup.findFirst({ where: { status: "SUCCESS" }, orderBy: { createdAt: "desc" } });
    const passphrase = hubBackupPassphrase(this.config.get<string>("SECRETS_ENCRYPTION_KEY") ?? "");
    let ok = false;
    let tables: number | null = null;
    let checks: Record<string, number> | null = null;
    let errorTail: string | null = null;
    try {
      if (!backup) {
        errorTail = "no successful hub backup to restore yet";
      } else {
        const dest = hubDest(await this.backups.destinationSpecById(backup.destinationId), passphrase);
        const r = await this.agentWs.sendCommand(local.id, buildHubDrillScript({ project: hubComposeProject() }, backup.filename, dest), "backup", DRILL_TIMEOUT_MS);
        const res = parseDrillOutput(r.output, r.exitCode);
        ok = res.ok;
        tables = res.tables;
        checks = res.checks;
        if (!ok) errorTail = `${res.reason ?? "failed"}${r.exitCode !== 0 ? `: ${scrubRunOutput(r.output, [passphrase]).slice(-600)}` : ""}`;
      }
    } catch (e) {
      errorTail = scrubRunOutput(e instanceof Error ? e.message : String(e), [passphrase]).slice(0, 800);
    }
    const done = await this.prisma.hubBackupDrill.update({
      where: { id: row.id },
      data: { status: ok ? "SUCCESS" : "FAILED", backupId: backup?.id ?? null, backupFilename: backup?.filename ?? null, tables, checks: checks ?? undefined, errorTail, durationMs: Date.now() - started, completedAt: new Date() },
    });
    await this.audit.log({ actor, action: "hub.backup.drill", target: "hub", meta: { ok } });
    if (!ok) {
      await this.notifications
        .fireForEvent(local.teamId, "backup_restore_failed", { dbId: "", dbName: "Tugra hub (restore drill)", engine: "POSTGRES", exitCode: "", errorTail: errorTail ?? "" })
        .catch((e) => this.logger.warn(`drill notice failed: ${e instanceof Error ? e.message : e}`));
    }
    const old = (await this.prisma.hubBackupDrill.findMany({ orderBy: { createdAt: "desc" }, select: { id: true } })).slice(DRILL_HISTORY_CAP);
    if (old.length) await this.prisma.hubBackupDrill.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
    return this.item(done);
  }

  private item(r: { id: string; status: string; trigger: string; backupFilename: string | null; tables: number | null; checks: unknown; errorTail: string | null; durationMs: number | null; createdAt: Date; completedAt: Date | null }): HubDrillItem {
    return {
      id: r.id,
      status: r.status,
      trigger: r.trigger,
      backupFilename: r.backupFilename,
      tables: r.tables,
      checks: r.checks && typeof r.checks === "object" ? (r.checks as Record<string, number>) : null,
      errorTail: r.errorTail,
      durationMs: r.durationMs,
      createdAt: r.createdAt.toISOString(),
      completedAt: r.completedAt ? r.completedAt.toISOString() : null,
    };
  }
}
