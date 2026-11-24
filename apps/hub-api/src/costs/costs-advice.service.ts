import { ForbiddenException, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { CryptoService } from "../crypto/crypto.service";
import { TeamAccessService } from "../common/team-access.service";
import { CloudProviderFactory } from "../cloud/providers/provider-factory.service";
import type { CloudPlanProvider, ProviderPlan } from "../cloud/providers/cloud-provider.interface";
import { PRICE_SNAPSHOT_DATE, REFERENCE_PROVIDER, snapshotFor, type SnapshotPlan } from "./price-snapshot.data";
import { estimateCost, planLabel } from "./cost-estimate";
import { archOf, hostSize, providerOf } from "./cost-size";
import { advise, RIGHTSIZE_MIN_DAYS, RIGHTSIZE_WINDOW_DAYS, type Candidate, type CurrentSize, type UsageStats } from "./rightsizing";
import { latestDiskTotals } from "./costs.service";
import type { AdviceReport, AdviceViewT } from "./costs.dto";

const GIB = 1024 ** 3;
const DAY_MS = 86_400_000;
/** The live plan catalog of a credential is read at most once per hour (and a failure is not retried for 5 minutes). */
const CATALOG_TTL_MS = 3_600_000;
const CATALOG_FAIL_TTL_MS = 300_000;
/** Fewer rollup minutes than this share of the span since the first one means the host was mostly silent. */
const MIN_COVERAGE = 0.5;

interface UsageRow {
  serverId: string;
  n: number;
  cpu_avg: number;
  cpu_p95: number;
  cpu_peak: number;
  mem_p95_b: number;
  mem_peak_b: number;
  mem_p95: number;
  mem_peak: number;
  disk_used_b: number;
  disk_pct: number;
}

/**
 * Size advice ("can go down to X, saves about Y a month" / "near its limit") from 14 days of metric rollups. The advice
 * itself needs only metrics; prices come from the provider's own list when the team linked a provider API (read once an
 * hour per credential), else from the bundled dated snapshot.
 */
@Injectable()
export class CostsAdviceService {
  private readonly catalogs = new Map<string, { at: number; plans: ProviderPlan[] | null }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly crypto: CryptoService,
    private readonly providers: CloudProviderFactory,
  ) {}

  async advice(userId: string, teamId?: string): Promise<AdviceReport> {
    const perms = await this.access.permissionsByTeam(userId);
    if (teamId && !perms.has(teamId)) throw new ForbiddenException("not a member of this team");
    const teamIds = teamId ? [teamId] : [...perms.keys()];
    if (!teamIds.length) return { advice: [], snapshotDate: PRICE_SNAPSHOT_DATE };
    const servers = await this.prisma.server.findMany({ where: { teamId: { in: teamIds } }, include: { cost: true }, orderBy: { name: "asc" } });
    const ids = servers.map((s) => s.id);
    const [usage, firstSeen, disks, active] = await Promise.all([
      this.usageRows(ids),
      this.prisma.metricRollup.groupBy({ by: ["serverId"], where: { serverId: { in: ids } }, _min: { bucket: true } }),
      latestDiskTotals(this.prisma, ids),
      this.prisma.serverRescale.findMany({ where: { serverId: { in: ids }, phase: { notIn: ["DONE", "FAILED"] } }, select: { serverId: true } }),
    ]);
    const first = new Map(firstSeen.map((r) => [r.serverId, r._min.bucket]));
    const busy = new Set(active.map((a) => a.serverId));
    const now = Date.now();
    const out: AdviceViewT[] = [];
    for (const s of servers) {
      const diskBytes = disks.get(s.id) ?? null;
      const firstBucket = first.get(s.id);
      const daysCollected = firstBucket ? Math.max(0, (now - firstBucket.getTime()) / DAY_MS) : 0;
      const row = usage.get(s.id);
      const spanMin = Math.min(RIGHTSIZE_WINDOW_DAYS * 1440, daysCollected * 1440);
      const covered = row && spanMin > 0 ? row.n / spanMin >= MIN_COVERAGE : false;
      const stats: UsageStats | null =
        row && covered && s.memTotalBytes !== null
          ? {
              daysCollected,
              cpuAvgPct: row.cpu_avg,
              cpuP95Pct: row.cpu_p95,
              cpuPeakPct: row.cpu_peak,
              memP95Pct: row.mem_p95 * 100,
              memPeakPct: row.mem_peak * 100,
              memP95Bytes: row.mem_p95_b,
              memPeakBytes: row.mem_peak_b,
              diskUsedPct: row.disk_pct * 100,
              diskUsedBytes: row.disk_used_b,
            }
          : null;
      const base = { serverId: s.id, name: s.name, teamId: s.teamId, daysCollected: Math.round(daysCollected * 10) / 10, daysNeeded: RIGHTSIZE_MIN_DAYS };
      const ctx = await this.context(s, diskBytes);
      const rescaleBlocked = s.isLocal ? ("local_hub" as const) : busy.has(s.id) ? ("active" as const) : null;
      if (!ctx || s.cpuCores === null || s.memTotalBytes === null) {
        out.push({ ...base, kind: "learning", reasons: [], usage: null, provider: providerOf(s), current: null, target: null, savingsCents: null, priceBasis: "reference", upgradeDisk: false, diskBlocked: false, rescale: "guide", rescaleBlocked });
        continue;
      }
      const a = advise(stats && daysCollected >= RIGHTSIZE_MIN_DAYS ? stats : null, ctx.current(s.cpuCores, Number(s.memTotalBytes)), ctx.candidates);
      out.push({
        ...base,
        kind: a.kind,
        reasons: a.reasons,
        usage: stats ? { cpuAvgPct: round1(stats.cpuAvgPct), cpuP95Pct: round1(stats.cpuP95Pct), memP95Pct: round1(stats.memP95Pct), diskUsedPct: round1(stats.diskUsedPct) } : null,
        provider: providerOf(s),
        current: ctx.currentView,
        target: a.target ? { slug: a.target.slug, label: a.target.label, cores: a.target.cores, memoryGb: a.target.memoryGb, diskGb: a.target.diskGb, monthlyCents: a.target.monthlyCents, currency: a.target.currency } : null,
        savingsCents: a.savingsCents,
        priceBasis: ctx.priceBasis,
        upgradeDisk: a.upgradeDisk,
        diskBlocked: a.diskBlocked,
        rescale: ctx.live && a.target && !a.diskBlocked ? "api" : "guide",
        rescaleBlocked,
      });
    }
    // Servers with something to say first.
    const rank = { near_limit: 0, downsize: 1, ok: 2, learning: 3 } as const;
    out.sort((x, y) => rank[x.kind] - rank[y.kind] || x.name.localeCompare(y.name));
    return { advice: out, snapshotDate: PRICE_SNAPSHOT_DATE };
  }

  /** The candidate plans and the current plan for one server, from the provider's live catalog or the snapshot. */
  private async context(
    s: Prisma.ServerGetPayload<{ include: { cost: true } }>,
    diskBytes: number | null,
  ): Promise<{ candidates: Candidate[]; current: (cores: number, memBytes: number) => CurrentSize; currentView: AdviceViewT["current"]; priceBasis: AdviceViewT["priceBasis"]; live: boolean } | null> {
    const arch = archOf(s);
    // Live: the provider API gave this server's plan and location, and its plan catalog is readable.
    if (s.cost?.source === "provider" && s.cost.planSlug && s.cost.location && s.provider && s.cloudCredentialId && s.providerServerId) {
      const client = this.providers.getPlans(s.provider);
      const catalog = client ? await this.catalog(s.cloudCredentialId, client, s.teamId) : null;
      const cur = catalog?.find((p) => p.slug === s.cost?.planSlug);
      const loc = s.cost.location;
      if (catalog && cur) {
        const candidates: Candidate[] = catalog
          .filter((p) => !p.deprecated && p.monthlyCentsByLocation[loc] !== undefined)
          .map((p) => ({ slug: p.slug, label: planLabel({ slug: p.slug, cores: p.cores, memoryGb: p.memoryGb, diskGb: p.diskGb }), cores: p.cores, memoryGb: p.memoryGb, diskGb: p.diskGb, arch: p.architecture, monthlyCents: p.monthlyCentsByLocation[loc], currency: p.currency }));
        const price = cur.monthlyCentsByLocation[loc] ?? s.cost.monthlyCents;
        // A disk grown earlier (it never shrinks) is bigger than the plan names; the host's measured size shows it, since
        // a file system cannot be larger than its disk. Smaller-disk plans are then no in-place move.
        const grown = diskBytes !== null && diskBytes / 1e9 > cur.diskGb * 1.02;
        const diskGb = grown ? Math.max(cur.diskGb, Math.floor((diskBytes / GIB) * 1.1 / 5) * 5) : cur.diskGb;
        return {
          candidates,
          priceBasis: "provider",
          live: true,
          current: (cores, memBytes) => ({ cores, memBytes, diskGb, arch: cur.architecture, comparableMonthlyCents: price, currency: cur.currency, planSlug: cur.slug }),
          currentView: { slug: cur.slug, label: planLabel({ slug: cur.slug, cores: cur.cores, memoryGb: cur.memoryGb, diskGb: cur.diskGb }), cores: cur.cores, memoryGb: cur.memoryGb, diskGb: cur.diskGb, monthlyCents: s.cost.monthlyCents, currency: s.cost.currency },
        };
      }
    }
    // Snapshot: the closest listed plan stands in for the current one; candidates come from the same list.
    const provider = providerOf(s);
    const est = estimateCost(provider, hostSize(s, diskBytes));
    if (!est) return null;
    const snap = snapshotFor(est.provider) ?? snapshotFor(REFERENCE_PROVIDER);
    if (!snap) return null;
    const toCandidate = (p: SnapshotPlan): Candidate => ({ slug: p.slug, label: planLabel(p), cores: p.cores, memoryGb: p.memoryGb, diskGb: p.diskGb, arch: p.arch, monthlyCents: p.monthlyCents, currency: snap.currency });
    const curPlan = snap.plans.find((p) => p.slug === est.planSlug);
    if (!curPlan) return null;
    // The disk a smaller plan must still hold: what the host measures, as the plan's round number (the file system
    // shows a bit less than the plan names); the closest listed plan's disk when nothing was measured.
    const diskGb = diskBytes ? Math.max(5, Math.floor((diskBytes / GIB) * 1.1 / 5) * 5) : curPlan.diskGb;
    const shownPrice = s.cost ? s.cost.monthlyCents : est.monthlyCents;
    return {
      candidates: snap.plans.map(toCandidate),
      priceBasis: est.basis === "list" ? "list" : "reference",
      live: false,
      current: (cores, memBytes) => ({ cores, memBytes, diskGb, arch: curPlan.arch, comparableMonthlyCents: curPlan.monthlyCents, currency: snap.currency, planSlug: curPlan.slug }),
      currentView: { slug: curPlan.slug, label: planLabel(curPlan), cores: curPlan.cores, memoryGb: curPlan.memoryGb, diskGb: curPlan.diskGb, monthlyCents: shownPrice, currency: s.cost ? s.cost.currency : est.currency },
    };
  }

  /** The provider's plan catalog for a credential, cached. Null when it cannot be read (the snapshot stands in). */
  private async catalog(credentialId: string, client: CloudPlanProvider, teamId: string): Promise<ProviderPlan[] | null> {
    const hit = this.catalogs.get(credentialId);
    if (hit && Date.now() - hit.at < (hit.plans ? CATALOG_TTL_MS : CATALOG_FAIL_TTL_MS)) return hit.plans;
    const cred = await this.prisma.cloudCredential.findUnique({ where: { id: credentialId } });
    let plans: ProviderPlan[] | null = null;
    if (cred && cred.teamId === teamId) {
      try {
        plans = await client.listPlanCatalog(this.crypto.decrypt(cred.apiTokenEnc));
      } catch {
        plans = null; // a provider failure never fails the advice list; the snapshot is used instead
      }
    }
    this.catalogs.set(credentialId, { at: Date.now(), plans });
    return plans;
  }

  /** Usage over the last 14 days per server, from the 1-minute rollups (p95 computed in the database). */
  private async usageRows(serverIds: string[]): Promise<Map<string, UsageRow>> {
    if (!serverIds.length) return new Map();
    const since = new Date(Date.now() - RIGHTSIZE_WINDOW_DAYS * DAY_MS);
    const rows = await this.prisma.$queryRaw<UsageRow[]>(Prisma.sql`
      SELECT "serverId",
        COUNT(*)::int AS n,
        AVG("avgCpu")::float8 AS cpu_avg,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY "avgCpu")::float8 AS cpu_p95,
        MAX("maxCpu")::float8 AS cpu_peak,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY "avgMemUsed"::float8)::float8 AS mem_p95_b,
        MAX("avgMemUsed"::float8)::float8 AS mem_peak_b,
        COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY CASE WHEN "avgMemTotal" > 0 THEN "avgMemUsed"::float8 / "avgMemTotal"::float8 END), 0)::float8 AS mem_p95,
        COALESCE(MAX(CASE WHEN "avgMemTotal" > 0 THEN "avgMemUsed"::float8 / "avgMemTotal"::float8 END), 0)::float8 AS mem_peak,
        (array_agg("avgDiskUsed"::float8 ORDER BY bucket DESC))[1]::float8 AS disk_used_b,
        COALESCE((array_agg(CASE WHEN "avgDiskTotal" > 0 THEN "avgDiskUsed"::float8 / "avgDiskTotal"::float8 END ORDER BY bucket DESC))[1], 0)::float8 AS disk_pct
      FROM "MetricRollup"
      WHERE "serverId" IN (${Prisma.join(serverIds)}) AND bucket >= ${since}
      GROUP BY "serverId"`);
    return new Map(rows.map((r) => [r.serverId, r]));
  }
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
