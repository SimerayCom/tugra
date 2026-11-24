import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { CryptoService } from "../crypto/crypto.service";
import { TeamAccessService, isScoped } from "../common/team-access.service";
import { CloudProviderFactory } from "../cloud/providers/provider-factory.service";
import { oobHttpError } from "../cloud/oob.service";
import { resolveContainerLabel } from "../metrics/container-metrics.service";
import type { ContainerLabelRow } from "../metrics/container-labels";
import { PRICE_SNAPSHOT_DATE, snapshotFor } from "./price-snapshot.data";
import { estimateCost, planLabel, toCents } from "./cost-estimate";
import { allocate, groupUse } from "./cost-allocation";
import { hostSize, providerOf } from "./cost-size";
import type { CostsReport, CreateBaselineInput, SetServerCostInput, SyncResult, TeamCostView } from "./costs.dto";

export const USAGE_WINDOW_MS = 14 * 86_400_000;
const MAX_BASELINES = 20;
/** Apps listed per server; the rest fold into one "other" row. */
const MAX_APP_ROWS = 12;

type ServerRow = Prisma.ServerGetPayload<{ include: { cost: true } }>;
type CostSource = "provider" | "manual" | "estimate" | "unknown";

/** The resolved price of one server (what the page shows and what totals add up). */
export interface ResolvedCost {
  source: CostSource;
  monthlyCents: number | null;
  currency: string | null;
  provider: string | null;
  planSlug: string | null;
  planLabel: string | null;
  estimateBasis: "list" | "reference" | null;
  snapshotVerified: boolean | null;
  syncedAt: Date | null;
}

/** Latest measured disk size (bytes) per server from the metric rollups (the last 3 days; one row per server). */
export async function latestDiskTotals(prisma: PrismaService, serverIds: string[]): Promise<Map<string, number>> {
  if (!serverIds.length) return new Map();
  const rows = await prisma.$queryRaw<Array<{ serverId: string; disk: number }>>(Prisma.sql`
    SELECT DISTINCT ON ("serverId") "serverId", "avgDiskTotal"::float8 AS disk
    FROM "MetricRollup"
    WHERE "serverId" IN (${Prisma.join(serverIds)}) AND bucket > ${new Date(Date.now() - 3 * 86_400_000)}
    ORDER BY "serverId", bucket DESC`);
  return new Map(rows.filter((r) => Number(r.disk) > 0).map((r) => [r.serverId, Number(r.disk)]));
}

/** Resolve a server's price: a stored provider/manual price wins, else an estimate from the dated snapshot. Pure. */
export function resolveCost(server: ServerRow, diskBytes: number | null): ResolvedCost {
  const row = server.cost;
  if (row && (row.source === "provider" || row.source === "manual")) {
    const snapPlan = row.planSlug ? snapshotFor(row.provider)?.plans.find((p) => p.slug === row.planSlug) : undefined;
    return {
      source: row.source,
      monthlyCents: row.monthlyCents,
      currency: row.currency,
      provider: row.provider ?? providerOf(server),
      planSlug: row.planSlug,
      planLabel: snapPlan ? planLabel(snapPlan) : row.planSlug ? row.planSlug.toUpperCase() : null,
      estimateBasis: null,
      snapshotVerified: null,
      syncedAt: row.syncedAt,
    };
  }
  const est = estimateCost(providerOf(server), hostSize(server, diskBytes));
  if (!est) {
    return { source: "unknown", monthlyCents: null, currency: null, provider: providerOf(server), planSlug: null, planLabel: null, estimateBasis: null, snapshotVerified: null, syncedAt: null };
  }
  return {
    source: "estimate",
    monthlyCents: est.monthlyCents,
    currency: est.currency,
    provider: providerOf(server) ?? est.provider,
    planSlug: est.planSlug,
    planLabel: est.planLabel,
    estimateBasis: est.basis,
    snapshotVerified: est.verified,
    syncedAt: null,
  };
}

/**
 * Server prices, per-app cost shares, the before/after comparison and the provider price sync.
 *
 * A price is read from the provider API when a linked provider can report it, typed by an operator, or estimated from
 * the bundled dated public price snapshot (never persisted). Money is integer minor units excluding VAT; totals are
 * kept per currency (no conversion rate is ever guessed). Every route is team-scoped: reads need membership, writes
 * need `servers:manage` (prices, baselines) or `servers:ops` (a sync spends the team's provider API quota).
 */
