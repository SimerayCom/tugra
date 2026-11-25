import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { TeamPermission } from "@tugra/shared";
import { PrismaService } from "../prisma/prisma.service";
import { CryptoService } from "../crypto/crypto.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { NotificationsService } from "../notifications/notifications.service";
import { MonitorsService } from "../monitors/monitors.service";
import { assertAllowedUrl } from "../importer/sources/ssrf-guard";
import { mapLimit } from "../importer/sources/map-limit";
import { BeszelClient, BeszelError, type BeszelSnapshot } from "./beszel-client";
import { buildHistory, STATS_TYPES, toFiveMinute, type BeszelStatsRecord } from "./beszel-map";
import { metricTiers } from "../metrics/metric-tiers";
import { buildPlan, channelKey, metricLabel, type PlanView } from "./beszel-plan";
import type { BeszelApplyInput, BeszelConnectInput, BeszelPreviewInput } from "./dto";

export const BESZEL_SOURCE_KIND = "beszel";
const SESSION_TTL_MS = 60 * 60_000;
const KEPT_TTL_MS = 30 * 86_400_000;
const STATUS_EVENTS = ["server_offline", "server_online"] as const;
const KEEP_MARK = "keep";

/** The part of {@link BeszelClient} the service uses, so a spec can hand in a fake. */
export interface BeszelSource {
  login(identity: string, password: string): Promise<void>;
  snapshot(): Promise<BeszelSnapshot>;
  stats(systemId: string, types: readonly string[]): Promise<BeszelStatsRecord[]>;
}
export const BESZEL_SOURCE_FACTORY = Symbol("BESZEL_SOURCE_FACTORY");
export type BeszelSourceFactory = (baseUrl: string) => BeszelSource;

export interface HistoryPreview {
  windowDays: number;
  totalPoints: number;
  systems: Array<{ systemId: string; serverId: string; points: number; from: string | null; to: string | null }>;
}
export interface BeszelPreview extends PlanView {
  sessionId: string;
  host: string;
  /** The team's servers, for the manual match of a system the automatic match could not place. */
  servers: Array<{ id: string; name: string }>;
  history: HistoryPreview;
}

type Outcome = "created" | "existing" | "failed" | "skipped";
export interface BeszelApplyResult {
  channels: Record<Outcome, number>;
  monitors: Record<Outcome, number> & { covered: number };
  history: { systems: number; points: number };
  failures: Array<{ kind: "channel" | "alert" | "history"; ref: string; reason: "rejected" | "error" }>;
  credentialsDropped: boolean;
}

const zero = (): Record<Outcome, number> => ({ created: 0, existing: 0, failed: 0, skipped: 0 });

/**
 * Beszel → Tugra import: a dry-run preview of systems, alert rules, notification channels and 30 days of history, then an
 * apply that is bound to the reviewed preview (hash) and idempotent (an equal monitor or channel is reused, history never
 * overwrites a bucket Tugra holds). The Beszel credentials live encrypted in an ImportSession for the import only.
 */
