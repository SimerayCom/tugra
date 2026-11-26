import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { Prisma, Role } from "@prisma/client";
import type { CampaignCreateResult, CampaignRunPlan, CampaignStatus, CampaignTeamPlan, CampaignView, SourcePlacement, SourceServerPlacementView } from "@tugra/shared";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { MIGRATION_RUNS_FACADE, type MigrationRunsFacade, type RunActor } from "../migration-runs/core/run-contract";
import type { CreateMigrationRunInput } from "../migration-runs/core/dto";
import { CampaignFactsService } from "./campaign-facts.service";
import { checkPlacements, deriveCampaignStatus, newCampaignLabel, placementViews, planTeams, refsOfRun, serverMapOfRun, serviceChoicesOfRun, type PlacementCheck } from "./campaign-plan";
import type { CampaignCreateInput, CampaignPlanInput } from "./dto";

const OWNER_ONLY: Role[] = [Role.OWNER];

export interface CampaignPreview {
  planHash: string;
  views: SourceServerPlacementView[];
  /** Set when the placement is accepted: the runs it becomes, every team's together. */
  runs: CampaignRunPlan[] | null;
  /** Set with `runs`: the same runs per Tugra team (one campaign each; the servers of one Coolify may sit in several teams). */
  teams: CampaignTeamPlan[] | null;
  /** Set when it is not: a stable code the screen names, the source server it is about and the reason a lock gives. */
  failure: { code: string; ref?: string; reason?: string } | null;
}

/**
 * Campaigns of guided runs (Coolify hub takeover, lane E): one placement over the source servers of a Coolify session, turned into a
 * run per in-place server and one two-box run for the servers that move to another server. The campaign row only groups: every run is a
 * normal guided run created through the same facade (same checks, same owner-only rules), carrying the campaign label.
 * The target servers may sit in several Tugra teams: one campaign per team (same label, the label is unique per team), every team checked
 * for OWNER before anything is written, every row written in one transaction, and a run that fails to create undoes the whole lot.
 * Team OWNER only, audited; names, refs and ids only.
 */