@Injectable()
export class CostsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly providers: CloudProviderFactory,
  ) {}

  // ───────────────────────────── read ─────────────────────────────

  /** Costs of one team (`teamId`) or of every team the caller belongs to. */
  async report(userId: string, teamId?: string): Promise<CostsReport> {
    const perms = await this.access.permissionsByTeam(userId);
    if (teamId && !perms.has(teamId)) throw new ForbiddenException("not a member of this team");
    const teamIds = teamId ? [teamId] : [...perms.keys()];
    if (!teamIds.length) return { teams: [] };
    const [teams, servers, accessByTeam] = await Promise.all([
      this.prisma.team.findMany({ where: { id: { in: teamIds } }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
      this.prisma.server.findMany({ where: { teamId: { in: teamIds } }, include: { cost: true }, orderBy: { name: "asc" } }),
      this.access.accessByTeam(userId),
    ]);
    const serverIds = servers.map((s) => s.id);
    const [disks, use, apps, dbs, labels, baselines] = await Promise.all([
      latestDiskTotals(this.prisma, serverIds),
      this.containerUse(serverIds),
      this.prisma.application.findMany({ where: { serverId: { in: serverIds } }, select: { id: true, name: true, serverId: true } }),
      this.prisma.database.findMany({ where: { serverId: { in: serverIds } }, select: { id: true, name: true, serverId: true } }),
      this.prisma.containerLabel.findMany({ where: { serverId: { in: serverIds } } }),
      this.prisma.costBaseline.findMany({ where: { teamId: { in: teamIds } }, orderBy: { createdAt: "desc" }, take: MAX_BASELINES * teamIds.length }),
    ]);
    const labelRows = new Map<string, ContainerLabelRow>(
      labels.map((r) => [`${r.serverId}\u0000${r.containerName}`, { name: r.name, resource: r.resource, project: r.project, environment: r.environment, service: r.service }]),
    );

    const out: TeamCostView[] = [];
    for (const team of teams) {
      const p = perms.get(team.id)!;
      const hideApps = isScoped(accessByTeam.get(team.id)); // a restricted viewer must not learn app names they cannot open
      const rows = servers.filter((s) => s.teamId === team.id);
      const views = rows.map((s) => {
        const cost = resolveCost(s, disks.get(s.id) ?? null);
        const shares =
          hideApps || cost.monthlyCents === null
            ? []
            : this.appShares(
                s.id,
                cost.monthlyCents,
                use.get(s.id) ?? [],
                new Map(apps.filter((a) => a.serverId === s.id).map((a) => [a.id, a.name])),
                new Map(dbs.filter((d) => d.serverId === s.id).map((d) => [d.id, d.name])),
                labelRows,
              );
        return {
          serverId: s.id,
          name: s.name,
          monthlyCents: cost.monthlyCents,
          currency: cost.currency,
          source: cost.source,
          provider: cost.provider,
          planSlug: cost.planSlug,
          planLabel: cost.planLabel,
          estimateBasis: cost.estimateBasis,
          snapshotVerified: cost.snapshotVerified,
          syncedAt: cost.syncedAt ? cost.syncedAt.toISOString() : null,
          canSync: !!(s.provider && s.providerServerId && s.cloudCredentialId && this.providers.getPlans(s.provider)),
          cores: s.cpuCores,
          memBytes: s.memTotalBytes === null ? null : Number(s.memTotalBytes),
          diskBytes: disks.get(s.id) ?? null,
          apps: shares,
        };
      });
      const totals = new Map<string, { currency: string; monthlyCents: number; estimatedCents: number; servers: number }>();
      for (const v of views) {
        if (v.monthlyCents === null || !v.currency) continue;
        const t = totals.get(v.currency) ?? { currency: v.currency, monthlyCents: 0, estimatedCents: 0, servers: 0 };
        t.monthlyCents += v.monthlyCents;
        if (v.source === "estimate") t.estimatedCents += v.monthlyCents;
        t.servers += 1;
        totals.set(v.currency, t);
      }
      const teamBaselines = baselines.filter((b) => b.teamId === team.id).slice(0, MAX_BASELINES);
      const baselineViews = teamBaselines.map((b) => ({
        id: b.id,
        label: b.label,
        monthlyCents: b.monthlyCents,
        currency: b.currency,
        createdAt: b.createdAt.toISOString(),
        servers: Array.isArray(b.lines) ? b.lines.length : 0,
      }));
      const latest = baselineViews[0];
      const now = latest ? totals.get(latest.currency) : undefined;
      let comparison: TeamCostView["comparison"] = null;
      if (latest && now && latest.monthlyCents > 0) {
        const delta = now.monthlyCents - latest.monthlyCents;
        comparison = {
          baseline: latest,
          currency: latest.currency,
          beforeCents: latest.monthlyCents,
          afterCents: now.monthlyCents,
          deltaCents: delta,
          deltaPct: Math.round((delta / latest.monthlyCents) * 100),
          yearlyDeltaCents: delta * 12,
          includesEstimates: now.estimatedCents > 0,
        };
      }
      out.push({
        teamId: team.id,
        teamName: team.name,
        canManage: p.has("servers:manage"),
        canOps: p.has("servers:ops"),
        totals: [...totals.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
        servers: views,
        baselines: baselineViews,
        comparison,
        snapshotDate: PRICE_SNAPSHOT_DATE,
      });
    }
    return { teams: out };
  }

  /** Per-container CPU / memory sums over the usage window, by server. */
  private async containerUse(serverIds: string[]): Promise<Map<string, Array<{ containerName: string; cpuSum: number; memSum: number }>>> {
    const out = new Map<string, Array<{ containerName: string; cpuSum: number; memSum: number }>>();
    if (!serverIds.length) return out;
    const rows = await this.prisma.containerMetricRollup.groupBy({
      by: ["serverId", "containerName"],
      where: { serverId: { in: serverIds }, bucket: { gte: new Date(Date.now() - USAGE_WINDOW_MS) } },
      _sum: { avgCpu: true, avgMemUsed: true },
    });
    for (const r of rows) {
      const list = out.get(r.serverId) ?? [];
      list.push({ containerName: r.containerName, cpuSum: r._sum.avgCpu ?? 0, memSum: Number(r._sum.avgMemUsed ?? 0) });
      out.set(r.serverId, list);
    }
    return out;
  }

  /** Split one server's price over what runs on it by CPU + memory use; the shares add up to the price. */
  private appShares(
    serverId: string,
    totalCents: number,
    use: Array<{ containerName: string; cpuSum: number; memSum: number }>,
    appNames: Map<string, string>,
    dbNames: Map<string, string>,
    labels: Map<string, ContainerLabelRow>,
  ) {
    if (!use.length) return [];
    const info = new Map<string, { key: string; kind: "app" | "db" | "system" | "other"; resourceId: string | null; name: string }>();
    const keyOf = (containerName: string): string => {
      const r = resolveContainerLabel(containerName, appNames, dbNames, labels.get(`${serverId}\u0000${containerName}`));
      const resourceId = r.resourceId ?? null;
      const key = r.kind === "app" && resourceId ? `app:${resourceId}` : r.kind === "db" && resourceId ? `db:${resourceId}` : r.kind === "system" ? "system" : `other:${r.label}`;
      if (!info.has(key)) {
        const name = r.kind === "app" && resourceId ? (appNames.get(resourceId) ?? r.label) : r.label;
        info.set(key, { key, kind: r.kind, resourceId: r.kind === "app" || r.kind === "db" ? resourceId : null, name: r.kind === "system" ? "system" : name });
      }
      return key;
    };
    const shares = allocate(totalCents, groupUse(use, keyOf));
    const shown = shares.slice(0, MAX_APP_ROWS);
    const rest = shares.slice(MAX_APP_ROWS);
    const rows = shown.map((s) => ({ ...info.get(s.key)!, sharePct: s.sharePct, cents: s.cents }));
    if (rest.length) {
      rows.push({
        key: "more",
        kind: "other",
        resourceId: null,
        name: `+${rest.length}`,
        sharePct: Math.round(rest.reduce((a, r) => a + r.sharePct, 0) * 10) / 10,
        cents: rest.reduce((a, r) => a + r.cents, 0),
      });
    }
    return rows;
  }

  // ───────────────────────────── prices ─────────────────────────────

  /** Type the real monthly price of a server (servers:manage). It replaces a provider/estimated figure until cleared. */
  async setServerCost(userId: string, serverId: string, body: SetServerCostInput): Promise<{ ok: true }> {
    const server = await this.requireServer(serverId);
    await this.access.requirePermission(userId, server.teamId, "servers:manage");
    const cents = toCents(body.monthly);
    if (cents === null) throw new BadRequestException("monthly price is out of range");
    const existing = await this.prisma.serverCost.findUnique({ where: { serverId } });
    const data = {
      monthlyCents: cents,
      currency: body.currency,
      source: "manual",
      provider: existing?.provider ?? providerOf(server),
      planSlug: existing?.planSlug ?? null,
      location: existing?.location ?? null,
      syncedAt: null,
    };
    await this.prisma.serverCost.upsert({ where: { serverId }, create: { serverId, ...data }, update: data });
    await this.audit.log({ actor: userId, action: "server.cost.set", target: serverId, meta: { monthlyCents: cents, currency: body.currency } });
    return { ok: true };
  }

  /** Drop a stored price: the server falls back to the provider price (after a sync) or the estimate (servers:manage). */
  async clearServerCost(userId: string, serverId: string): Promise<{ ok: true }> {
    const server = await this.requireServer(serverId);
    await this.access.requirePermission(userId, server.teamId, "servers:manage");
    await this.prisma.serverCost.deleteMany({ where: { serverId } });
    await this.audit.log({ actor: userId, action: "server.cost.clear", target: serverId });
    return { ok: true };
  }

  /**
   * Read the real prices from the providers of the team's linked servers (servers:ops: it spends the team's API
   * quota). One list call per credential. A price an operator typed is never overwritten. The token is decrypted for
   * the call and dropped; a provider failure is reported per credential with a message derived from the provider's
   * response, never the request.
   */
  async sync(userId: string, teamId: string): Promise<SyncResult> {
    await this.access.requirePermission(userId, teamId, "servers:ops");
    const servers = await this.prisma.server.findMany({
      where: { teamId, provider: { not: null }, providerServerId: { not: null }, cloudCredentialId: { not: null } },
      include: { cost: true },
    });
    const byCred = new Map<string, ServerRow[]>();
    for (const s of servers) byCred.set(s.cloudCredentialId as string, [...(byCred.get(s.cloudCredentialId as string) ?? []), s]);
    const result: SyncResult = { synced: 0, failed: [] };
    for (const [credId, list] of byCred) {
      const cred = await this.prisma.cloudCredential.findUnique({ where: { id: credId } });
      if (!cred || cred.teamId !== teamId) continue;
      const client = this.providers.getPlans(cred.provider);
      if (!client) continue;
      let plans;
      try {
        plans = await client.listServerPlans(this.crypto.decrypt(cred.apiTokenEnc));
      } catch (e) {
        result.failed.push({ credentialName: cred.name, message: oobHttpError(cred.provider, e).message });
        continue;
      }
      const byId = new Map(plans.map((p) => [p.providerServerId, p]));
      for (const s of list) {
        const p = byId.get(s.providerServerId as string);
        if (!p || p.monthlyCents === null || s.cost?.source === "manual") continue;
        const data = { monthlyCents: p.monthlyCents, currency: p.currency, source: "provider", provider: cred.provider, planSlug: p.plan.slug, location: p.location, syncedAt: new Date() };
        await this.prisma.serverCost.upsert({ where: { serverId: s.id }, create: { serverId: s.id, ...data }, update: data });
        result.synced += 1;
      }
    }
    await this.audit.log({ actor: userId, action: "costs.sync", target: teamId, meta: { synced: result.synced, failed: result.failed.length } });
    return result;
  }

  // ───────────────────────────── baselines ─────────────────────────────

  /** Save the "before" bill: the team's current prices, or a total typed by hand (servers:manage). */
  async createBaseline(userId: string, body: CreateBaselineInput): Promise<{ id: string }> {
    await this.access.requirePermission(userId, body.teamId, "servers:manage");
    if ((await this.prisma.costBaseline.count({ where: { teamId: body.teamId } })) >= MAX_BASELINES) {
      throw new ConflictException(`a team keeps at most ${MAX_BASELINES} saved bills; delete one first`);
    }
    let monthlyCents: number;
    let currency: string;
    let lines: Array<{ name: string; monthlyCents: number }> = [];
    if (body.monthly !== undefined && body.currency !== undefined) {
      const c = toCents(body.monthly);
      if (c === null) throw new BadRequestException("monthly total is out of range");
      monthlyCents = c;
      currency = body.currency;
    } else {
      const current = (await this.report(userId, body.teamId)).teams[0];
      const priced = current.servers.filter((s) => s.monthlyCents !== null && s.currency);
      const currencies = new Set(priced.map((s) => s.currency));
      if (!priced.length) throw new BadRequestException("no server has a price yet; type the total instead");
      if (currencies.size > 1) throw new BadRequestException("the prices are in more than one currency; type the total instead");
      currency = priced[0].currency as string;
      monthlyCents = priced.reduce((a, s) => a + (s.monthlyCents as number), 0);
      lines = priced.map((s) => ({ name: s.name, monthlyCents: s.monthlyCents as number }));
    }
    const label = body.label ?? `Baseline ${new Date().toISOString().slice(0, 10)}`;
    const row = await this.prisma.costBaseline.create({
      data: { teamId: body.teamId, label, monthlyCents, currency, lines: lines as unknown as Prisma.InputJsonValue, createdBy: userId },
    });
    await this.audit.log({ actor: userId, action: "costs.baseline.create", target: row.id, meta: { teamId: body.teamId, monthlyCents, currency } });
    return { id: row.id };
  }

  async deleteBaseline(userId: string, id: string): Promise<{ ok: true }> {
    const row = await this.prisma.costBaseline.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("saved bill not found");
    await this.access.requirePermission(userId, row.teamId, "servers:manage");
    await this.prisma.costBaseline.delete({ where: { id } });
    await this.audit.log({ actor: userId, action: "costs.baseline.delete", target: id, meta: { teamId: row.teamId } });
    return { ok: true };
  }

  private async requireServer(serverId: string) {
    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundException("server not found");
    return server;
  }
}
