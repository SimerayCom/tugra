import { ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { Role } from "@prisma/client";
import type { CampaignRunPlan, CampaignView } from "@tugra/shared";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { MIGRATION_RUNS_FACADE, type MigrationRunsFacade, type RunActor } from "../migration-runs/core/run-contract";
import { decideAdvance, type AdvanceDecision, type AdvanceRun } from "./campaign-advance";
import { MigrationCampaignsService } from "./migration-campaigns.service";

const TICK_MS = 15_000;
const BOOT_DELAY_MS = 7_000;

/**
 * "Start all" for a campaign (Coolify hub takeover): the owner presses one button, the hub starts each queued run in wave order and goes
 * on by itself when the earlier waves reached a safe point (see `campaign-advance.ts`), so the owner does not come back to start every server.
 * Nothing here weakens a gate: every start goes through the same run facade (same checks), and the owner's VERIFY approval and the
 * swap itself stay where they were. Closing the page changes nothing: this runs on the hub every 15 s, and again after a restart.
 * Only the creator of the campaign can hand it over (runs belong to their creator), and only while they are still an OWNER of its team.
 */
@Injectable()
export class CampaignAdvancerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(CampaignAdvancerService.name);
  private timer?: ReturnType<typeof setInterval>;
  private boot?: ReturnType<typeof setTimeout>;
  private busy = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly campaigns: MigrationCampaignsService,
    @Inject(MIGRATION_RUNS_FACADE) private readonly runs: MigrationRunsFacade,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === "test") return;
    this.boot = setTimeout(() => void this.tick().catch(() => undefined), BOOT_DELAY_MS);
    this.boot.unref?.();
    this.timer = setInterval(() => void this.tick().catch(() => undefined), TICK_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.boot) clearTimeout(this.boot);
  }

  /** Hand the campaign to the hub: it starts the first wave now and each next one when the earlier ones are safe. Owner (and creator) only. */
  async start(actor: RunActor, id: string): Promise<CampaignView> {
    const row = await this.owned(actor, id);
    if (row.status === "cancelled") throw new ConflictException("campaign-cancelled");
    await this.prisma.migrationCampaign.update({ where: { id }, data: { driving: true } });
    await this.audit.log({ actor: actor.userId, action: "migration.campaign.start", target: id, meta: { teamId: row.teamId, label: row.label } });
    await this.advance(id).catch((e: unknown) => this.logger.warn(`campaign ${id}: ${e instanceof Error ? e.message : String(e)}`));
    return this.campaigns.get(actor.userId, id);
  }

  /** Stop starting new servers. A run already started keeps going on its own: this only holds back the ones still queued. */
  async pause(actor: RunActor, id: string): Promise<CampaignView> {
    const row = await this.owned(actor, id);
    await this.prisma.migrationCampaign.update({ where: { id }, data: { driving: false } });
    await this.audit.log({ actor: actor.userId, action: "migration.campaign.pause", target: id, meta: { teamId: row.teamId, label: row.label } });
    return this.campaigns.get(actor.userId, id);
  }

  /** One pass over every campaign that was handed to the hub. Returns the run ids it started (for tests). */
  async tick(): Promise<string[]> {
    if (this.busy) return [];
    this.busy = true;
    try {
      const rows = await this.prisma.migrationCampaign.findMany({ where: { driving: true, NOT: { status: "cancelled" } }, select: { id: true } });
      const started: string[] = [];
      for (const r of rows) started.push(...(await this.advance(r.id).then((d) => d.started).catch((e: unknown) => (this.logger.warn(`campaign ${r.id}: ${e instanceof Error ? e.message : String(e)}`), []))));
      return started;
    } finally {
      this.busy = false;
    }
  }

  /** One campaign: start what the plan allows now. A campaign that finished, was cancelled, or whose creator lost the team is let go. */
  async advance(id: string): Promise<{ started: string[]; decision: AdvanceDecision | null }> {
    const row = await this.prisma.migrationCampaign.findUnique({ where: { id } });
    if (!row || !row.driving) return { started: [], decision: null };
    if (row.status === "cancelled") return { started: [], decision: null };
    const role = await this.access.teamRole(row.actorId, row.teamId);
    if (role !== Role.OWNER) {
      await this.prisma.migrationCampaign.update({ where: { id }, data: { driving: false } });
      return { started: [], decision: null };
    }
    const plan = Array.isArray(row.plan) ? (row.plan as unknown as CampaignRunPlan[]) : [];
    const rows = await this.prisma.migrationRun.findMany({
      where: { teamId: row.teamId, campaign: row.label },
      select: { id: true, status: true, targetServerId: true, inPlace: true, dryRun: true, createdAt: true, steps: { select: { key: true, status: true } } },
      orderBy: { createdAt: "asc" },
    });
    const decision = decideAdvance(plan, rows as AdvanceRun[]);
    if (decision.finished) {
      await this.prisma.migrationCampaign.update({ where: { id }, data: { driving: false } });
      return { started: [], decision };
    }
    const actor: RunActor = { userId: row.actorId, scopes: ["*"], channel: "session" };
    const started: string[] = [];
    for (const runId of decision.start) {
      try {
        await this.runs.start(actor, runId, {});
        started.push(runId);
      } catch (e) {
        // somebody else started it (the owner's own click) or it cannot start now: the next pass looks again, a failure is in the run's own page
        this.logger.warn(`campaign ${id}: run ${runId} did not start: ${e instanceof Error ? e.message : String(e)}`);
        break;
      }
    }
    if (started.length > 0) await this.audit.log({ actor: row.actorId, action: "migration.campaign.advance", target: id, meta: { teamId: row.teamId, started: started.length } });
    return { started, decision };
  }

  private async owned(actor: RunActor, id: string) {
    const row = await this.prisma.migrationCampaign.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("campaign-not-found");
    const role = await this.access.teamRole(actor.userId, row.teamId);
    if (!role) throw new NotFoundException("campaign-not-found");
    if (role !== Role.OWNER) throw new ForbiddenException("insufficient role for this team");
    // the runs belong to the person who made them: only that person can start them, so only that person can hand them over
    if (row.actorId !== actor.userId) throw new ForbiddenException("campaign-creator-only");
    return row;
  }
}
