import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";
import { webBaseUrl } from "../common/web-url";
import { escapeHtml } from "../mail/templates";
import { CreateMaintenanceInput, UpdateStatusPageInput } from "./dto";
import { StatusSubscribersService } from "./status-subscribers.service";
import {
  deriveIncidents,
  type MaintenanceState,
  maintenanceState,
  type OverallStatus,
  overallStatus,
  type PublicMonitorStatus,
  settleIncidents,
  uptimeOver,
} from "./incidents";

const DAYS = 30;
const INCIDENT_WINDOW_DAYS = 90;
const MAX_INCIDENTS = 50;
const CACHE_TTL_MS = 30_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface StatusPageView {
  slug: string;
  title: string;
  description: string | null;
  enabled: boolean;
  monitors: { monitorId: string; label: string | null }[];
  maintenance: { id: string; title: string; body: string | null; startsAt: string; endsAt: string; state: MaintenanceState }[];
  subscribers: { confirmed: number; pending: number };
  url: string;
  rssUrl: string;
}

export interface StatusPageManageView {
  page: StatusPageView | null;
  emailAvailable: boolean;
}

/** What the public page may show: names, states, uptime, incident times and maintenance notices — nothing else. */
export interface PublicStatusView {
  title: string;
  description: string | null;
  overall: OverallStatus;
  updatedAt: string;
  monitors: { name: string; status: PublicMonitorStatus; uptime: number | null; days: { date: string; uptime: number | null }[] }[];
  incidents: { monitor: string; startedAt: string; resolvedAt: string | null }[];
  maintenance: { id: string; title: string; body: string | null; startsAt: string; endsAt: string; state: MaintenanceState }[];
  emailUpdates: boolean;
}

function publicStatus(m: { status: string; enabled: boolean }): PublicMonitorStatus {
  if (!m.enabled) return "paused";
  if (m.status === "UP") return "up";
  if (m.status === "DOWN") return "down";
  return "checking";
}