@Injectable()
export class MigrationCampaignsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly facts: CampaignFactsService,
    @Inject(MIGRATION_RUNS_FACADE) private readonly runs: MigrationRunsFacade,
  ) {}

  /** What each source server offers (locks, suggestion) and, for a given placement, the runs it would create. Writes nothing. */
  async preview(userId: string, input: CampaignPlanInput): Promise<CampaignPreview> {
    const placements = normalise(input.placements);
    const facts = await this.facts.read(userId, { sessionId: input.sessionId, planHash: input.planHash, serverIds: placements.flatMap((p) => (p.targetServerId ? [p.targetServerId] : [])) });
    const check = checkPlacements(placements, facts.hosts, facts.targets);
    const views = placementViews(facts.hosts);
    if (!check.ok) return { planHash: facts.planHash, views, runs: null, teams: null, failure: failureOf(check) };
    const planned = planTeams(check.teams, input.rebuild ?? [], facts.appRefs);
    if (!planned.ok) return { planHash: facts.planHash, views, runs: null, teams: null, failure: { code: planned.code, ref: planned.ref } };
    return { planHash: facts.planHash, views, runs: planned.teams.flatMap((t) => t.runs), teams: planned.teams, failure: null };
  }

  /** The placement screen's rows for a session, with no choice made yet. */
  async views(userId: string, input: { sessionId: string; planHash: string }): Promise<{ planHash: string; views: SourceServerPlacementView[] }> {
    const facts = await this.facts.read(userId, { sessionId: input.sessionId, planHash: input.planHash, serverIds: [] });
    return { planHash: facts.planHash, views: placementViews(facts.hosts) };
  }

  async create(actor: RunActor, input: CampaignCreateInput): Promise<CampaignCreateResult> {
    const placements = normalise(input.placements);
    if (input.confirm !== placements.length) throw new BadRequestException("bad-confirmation");
    const facts = await this.facts.read(actor.userId, { sessionId: input.sessionId, planHash: input.planHash, serverIds: placements.flatMap((p) => (p.targetServerId ? [p.targetServerId] : [])) });
    const check = checkPlacements(placements, facts.hosts, facts.targets);
    if (!check.ok) throw new UnprocessableEntityException({ statusCode: 422, message: check.code, code: check.code, ...(check.ref ? { ref: check.ref } : {}), ...(check.reason ? { reason: check.reason } : {}) });
    // owner of EVERY team the servers belong to: a campaign moves whole servers, so a lesser role in any one of them refuses the lot before anything is written
    for (const t of check.teams) await this.access.requireRole(actor.userId, t.teamId, OWNER_ONLY);

    // the owner's rebuild choices go to the in-place run of their own server; one that belongs nowhere is refused before anything is written
    if (input.options.rebuild !== undefined) throw new BadRequestException("rebuild-not-in-options");
    // an environment is a place inside ONE team: it cannot stand for the servers of several
    if (input.environmentId && check.teams.length > 1) throw new UnprocessableEntityException({ statusCode: 422, message: "environment-single-team-only", code: "environment-single-team-only" });
    const planned = planTeams(check.teams, input.rebuild ?? [], facts.appRefs);
    if (!planned.ok) throw new UnprocessableEntityException({ statusCode: 422, message: planned.code, code: planned.code, ref: planned.ref });
    const multiTeam = planned.teams.length > 1;
    // one label for every campaign (the unique index is per team), so the reports of the one move group together
    const label = input.label ?? newCampaignLabel(new Date());

    let rows: CampaignRow[];
    try {
      // all or nothing: a label already taken in any one team leaves no campaign row behind in the others
      rows = await this.prisma.$transaction(async (tx) => {
        const made: CampaignRow[] = [];
        for (const t of planned.teams) made.push(await tx.migrationCampaign.create({ data: { teamId: t.teamId, actorId: actor.userId, label, sessionId: input.sessionId, status: "draft", plan: t.runs as unknown as Prisma.InputJsonValue } }));
        return made;
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw new ConflictException("campaign-label-taken");
      throw e;
    }
    for (const [i, t] of planned.teams.entries()) {
      await this.audit.log({ actor: actor.userId, action: "migration.campaign.create", target: rows[i].id, meta: { teamId: t.teamId, label, runs: t.runs.length, servers: t.servers, inPlace: t.runs.filter((r) => r.kind === "in-place").length, rebuild: t.runs.reduce((n, r) => n + (r.rebuild?.length ?? 0), 0), ...(multiTeam ? { teams: planned.teams.length } : {}) } });
    }

    const created: string[][] = planned.teams.map(() => []);
    try {
      for (const [i, t] of planned.teams.entries()) {
        for (const run of t.runs) {
          // across teams a run carries the service choices of its own servers only: a choice naming another team's server would fail there
          const body = runBody(input, run, check.placements, label, multiTeam ? (serviceChoicesOfRun(input.serviceChoices, run) ?? null) : input.serviceChoices);
          // an in-place wave is taken over in place (no data copy, no build): only the campaign may set that, never the request body
          const view = run.kind === "in-place" ? await this.runs.create(actor, body, { inPlace: true }) : await this.runs.create(actor, body);
          created[i].push(view.id);
        }
      }
    } catch (e) {
      // nothing of a half-made campaign is left to start by accident: the runs made so far (in every team) are aborted and every campaign is cancelled
      await this.abortQueued(actor, created.flat());
      for (const [i, row] of rows.entries()) {
        await this.prisma.migrationCampaign.update({ where: { id: row.id }, data: { status: "cancelled" } });
        await this.audit.log({ actor: actor.userId, action: "migration.campaign.cancel", target: row.id, meta: { reason: "create-failed", created: created[i].length } });
      }
      throw e;
    }
    const views = rows.map((row, i) => this.view(row, created[i]));
    return { ...views[0], campaigns: views };
  }

  async list(userId: string, teamId: string): Promise<CampaignView[]> {
    await this.access.requireRole(userId, teamId, [Role.OWNER, Role.ADMIN]);
    const rows = await this.prisma.migrationCampaign.findMany({ where: { teamId }, orderBy: { createdAt: "desc" }, take: 100 });
    return Promise.all(rows.map((r) => this.hydrate(r)));
  }

  async get(userId: string, id: string): Promise<CampaignView> {
    const row = await this.prisma.migrationCampaign.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("campaign-not-found");
    const role = await this.access.teamRole(userId, row.teamId);
    if (role !== Role.OWNER && role !== Role.ADMIN) throw new NotFoundException("campaign-not-found"); // another team's campaign is indistinguishable from an unknown one
    return this.hydrate(row);
  }

  /** Cancel what has not started: queued runs are aborted, a run already moving is left to its own abort. The campaign is then cancelled. */
  async cancel(actor: RunActor, id: string): Promise<CampaignView> {
    const row = await this.prisma.migrationCampaign.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("campaign-not-found");
    const role = await this.access.teamRole(actor.userId, row.teamId);
    if (!role) throw new NotFoundException("campaign-not-found");
    if (role !== Role.OWNER) throw new ForbiddenException("insufficient role for this team");
    const runs = await this.runsOf(row);
    const queued = runs.filter((r) => r.status === "QUEUED" || r.status === "DRY_RUN_DONE").map((r) => r.id);
    await this.abortQueued(actor, queued);
    const updated = await this.prisma.migrationCampaign.update({ where: { id }, data: { status: "cancelled" } });
    await this.audit.log({ actor: actor.userId, action: "migration.campaign.cancel", target: id, meta: { aborted: queued.length } });
    return this.hydrate(updated);
  }

  // ───────────────────────────── helpers ─────────────────────────────

  private async runsOf(row: { teamId: string; label: string }): Promise<Array<{ id: string; status: string }>> {
    return this.prisma.migrationRun.findMany({ where: { teamId: row.teamId, campaign: row.label }, select: { id: true, status: true }, orderBy: { createdAt: "asc" } });
  }

  private async hydrate(row: CampaignRow): Promise<CampaignView> {
    const runs = await this.runsOf(row);
    const status = deriveCampaignStatus(row.status as CampaignStatus, runs.map((r) => r.status));
    if (status !== row.status) await this.prisma.migrationCampaign.update({ where: { id: row.id }, data: { status } }).catch(() => undefined);
    return this.view({ ...row, status }, runs.map((r) => r.id));
  }

  private view(row: CampaignRow, runIds: string[]): CampaignView {
    return { id: row.id, teamId: row.teamId, label: row.label, sessionId: row.sessionId, status: row.status as CampaignStatus, plan: Array.isArray(row.plan) ? (row.plan as unknown as CampaignRunPlan[]) : [], runIds, createdAt: row.createdAt.toISOString() };
  }

  private async abortQueued(actor: RunActor, ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      try {
        await this.runs.abort(actor, id, { confirmName: id });
      } catch {
        // a run that cannot be aborted (already past its first step) is shown as it is; the campaign still reads cancelled
      }
    }
  }
}

