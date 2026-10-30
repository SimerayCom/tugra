import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { HubBackup } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { BackupRunnerService } from "../backups/backup-runner.service";
import { buildDeleteBackupScript, buildDestinationTestScript } from "../backups/backup-script";
import { HUB_NS } from "./hub-backup-script";
import { HubBackupRunnerService } from "./hub-backup-runner.service";
import { HubBackupSchedulerService } from "./hub-backup-scheduler.service";
import type { HubBackupConfigInput } from "./dto";

export interface HubBackupView {
  enabled: boolean;
  intervalHours: number;
  retention: number;
  destinationId: string | null;
  last: { status: string; at: string | null; sizeBytes: string | null } | null;
  items: HubBackupItem[];
}
export interface HubBackupItem {
  id: string;
  status: string;
  filename: string;
  sizeBytes: string | null;
  errorTail: string | null;
  createdAt: string;
  completedAt: string | null;
}

@Injectable()
export class HubBackupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly agentWs: AgentWsServer,
    private readonly runner: HubBackupRunnerService,
    private readonly scheduler: HubBackupSchedulerService,
    private readonly backups: BackupRunnerService,
  ) {}

  /** Resolve the local server, asserting it exists AND has the backup capability. */
  private async requireLocal() {
    const local = await this.runner.localServer();
    if (!local) throw new ConflictException("no local agent: the hub backup needs the 'This machine' server");
    if (!local.capabilities.includes("backup")) throw new ConflictException("the local agent is not granted the 'backup' capability");
    return local;
  }

  async get(): Promise<HubBackupView> {
    const cfg = await this.prisma.hubBackupConfig.findUnique({ where: { id: "singleton" } });
    const items = await this.prisma.hubBackup.findMany({ orderBy: { createdAt: "desc" }, take: 50 });
    const latest = items[0] ?? null;
    return {
      enabled: cfg?.enabled ?? false,
      intervalHours: cfg?.intervalHours ?? 24,
      retention: cfg?.retention ?? 7,
      destinationId: cfg?.destinationId ?? null,
      last: latest ? { status: latest.status, at: (latest.completedAt ?? latest.createdAt).toISOString(), sizeBytes: latest.sizeBytes != null ? latest.sizeBytes.toString() : null } : null,
      items: items.map((b) => this.item(b)),
    };
  }

  async update(userId: string, input: HubBackupConfigInput): Promise<HubBackupView> {
    const local = await this.requireLocal();
    if (input.destinationId) {
      const dest = await this.prisma.backupDestination.findUnique({ where: { id: input.destinationId } });
      if (!dest || dest.teamId !== local.teamId) throw new BadRequestException("backup destination not found in this team");
    }
    const data = { enabled: input.enabled, intervalHours: input.intervalHours, retention: input.retention, destinationId: input.destinationId ?? null };
    const cfg = await this.prisma.hubBackupConfig.upsert({ where: { id: "singleton" }, create: { id: "singleton", ...data }, update: data });
    await this.scheduler.apply(cfg);
    await this.audit.log({ actor: userId, action: "hub.backup.config", target: "hub" });
    return this.get();
  }

  async run(userId: string): Promise<HubBackupItem> {
    await this.requireLocal();
    return this.item(await this.runner.runBackup(userId));
  }

  async items(): Promise<HubBackupItem[]> {
    return (await this.prisma.hubBackup.findMany({ orderBy: { createdAt: "desc" }, take: 100 })).map((b) => this.item(b));
  }

  /** Test the configured (or a given) S3 destination's reachability from the local agent. */
  async testDestination(destinationId: string | null): Promise<{ ok: boolean; output: string }> {
    const local = await this.requireLocal();
    const spec = await this.backups.destinationSpecById(destinationId);
    if (spec.type !== "S3" || !spec.s3) return { ok: true, output: "LOCAL destination — nothing to test" };
    const r = await this.agentWs.sendCommand(local.id, buildDestinationTestScript(spec.s3), "backup", 60_000);
    return { ok: r.exitCode === 0, output: r.output.slice(-2000) };
  }

  async deleteItem(userId: string, id: string): Promise<void> {
    const local = await this.requireLocal();
    const row = await this.prisma.hubBackup.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("backup not found");
    const spec = await this.backups.destinationSpecById(row.destinationId);
    await this.agentWs.sendCommand(local.id, buildDeleteBackupScript(HUB_NS, row.filename, spec), "backup").catch(() => undefined);
    await this.prisma.hubBackup.delete({ where: { id } });
    await this.audit.log({ actor: userId, action: "hub.backup.delete", target: "hub" });
  }

  private item(b: HubBackup): HubBackupItem {
    return {
      id: b.id,
      status: b.status,
      filename: b.filename,
      sizeBytes: b.sizeBytes != null ? b.sizeBytes.toString() : null,
      errorTail: b.errorTail,
      createdAt: b.createdAt.toISOString(),
      completedAt: b.completedAt ? b.completedAt.toISOString() : null,
    };
  }
}