function xml(s: string): string {
  return escapeHtml(s).replace(/&#39;/g, "&apos;");
}

@Injectable()
export class StatusPageService {
  private cache = new Map<string, { at: number; value: PublicStatusView }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    private readonly subscribers: StatusSubscribersService,
  ) {}

  // ---- management (team-scoped) ----------------------------------------------------------------------------------

  private async requireMember(userId: string, teamId: string): Promise<void> {
    if (!(await this.access.teamRole(userId, teamId))) throw new NotFoundException("team not found");
  }

  private pageUrl(slug: string): string {
    return `${webBaseUrl(this.config)}/status/${slug}`;
  }

  async get(userId: string, teamId: string): Promise<StatusPageManageView> {
    await this.requireMember(userId, teamId);
    const page = await this.prisma.statusPage.findUnique({
      where: { teamId },
      include: { monitors: { orderBy: { position: "asc" } }, maintenance: { orderBy: { startsAt: "desc" }, take: 50 } },
    });
    if (!page) return { page: null, emailAvailable: this.subscribers.emailAvailable() };
    const now = new Date();
    return {
      emailAvailable: this.subscribers.emailAvailable(),
      page: {
        slug: page.slug,
        title: page.title,
        description: page.description,
        enabled: page.enabled,
        monitors: page.monitors.map((m) => ({ monitorId: m.monitorId, label: m.label })),
        maintenance: page.maintenance.map((m) => ({
          id: m.id,
          title: m.title,
          body: m.body,
          startsAt: m.startsAt.toISOString(),
          endsAt: m.endsAt.toISOString(),
          state: maintenanceState(m, now),
        })),
        subscribers: await this.subscribers.counts(page.id),
        url: this.pageUrl(page.slug),
        rssUrl: `${webBaseUrl(this.config)}/api/v1/public/status/${page.slug}/rss`,
      },
    };
  }

  async update(userId: string, teamId: string, input: UpdateStatusPageInput): Promise<StatusPageManageView> {
    await this.access.requirePermission(userId, teamId, "monitors");
    const ids = input.monitors.map((m) => m.monitorId);
    if (ids.length) {
      const owned = await this.prisma.monitor.count({ where: { id: { in: ids }, teamId } });
      if (owned !== ids.length) throw new BadRequestException("a chosen monitor does not belong to this team");
    }
    const existing = await this.prisma.statusPage.findUnique({ where: { teamId }, select: { id: true, slug: true } });
    const data = { slug: input.slug, title: input.title, description: input.description ?? null, enabled: input.enabled };
    const monitors = input.monitors.map((m, position) => ({ monitorId: m.monitorId, label: m.label ?? null, position }));
    try {
      await this.prisma.$transaction(async (tx) => {
        if (existing) {
          await tx.statusPage.update({ where: { id: existing.id }, data });
          await tx.statusPageMonitor.deleteMany({ where: { pageId: existing.id } });
          if (monitors.length) await tx.statusPageMonitor.createMany({ data: monitors.map((m) => ({ ...m, pageId: existing.id })) });
        } else {
          await tx.statusPage.create({ data: { ...data, teamId, monitors: { create: monitors } } });
        }
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw new ConflictException("this address is already taken");
      throw e;
    }
    this.cache.clear();
    await this.audit.log({ actor: userId, action: "status_page.update", target: teamId, meta: { slug: input.slug, enabled: input.enabled, monitors: ids.length } });
    return this.get(userId, teamId);
  }

  async remove(userId: string, teamId: string): Promise<void> {
    await this.access.requirePermission(userId, teamId, "monitors");
    await this.prisma.statusPage.deleteMany({ where: { teamId } });
    this.cache.clear();
    await this.audit.log({ actor: userId, action: "status_page.delete", target: teamId });
  }

  async addMaintenance(userId: string, teamId: string, input: CreateMaintenanceInput): Promise<StatusPageManageView> {
    await this.access.requirePermission(userId, teamId, "monitors");
    const page = await this.prisma.statusPage.findUnique({ where: { teamId }, select: { id: true, slug: true, title: true, enabled: true } });
    if (!page) throw new NotFoundException("create the status page first");
    const m = await this.prisma.statusMaintenance.create({
      data: { pageId: page.id, title: input.title, body: input.body ?? null, startsAt: new Date(input.startsAt), endsAt: new Date(input.endsAt) },
    });
    this.cache.clear();
    await this.audit.log({ actor: userId, action: "status_page.maintenance.create", target: teamId, meta: { id: m.id } });
    if (page.enabled && m.endsAt > new Date()) {
      void this.subscribers.notifyMaintenance(page, { title: m.title, body: m.body, startsAt: m.startsAt, endsAt: m.endsAt }).catch(() => undefined);
    }
    return this.get(userId, teamId);
  }

  async removeMaintenance(userId: string, teamId: string, id: string): Promise<StatusPageManageView> {
    await this.access.requirePermission(userId, teamId, "monitors");
    await this.prisma.statusMaintenance.deleteMany({ where: { id, page: { teamId } } });
    this.cache.clear();
    await this.audit.log({ actor: userId, action: "status_page.maintenance.delete", target: teamId, meta: { id } });
    return this.get(userId, teamId);
  }

  // ---- public ----------------------------------------------------------------------------------------------------

  /** The public view of a published page. Cached briefly: it is unauthenticated, so a crawler must not turn into DB load. */
  async publicView(slug: string): Promise<PublicStatusView> {
    const hit = this.cache.get(slug);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
    const value = await this.buildPublicView(slug);
    if (this.cache.size > 500) this.cache.clear();
    this.cache.set(slug, { at: Date.now(), value });
    return value;
  }

  private async buildPublicView(slug: string): Promise<PublicStatusView> {
    const page = await this.prisma.statusPage.findFirst({
      where: { slug, enabled: true },
      include: {
        monitors: { orderBy: { position: "asc" }, include: { monitor: { select: { id: true, name: true, status: true, enabled: true } } } },
        maintenance: { where: { endsAt: { gte: new Date(Date.now() - INCIDENT_WINDOW_DAYS * DAY_MS) } }, orderBy: { startsAt: "desc" }, take: 20 },
      },
    });
    if (!page) throw new NotFoundException("status page not found");
    const now = new Date();
    const monitorIds = page.monitors.map((m) => m.monitorId);
    const labelOf = new Map(page.monitors.map((m) => [m.monitorId, m.label ?? m.monitor.name]));

    const dayRows = monitorIds.length
      ? await this.prisma.$queryRaw<{ monitorId: string; day: Date; total: bigint; up: bigint }[]>`
          SELECT "monitorId", date_trunc('day', "ts" AT TIME ZONE 'UTC') AS day, count(*) AS total, count(*) FILTER (WHERE "status" = 'UP') AS up
          FROM "Heartbeat"
          WHERE "monitorId" IN (${Prisma.join(monitorIds)}) AND "ts" >= ${new Date(now.getTime() - DAYS * DAY_MS)}
          GROUP BY 1, 2`
      : [];
    const byMonitor = new Map<string, Map<string, { up: number; total: number }>>();
    for (const r of dayRows) {
      const key = new Date(r.day).toISOString().slice(0, 10);
      const per = byMonitor.get(r.monitorId) ?? new Map();
      per.set(key, { up: Number(r.up), total: Number(r.total) });
      byMonitor.set(r.monitorId, per);
    }
    const dates = Array.from({ length: DAYS }, (_, i) => new Date(now.getTime() - (DAYS - 1 - i) * DAY_MS).toISOString().slice(0, 10));

    const beats = monitorIds.length
      ? await this.prisma.heartbeat.findMany({
          where: { monitorId: { in: monitorIds }, important: true, ts: { gte: new Date(now.getTime() - INCIDENT_WINDOW_DAYS * DAY_MS) } },
          select: { monitorId: true, status: true, important: true, ts: true },
          orderBy: { ts: "asc" },
          take: 5000,
        })
      : [];
    const current = new Map(page.monitors.map((m) => [m.monitorId, m.monitor.status as string]));
    const incidents = settleIncidents(deriveIncidents(beats), current, now).slice(0, MAX_INCIDENTS);

    const states = page.monitors.map((m) => publicStatus(m.monitor));
    const maintenance = page.maintenance.map((m) => ({
      id: m.id,
      title: m.title,
      body: m.body,
      startsAt: m.startsAt.toISOString(),
      endsAt: m.endsAt.toISOString(),
      state: maintenanceState(m, now),
    }));
    return {
      title: page.title,
      description: page.description,
      overall: overallStatus(states, maintenance.some((m) => m.state === "active")),
      updatedAt: now.toISOString(),
      monitors: page.monitors.map((m, i) => {
        const per = byMonitor.get(m.monitorId) ?? new Map<string, { up: number; total: number }>();
        return {
          name: labelOf.get(m.monitorId)!,
          status: states[i],
          uptime: uptimeOver([...per.values()]),
          days: dates.map((date) => ({ date, uptime: uptimeOver(per.get(date) ? [per.get(date)!] : []) })),
        };
      }),
      incidents: incidents.map((i) => ({ monitor: labelOf.get(i.monitorId) ?? "", startedAt: i.startedAt.toISOString(), resolvedAt: i.resolvedAt?.toISOString() ?? null })),
      maintenance,
      emailUpdates: this.subscribers.emailAvailable(),
    };
  }

  /** RSS 2.0 of the incident history and maintenance notices. Same data (and the same cache) as the public page. */
  async rss(slug: string): Promise<string> {
    const v = await this.publicView(slug);
    const link = this.pageUrl(slug);
    const items: { title: string; desc: string; date: string; guid: string }[] = [];
    for (const i of v.incidents) {
      items.push({ title: `${i.monitor} is having issues`, desc: `Started ${i.startedAt}.`, date: i.startedAt, guid: `${slug}-down-${i.monitor}-${i.startedAt}` });
      if (i.resolvedAt) items.push({ title: `${i.monitor} is back up`, desc: `Resolved ${i.resolvedAt}.`, date: i.resolvedAt, guid: `${slug}-up-${i.monitor}-${i.resolvedAt}` });
    }
    for (const m of v.maintenance) {
      items.push({ title: `Planned maintenance: ${m.title}`, desc: `${m.startsAt} to ${m.endsAt}.${m.body ? ` ${m.body}` : ""}`, date: m.startsAt, guid: `${slug}-maint-${m.id}` });
    }
    items.sort((a, b) => b.date.localeCompare(a.date));
    const rows = items
      .slice(0, 60)
      .map(
        (i) =>
          `<item><title>${xml(i.title)}</title><link>${xml(link)}</link><guid isPermaLink="false">${xml(i.guid)}</guid><pubDate>${new Date(i.date).toUTCString()}</pubDate><description>${xml(i.desc)}</description></item>`,
      )
      .join("");
    return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${xml(v.title)}</title><link>${xml(link)}</link><description>${xml(v.description ?? v.title)}</description><lastBuildDate>${new Date(v.updatedAt).toUTCString()}</lastBuildDate>${rows}</channel></rss>`;
  }
}