interface CampaignRow {
  id: string;
  teamId: string;
  label: string;
  sessionId: string | null;
  status: string;
  plan: Prisma.JsonValue;
  createdAt: Date;
}

const normalise = (xs: CampaignPlanInput["placements"]): SourcePlacement[] => xs.map((p) => ({ sourceServerRef: p.sourceServerRef, kind: p.kind, targetServerId: p.targetServerId ?? null }));

const failureOf = (c: Extract<PlacementCheck, { ok: false }>): NonNullable<CampaignPreview["failure"]> => ({ code: c.code, ...(c.ref ? { ref: c.ref } : {}), ...(c.reason ? { reason: c.reason } : {}) });

/** The create body of one run: the shared fields, the placement's target and topology, a scope that keeps to this run's source servers. */
export function runBody(input: CampaignCreateInput, run: CampaignRunPlan, placements: readonly SourcePlacement[], label: string, serviceChoices: CampaignCreateInput["serviceChoices"] | null = input.serviceChoices): CreateMigrationRunInput {
  const serverMap = serverMapOfRun(run, placements);
  return {
    sessionId: input.sessionId,
    sourceKind: "coolify",
    targetServerId: run.targetServerId,
    planHash: input.planHash,
    ...(input.environmentId ? { environmentId: input.environmentId } : {}),
    ...(input.acks ? { acks: input.acks } : {}),
    ...(serviceChoices ? { serviceChoices } : {}),
    ...(input.reconcile !== undefined ? { reconcile: input.reconcile } : {}),
    ...(input.dbDataModes ? { dbDataModes: input.dbDataModes } : {}),
    mode: input.mode,
    topology: run.topology,
    dryRun: input.dryRun,
    // the options are shared by the whole campaign; the rebuild list is the run's own (only an in-place run builds anything)
    options: run.rebuild && run.rebuild.length > 0 ? { ...input.options, rebuild: run.rebuild } : input.options,
    inputs: input.inputs,
    ...(serverMap ? { serverMap } : {}),
    campaign: label,
    scope: { sourceServers: refsOfRun(run) },
  } as CreateMigrationRunInput;
}