@Injectable()
export class BeszelImportService {
  private readonly applying = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    private readonly notifications: NotificationsService,
    private readonly monitors: MonitorsService,
    @Optional() @Inject(BESZEL_SOURCE_FACTORY) private readonly factory: BeszelSourceFactory = (url) => new BeszelClient(url),
  ) {}

  // ── permissions ──────────────────────────────────────────────────────────────────────────────────────────────────
  /** What this member may import into the team: alert rules need `monitors`, channels `integrations`, history `servers:ops`. */
  private async grants(userId: string, teamId: string): Promise<{ alerts: boolean; channels: boolean; history: boolean }> {
    const perms = await this.access.membershipPermissions(userId, teamId);
    if (!perms) throw new ForbiddenException("not a member of this team");
    const has = (p: TeamPermission) => perms.has(p);
    const g = { alerts: has("monitors"), channels: has("integrations"), history: has("servers:ops") };
    if (!g.alerts && !g.channels && !g.history) throw new ForbiddenException("insufficient permission for this team");
    return g;
  }

  // ── connect ──────────────────────────────────────────────────────────────────────────────────────────────────────
  async connect(userId: string, input: BeszelConnectInput): Promise<{ sessionId: string; expiresAt: Date; host: string; credentialsKept: boolean }> {
    await this.grants(userId, input.teamId);
    let host: string;
    try {
      host = assertAllowedUrl(input.baseUrl).host;
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : "invalid base URL");
    }
    await this.prisma.importSession.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    const source = this.factory(input.baseUrl);
    try {
      await source.login(input.identity, input.password);
    } catch (e) {
      throw this.asBadRequest(e);
    }
    const keep = input.keepCredentials === true;
    const expiresAt = new Date(Date.now() + (keep ? KEPT_TTL_MS : SESSION_TTL_MS));
    const session = await this.prisma.importSession.create({
      data: {
        teamId: input.teamId,
        actorId: userId,
        sourceKind: BESZEL_SOURCE_KIND,
        baseUrl: input.baseUrl,
        tokenEnc: this.crypto.encrypt(JSON.stringify({ identity: input.identity, password: input.password })), // never stored or returned in the clear
        scopeKey: keep ? KEEP_MARK : "",
        status: "active",
        expiresAt,
      },
    });
    await this.audit.log({ actor: userId, action: "import.beszel.connect", target: session.id, meta: { teamId: input.teamId, host, kept: keep } });
    return { sessionId: session.id, expiresAt, host, credentialsKept: keep };
  }

  /** The caller's own kept (opt-in) connections, so a later visit can reuse one without signing in again. */
  async listKept(userId: string): Promise<Array<{ sessionId: string; teamId: string; host: string; expiresAt: Date }>> {
    const rows = await this.prisma.importSession.findMany({
      where: { actorId: userId, sourceKind: BESZEL_SOURCE_KIND, scopeKey: KEEP_MARK, status: "active", expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
      select: { id: true, teamId: true, baseUrl: true, expiresAt: true },
    });
    const out: Array<{ sessionId: string; teamId: string; host: string; expiresAt: Date }> = [];
    for (const r of rows) {
      // a member removed from the team since, or one who lost every import permission, no longer sees it
      const perms = await this.access.membershipPermissions(userId, r.teamId);
      if (perms && (perms.has("monitors") || perms.has("integrations") || perms.has("servers:ops"))) out.push({ sessionId: r.id, teamId: r.teamId, host: this.hostOf(r.baseUrl), expiresAt: r.expiresAt });
    }
    return out;
  }

  /** Drop the stored credentials now. Only the member who connected may. */
  async disconnect(userId: string, sessionId: string): Promise<void> {
    const s = await this.requireSession(userId, sessionId, false);
    await this.prisma.importSession.delete({ where: { id: s.id } });
    await this.audit.log({ actor: userId, action: "import.beszel.disconnect", target: s.id });
  }

  // ── preview ──────────────────────────────────────────────────────────────────────────────────────────────────────
  async preview(userId: string, input: BeszelPreviewInput): Promise<BeszelPreview> {
    const { session, source } = await this.open(userId, input.sessionId);
    const ctx = await this.plan(session.teamId, source, input.serverOverrides);
    const history = await this.historyPreview(source, ctx.view);
    await this.prisma.importSession.update({ where: { id: session.id }, data: { lastUsedAt: new Date() } });
    return { ...ctx.view, sessionId: session.id, host: this.hostOf(session.baseUrl), servers: ctx.servers.map((s) => ({ id: s.id, name: s.name })), history };
  }

  // ── apply ────────────────────────────────────────────────────────────────────────────────────────────────────────
  async apply(userId: string, input: BeszelApplyInput): Promise<BeszelApplyResult> {
    const { session, source } = await this.open(userId, input.sessionId);
    const g = await this.grants(userId, session.teamId);
    if ((input.parts.alerts && !g.alerts) || (input.parts.channels && !g.channels) || (input.parts.history && !g.history)) {
      throw new ForbiddenException("insufficient permission for this team"); // refused before anything is written
    }
    if (this.applying.has(session.id)) throw new ConflictException("an import is already running for this session");
    this.applying.add(session.id);
    try {
      const ctx = await this.plan(session.teamId, source, input.serverOverrides);
      if (ctx.view.hash !== input.previewHash) throw new ConflictException("the Beszel hub or this team changed since the preview — preview again and review");
      const chosen = input.systemIds ? new Set(input.systemIds) : null;
      const inScope = (systemId: string) => !chosen || chosen.has(systemId);
      const result: BeszelApplyResult = { channels: zero(), monitors: { ...zero(), covered: 0 }, history: { systems: 0, points: 0 }, failures: [], credentialsDropped: false };

      // 1. channels (their ids feed the alert monitors)
      const channelIds: string[] = [];
      const existing = await this.existingChannels(session.teamId);
      for (const c of ctx.view.channels) {
        const cfg = ctx.internals.channelConfigs.get(c.index);
        if (c.outcome === "skip" || !cfg) {
          result.channels.skipped++;
          continue;
        }
        if (c.outcome === "exists") {
          const found = existing.get(ctx.internals.channelKeys.get(c.index) ?? "");
          if (found) {
            channelIds.push(found.id);
            // a reused channel must also hear about a server going down, since the Status alert is covered by that
            const missing = STATUS_EVENTS.filter((e) => !found.eventTypes.includes(e));
            if (ctx.internals.hasStatusAlert && input.parts.channels && missing.length) {
              try {
                await this.notifications.update(userId, found.id, { eventTypes: [...found.eventTypes, ...missing] });
              } catch {
                result.failures.push({ kind: "channel", ref: String(c.index), reason: "error" });
              }
            }
          }
          result.channels.existing++;
          continue;
        }
        if (!input.parts.channels) {
          result.channels.skipped++;
          continue;
        }
        try {
          const created = await this.notifications.create(userId, {
            name: `Beszel · ${c.service} · ${c.label}`.slice(0, 120),
            type: cfg.type,
            teamId: session.teamId,
            config: cfg.config,
            eventTypes: ctx.internals.hasStatusAlert ? [...STATUS_EVENTS] : [],
          });
          channelIds.push(created.id);
          result.channels.created++;
        } catch (e) {
          result.channels.failed++;
          result.failures.push({ kind: "channel", ref: String(c.index), reason: e instanceof BadRequestException ? "rejected" : "error" });
        }
      }

      // 2. alert rules → metric monitors
      for (const a of ctx.view.alerts) {
        if (!inScope(a.systemId)) continue;
        if (a.outcome === "covered") result.monitors.covered++;
        else if (a.outcome === "exists") result.monitors.existing++;
        else if (a.outcome !== "create") result.monitors.skipped++;
        else if (!input.parts.alerts) result.monitors.skipped++;
        else {
          const m = ctx.internals.monitors.get(a.id);
          if (!m) {
            result.monitors.skipped++;
            continue;
          }
          try {
            await this.monitors.create(userId, {
              name: `${m.serverName} · ${metricLabel(m.metric)} ≥ ${m.limit}${m.unit ? (m.unit === "%" ? "%" : ` ${m.unit}`) : ""}`,
              type: "METRIC",
              teamId: session.teamId,
              serverId: m.serverId,
              metric: m.metric,
              ...(m.thresholdPct != null ? { thresholdPct: m.thresholdPct } : {}),
              ...(m.thresholdValue != null ? { thresholdValue: m.thresholdValue } : {}),
              intervalSec: m.intervalSec,
              retries: m.retries,
              channelIds,
            });
            result.monitors.created++;
          } catch (e) {
            result.monitors.failed++;
            result.failures.push({ kind: "alert", ref: a.id, reason: e instanceof BadRequestException || e instanceof ForbiddenException ? "rejected" : "error" });
          }
        }
      }

      // 3. history
      if (input.parts.history) {
        const matched = ctx.view.systems.filter((s) => s.match && inScope(s.id));
        await mapLimit(matched, 3, async (s) => {
          try {
            const { rows, before } = await this.historyRows(source, s.id, s.match!.serverId);
            // Long-range tier: every imported minute, folded to 5-minute buckets. The last 48 h also go to the
            // 1-minute tier, which serves the 24 h chart; older minutes would be pruned from it at once.
            // A 5-minute bucket that straddles `before` would be written from only its imported minutes and the
            // rollup (ON CONFLICT DO NOTHING) could never complete it, so only buckets that END at or before
            // `before` are written; the straddling one is folded later from Tugra's own minutes.
            const serverId = s.match!.serverId;
            const fiveEnd = Math.floor(before / 300_000) * 300_000;
            const five = toFiveMinute(rows).filter((r) => r.bucket.getTime() < fiveEnd);
            for (let i = 0; i < five.length; i += 500) {
              await this.prisma.metricRollup5m.createMany({ data: five.slice(i, i + 500).map((r) => ({ ...r, serverId })), skipDuplicates: true });
            }
            const recentFrom = Date.now() - metricTiers().rollup1mMs;
            const recent = rows.filter((r) => r.bucket.getTime() >= recentFrom);
            for (let i = 0; i < recent.length; i += 500) {
              await this.prisma.metricRollup.createMany({ data: recent.slice(i, i + 500).map((r) => ({ ...r, serverId })), skipDuplicates: true });
            }
            if (rows.length) {
              result.history.systems++;
              result.history.points += rows.length;
            }
          } catch {
            result.failures.push({ kind: "history", ref: s.id, reason: "error" });
          }
        });
      }

      // Credentials are dropped now unless the operator chose to keep them.
      const row = await this.prisma.importSession.findUnique({ where: { id: session.id }, select: { scopeKey: true } });
      if (row && row.scopeKey !== KEEP_MARK) {
        await this.prisma.importSession.delete({ where: { id: session.id } });
        result.credentialsDropped = true;
      }
      await this.audit.log({
        actor: userId,
        action: "import.beszel.apply",
        target: session.id,
        meta: { teamId: session.teamId, channels: result.channels, monitors: result.monitors, history: result.history, parts: input.parts },
      });
      return result;
    } finally {
      this.applying.delete(session.id);
    }
  }

  // ── internals ────────────────────────────────────────────────────────────────────────────────────────────────────
  private hostOf(baseUrl: string): string {
    try {
      return new URL(baseUrl).host;
    } catch {
      return "";
    }
  }

  private asBadRequest(e: unknown): BadRequestException {
    if (e instanceof BeszelError) return new BadRequestException({ code: e.code, message: e.message });
    return new BadRequestException({ code: "unreachable", message: e instanceof Error ? e.message : "could not reach Beszel" });
  }

  /** The owned, active, unexpired beszel session; re-checks the team permission. */
  private async requireSession(userId: string, sessionId: string, needGrants = true) {
    const s = await this.prisma.importSession.findUnique({ where: { id: sessionId } });
    if (!s || s.sourceKind !== BESZEL_SOURCE_KIND) throw new NotFoundException("import session not found");
    if (s.actorId !== userId) throw new ForbiddenException("not your import session");
    if (s.status !== "active" || s.expiresAt.getTime() < Date.now()) throw new BadRequestException("import session expired — connect again");
    if (needGrants) await this.grants(userId, s.teamId);
    return s;
  }

  private async open(userId: string, sessionId: string) {
    const session = await this.requireSession(userId, sessionId);
    let cred: { identity?: unknown; password?: unknown };
    try {
      cred = JSON.parse(this.crypto.decrypt(session.tokenEnc));
    } catch {
      throw new BadRequestException("import session could not be read — connect again");
    }
    if (typeof cred.identity !== "string" || typeof cred.password !== "string") throw new BadRequestException("import session could not be read — connect again");
    const source = this.factory(session.baseUrl);
    try {
      await source.login(cred.identity, cred.password);
    } catch (e) {
      throw this.asBadRequest(e);
    }
    return { session, source };
  }

  private async existingChannels(teamId: string): Promise<Map<string, { id: string; eventTypes: string[] }>> {
    const rows = await this.prisma.notificationChannel.findMany({ where: { teamId }, select: { id: true, type: true, configEnc: true, eventTypes: true } });
    const out = new Map<string, { id: string; eventTypes: string[] }>();
    for (const r of rows) {
      try {
        out.set(channelKey(r.type, JSON.parse(this.crypto.decrypt(r.configEnc)) as Record<string, unknown>), { id: r.id, eventTypes: r.eventTypes ?? [] });
      } catch {
        // a channel whose config cannot be read is never matched
      }
    }
    return out;
  }

  private async plan(teamId: string, source: BeszelSource, overrides: Record<string, string | null> | undefined) {
    let snapshot: BeszelSnapshot;
    try {
      snapshot = await source.snapshot();
    } catch (e) {
      throw this.asBadRequest(e);
    }
    const servers = await this.prisma.server.findMany({
      where: { teamId },
      select: { id: true, name: true, hostname: true, publicIp: true, publicIpv6: true, reportedIps: true },
      orderBy: { name: "asc" },
    });
    if (overrides) {
      const picks = Object.values(overrides).filter((v): v is string => !!v);
      if (picks.some((p) => !servers.some((s) => s.id === p))) throw new ForbiddenException("server does not belong to this team");
      if (new Set(picks).size !== picks.length) throw new BadRequestException("one server cannot be matched to two Beszel systems");
    }
    const [monitors, channelMap] = await Promise.all([
      this.prisma.monitor.findMany({ where: { teamId, type: "METRIC" }, select: { serverId: true, metric: true, auto: true, thresholdPct: true, thresholdValue: true, retries: true } }),
      this.existingChannels(teamId),
    ]);
    const built = buildPlan({ ...snapshot, servers, overrides, existingMonitors: monitors, existingChannelKeys: new Set(channelMap.keys()) });
    return { ...built, servers };
  }

  private rollupDays(): number {
    const d = Number(this.config.get("METRICS_ROLLUP_RETENTION_DAYS") ?? 28);
    return Math.min(28, Number.isFinite(d) && d > 0 ? d : 28);
  }

  /** The rollup rows to write for one system: never over a bucket Tugra holds, never older than Tugra keeps them. */
  private async historyRows(source: BeszelSource, systemId: string, serverId: string) {
    const now = Date.now();
    const windowDays = this.rollupDays();
    const [rawFirst, rollFirst, roll5mFirst] = await Promise.all([
      this.prisma.metric.findFirst({ where: { serverId }, orderBy: { ts: "asc" }, select: { ts: true } }),
      this.prisma.metricRollup.findFirst({ where: { serverId }, orderBy: { bucket: "asc" }, select: { bucket: true } }),
      this.prisma.metricRollup5m.findFirst({ where: { serverId }, orderBy: { bucket: "asc" }, select: { bucket: true } }),
    ]);
    const before = Math.min(now, rawFirst?.ts.getTime() ?? now, rollFirst?.bucket.getTime() ?? now, roll5mFirst?.bucket.getTime() ?? now);
    const records = await source.stats(systemId, STATS_TYPES);
    return { rows: buildHistory(records, { now, before, floor: now - windowDays * 86_400_000 }), windowDays, before };
  }

  private async historyPreview(source: BeszelSource, view: PlanView): Promise<HistoryPreview> {
    const matched = view.systems.filter((s) => s.match);
    const windowDays = this.rollupDays();
    const systems = await mapLimit(matched, 3, async (s) => {
      try {
        const { rows } = await this.historyRows(source, s.id, s.match!.serverId);
        return { systemId: s.id, serverId: s.match!.serverId, points: rows.length, from: rows[0]?.bucket.toISOString() ?? null, to: rows[rows.length - 1]?.bucket.toISOString() ?? null };
      } catch {
        return { systemId: s.id, serverId: s.match!.serverId, points: 0, from: null, to: null };
      }
    });
    return { windowDays, totalPoints: systems.reduce((n, s) => n + s.points, 0), systems };
  }
}
