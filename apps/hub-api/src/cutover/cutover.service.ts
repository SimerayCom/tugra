import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Prisma, type CutoverDomain } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { ImportExecutorService } from "../importer/import-executor.service";
import { DnsAutomationService } from "../dns/dns-automation.service";
import { DnsCredentialsService } from "../dns/dns-credentials.service";
import { DnsLookupService } from "../dns/dns-lookup.service";
import { ProxyConfigService } from "../proxy-config/proxy-config.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { APPLICATIONS_SERVICE } from "../applications/applications.tokens";
import type { ApplicationsService } from "../applications/applications.service";
import { validateAcmeEmail } from "../deploy/panel-router";
import { isAlwaysBlockedIp, isIpv6, isPublicIp } from "../common/observed-ip";
import { onHostNetwork } from "../common/host-exec";
import { NetProbe } from "./net-probe";
import { buildAcmeDiagScript, buildCutoverLoopbackProbeScript, parseAcmeDiagMarkers, parseCutoverProbeMarkers } from "./cutover-scripts";
import {
  canTransition, caaAllowsLetsEncrypt, classifyHealth, classifyObserved, counterpartOf, deriveEntries, earliestFlip, isStateful, planHash as computePlanHash, planRecords,
  REVERTIBLE, sanitizeText, sslModeVerdict, stepAction, ttlGuidance, classifyPort80, HEALTH_PRE_EXISTING_TAG, SOURCE_DEGRADED_TAG, isExcusableHealth,
  type CutoverState, type DnsObserved, type LedgerRecord, type ProviderRec, type TargetIps,
} from "./cutover.logic";
import type {
  CutoverCertPrepInput, CutoverCheckInput, CutoverExcludeInput, CutoverFinalizeInput, CutoverFixCounterpartInput, CutoverFlipInput, CutoverFlipPlanQuery,
  CutoverInitInput, CutoverRevertInput, CutoverTtlInput, CutoverView, CutoverEntryView, FlipPlan, FlipPlanRecord,
} from "./cutover.dto";

export const PRECHECK_FRESH_MS = 15 * 60 * 1000;
export const STALE_SWITCHING_MS = 3 * 60 * 1000;
export const RUN_DEAD_MS = 90 * 1000;
const VERIFY_ATTEMPTS = 6;
const VERIFY_BACKOFF_MS = 10_000;
const DEFAULT_BATCH = 5;
const DEFAULT_INTERVAL_SEC = 30;
const DEFAULT_TARGET_TTL = 60;
const PRE_FLIP: CutoverState[] = ["PLANNED", "CERT_PENDING", "CERT_READY", "READY"];/** Block reasons that only exist because DNS-01 could not be used for the host. */
const DNS01_BLOCK_REASONS = ["zone-not-covered", "no-dns-credential", "caa-blocks-letsencrypt"];

interface AppRow {
  id: string;
  name: string;
  teamId: string;
  serverId: string;
  clusterId: string | null;
  domain: string | null;
  extraDomains: string[];
  domainRedirect: string | null;
  dnsChallenge: boolean;
}

interface OpCtx {
  op: { id: string; meta: unknown; cancelRequestedAt: Date | null; tasks: Array<{ itemRef: string | null; kind: string; status: string; dependsOn: string[]; resourceType: string | null; resourceId: string | null; result: unknown }> };
  appIds: string[];
  names: Map<string, string>; // appId -> source name (from the import task)
  itemRefByApp: Map<string, string>;
}

interface FlipParams {
  batchSize: number;
  intervalSec: number;
  targetTtl: number;
  stopOnFail: boolean;
  autoRevert: boolean;
  keepProxied: boolean;
  acceptDataRisk: boolean;
  acceptHttp01Gap: boolean;
  skipTtlWait: boolean;
}

interface PlannedEntry {
  entry: CutoverDomain;
  steps: LedgerRecord[];
  warnings: string[];
  blocked: string | null;
  manual: boolean;
}

/**
 * SSL/DNS cutover of an imported app's hostnames from the source PaaS to Tugra. Per hostname it tracks
 * PLANNED -> CERT_PENDING -> CERT_READY -> READY -> SWITCHING -> SWITCHED -> VERIFIED, pre-issues the certificate on
 * the dark Tugra server (DNS-01 per host where a Cloudflare credential covers the zone), proves the app answers
 * through the Tugra proxy (Host header + SNI straight at the server IP), then flips the Cloudflare records in
 * paced batches with a rollback ledger. It never promises zero downtime, never flips a record it did not plan,
 * fails closed on any probe or provider doubt, and reverts only on an explicit request (autoRevert is OFF).
 */
@Injectable()
export class CutoverService {
  private readonly log = new Logger(CutoverService.name);
  /** Test seam: the pause between batches and verify attempts. */
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));
  /** The in-flight background run (awaited by tests through {@link idle}). */
  private running: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly executor: ImportExecutorService,
    private readonly dnsAuto: DnsAutomationService,
    private readonly creds: DnsCredentialsService,
    private readonly lookup: DnsLookupService,
    private readonly probe: NetProbe,
    private readonly proxyConfig: ProxyConfigService,
    private readonly agentWs: AgentWsServer,
    @Inject(APPLICATIONS_SERVICE) private readonly apps: ApplicationsService,
  ) {}

  /** Resolves when the current background flip run (if any) has finished. */
  async idle(): Promise<void> {
    while (this.running) await this.running.catch(() => undefined);
  }

  // ── context + authz ────────────────────────────────────────────────────────────────────────

  private async ctx(userId: string, opId: string): Promise<OpCtx> {
    const op = await this.executor.ownedOpForCutover(userId, opId);
    const meta = typeof op.meta === "object" && op.meta ? (op.meta as { rolledBackAt?: string }) : {};
    if (meta.rolledBackAt) throw new ConflictException("operation was rolled back");
    // A compose "service" the import created is an application too (it serves hostnames through its service domains).
    const appTasks = op.tasks.filter((t) => (t.kind === "app" || t.kind === "service") && t.status === "DONE" && t.resourceType === "application" && !!t.resourceId);
    const names = new Map<string, string>();
    const itemRefByApp = new Map<string, string>();
    for (const t of appTasks) {
      const r = typeof t.result === "object" && t.result ? (t.result as { name?: string }) : {};
      if (r.name) names.set(t.resourceId!, r.name);
      if (t.itemRef) itemRefByApp.set(t.resourceId!, t.itemRef);
    }
    return { op: op as OpCtx["op"], appIds: appTasks.map((t) => t.resourceId!), names, itemRefByApp };
  }

  private async loadApps(ids: string[]): Promise<Map<string, AppRow>> {
    const rows = await this.prisma.application.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, teamId: true, serverId: true, clusterId: true, domain: true, extraDomains: true, domainRedirect: true, dnsChallenge: true },
    });
    return new Map((rows as AppRow[]).map((a) => [a.id, a]));
  }

  /** Mutations need `apps:config` on EVERY touched app's team. */
  private async requireConfig(userId: string, appIds: Iterable<string>, apps: Map<string, AppRow>): Promise<void> {
    const teams = new Set<string>();
    for (const id of appIds) {
      const a = apps.get(id);
      if (a) teams.add(a.teamId);
    }
    for (const t of teams) await this.access.requirePermission(userId, t, "apps:config");
  }

  private async entries(opId: string, hostnames?: string[], states?: CutoverState[]): Promise<CutoverDomain[]> {
    const rows = await this.prisma.cutoverDomain.findMany({
      where: { opId, ...(hostnames ? { hostname: { in: hostnames } } : {}), ...(states ? { state: { in: states } } : {}) },
      orderBy: [{ hostname: "asc" }],
    });
    return rows;
  }

  private async cas(id: string, from: CutoverState | readonly CutoverState[], to: CutoverState, data: Prisma.CutoverDomainUncheckedUpdateManyInput = {}): Promise<boolean> {
    const froms: CutoverState[] = Array.isArray(from) ? [...(from as readonly CutoverState[])] : [from as CutoverState];
    const legal = froms.filter((f) => canTransition(f, to));
    if (legal.length === 0) throw new Error(`illegal cutover transition ${froms.join("|")} -> ${to}`);
    const r = await this.prisma.cutoverDomain.updateMany({ where: { id, state: { in: legal } }, data: { ...data, state: to } });
    return r.count === 1;
  }

  private async set(id: string, data: Prisma.CutoverDomainUncheckedUpdateInput): Promise<void> {
    await this.prisma.cutoverDomain.update({ where: { id }, data });
  }

  private async auditLog(userId: string, action: string, opId: string, meta: Record<string, unknown>): Promise<void> {
    await this.audit.log({ actor: userId, action, target: opId, meta }).catch(() => undefined);
  }

  // ── server facts ───────────────────────────────────────────────────────────────────────────

  private async targetIps(serverId: string): Promise<TargetIps> {
    const s = await this.prisma.server.findUnique({ where: { id: serverId }, select: { publicIp: true, publicIpv6: true } });
    const ok = (ip: string | null | undefined): ip is string => !!ip && isPublicIp(ip) && !isAlwaysBlockedIp(ip);
    return {
      v4: ok(s?.publicIp) && !isIpv6(s!.publicIp!) ? [s!.publicIp!] : [],
      v6: ok(s?.publicIpv6) && isIpv6(s!.publicIpv6!) ? [s!.publicIpv6!] : [],
    };
  }

  private async serverFacts(serverId: string): Promise<{ name: string; ips: TargetIps; proxyBind: string; acmeEmailOk: boolean; dnsReady: boolean; dnsProvider: string | null; dnsCredentialId: string | null }> {
    const s = await this.prisma.server.findUnique({ where: { id: serverId }, select: { name: true, proxyBind: true, dnsCredentialId: true } });
    if (!s) throw new NotFoundException("target server not found");
    const cfg = await this.proxyConfig.resolveFor(serverId).catch(() => null);
    let acmeEmailOk = false;
    try {
      validateAcmeEmail(cfg?.acmeEmail ?? "");
      acmeEmailOk = true;
    } catch {
      acmeEmailOk = false;
    }
    const dnsReady = !!cfg?.dnsProvider && !!cfg.dnsCreds && Object.keys(cfg.dnsCreds).length > 0;
    return { name: s.name, ips: await this.targetIps(serverId), proxyBind: s.proxyBind, acmeEmailOk, dnsReady, dnsProvider: cfg?.dnsProvider ?? null, dnsCredentialId: s.dnsCredentialId };
  }

  // ── observe one entry (DNS side) ───────────────────────────────────────────────────────────

  private async observe(
    userId: string,
    e: CutoverDomain,
    ips: TargetIps,
  ): Promise<{ recs: ProviderRec[] | null; observed: DnsObserved; proxied: boolean; tunnel: boolean; viaWildcard: boolean; ttl: number | null }> {
    if (e.dnsMode === "cloudflare" && e.dnsCredentialId && e.zoneId) {
      const all = await this.dnsAuto.listRecordsFor(userId, e.dnsCredentialId, e.zoneId, e.hostname);
      const at = all.filter((r) => r.type === "A" || r.type === "AAAA" || r.type === "CNAME");
      const tunnel = at.some((r) => r.type === "CNAME" && /\.cfargotunnel\.com\.?$/i.test(r.content));
      const proxied = at.some((r) => r.proxied);
      let viaWildcard = false;
      if (at.length === 0) viaWildcard = (await this.lookup.resolve4(e.hostname).catch(() => [])).length > 0;
      const addrs = at.filter((r) => r.type === "A" || r.type === "AAAA").map((r) => r.content);
      const ttl = at.find((r) => r.type === "A")?.ttl ?? at[0]?.ttl ?? null;
      return { recs: all, observed: classifyObserved(addrs, ips, { proxied, tunnel }), proxied, tunnel, viaWildcard, ttl };
    }
    const [a, aaaa] = await Promise.all([this.lookup.resolve4(e.hostname).catch(() => []), this.lookup.resolve6(e.hostname).catch(() => [])]);
    const auth = await this.lookup.resolveAuthoritative(e.hostname, "A").catch(() => ({ addresses: [] as string[], ttl: null as number | null, ns: [] as string[] }));
    return { recs: null, observed: classifyObserved([...a, ...aaaa], ips, { proxied: false, tunnel: false }), proxied: false, tunnel: false, viaWildcard: false, ttl: auth.ttl };
  }

  // ── init ───────────────────────────────────────────────────────────────────────────────────

  /**
   * Derive (or refresh) the tracked hostnames from the op's DONE app tasks: primary, alias, compose service domains
   * and an evidenced www/bare counterpart. Idempotent upsert on (op, app, host). Entries already past READY are never
   * rewritten, only their warnings refreshed. Writes NOTHING to any DNS provider.
   */
  async init(userId: string, opId: string, input: CutoverInitInput): Promise<CutoverView> {
    const c = await this.ctx(userId, opId);
    const apps = await this.loadApps(c.appIds);
    await this.requireConfig(userId, apps.keys(), apps);
    if (input.dnsCredentialId) {
      const cred = await this.creds.resolveToken(userId, input.dnsCredentialId);
      if (cred.provider !== "cloudflare") throw new BadRequestException("only the cloudflare provider is supported");
    }
    const zoneCache = new Map<string, { credId: string; zoneId: string; zoneName: string; sslMode: string }>();
    let created = 0;

    for (const appId of c.appIds) {
      const app = apps.get(appId);
      if (!app) continue;
      const svc = await this.prisma.appServiceDomain.findMany({ where: { applicationId: appId }, select: { hostname: true } });
      const derived = deriveEntries(app, svc.map((s) => s.hostname));
      const ips = app.clusterId ? { v4: [], v6: [] } : await this.targetIps(app.serverId);
      const credIds = input.dnsCredentialId ? [input.dnsCredentialId] : (await this.creds.cloudflareCredentialsForTeam(app.teamId)).map((x) => x.id);
      const stateful = isStateful(c.itemRefByApp.get(appId) ?? null, c.op.tasks);

      const zoneFor = async (host: string) => {
        for (const z of zoneCache.values()) if (host === z.zoneName || host.endsWith(`.${z.zoneName}`)) if (credIds.includes(z.credId)) return z;
        for (const credId of credIds) {
          const found = await this.dnsAuto.findZoneFor(userId, credId, host).catch(() => null);
          if (found) {
            const z = { credId, zoneId: found.zoneId, zoneName: found.zoneName, sslMode: found.sslMode };
            zoneCache.set(`${credId}:${found.zoneName}`, z);
            return z;
          }
        }
        return null;
      };

      const rows: Array<{ hostname: string; role: string; blockReason?: string; excluded?: boolean }> = [...derived];
      // www/bare counterpart: ONLY with evidence (it already resolves like the primary), or when a redirect already serves it.
      const primary = derived.find((d) => d.role === "primary");
      if (primary && !app.clusterId) {
        const z = await zoneFor(primary.hostname);
        const cp = counterpartOf(primary.hostname, z?.zoneName ?? null);
        if (cp && !rows.some((r) => r.hostname === cp)) {
          const [pa, ca] = await Promise.all([this.lookup.resolve4(primary.hostname).catch(() => [] as string[]), this.lookup.resolve4(cp).catch(() => [] as string[])]);
          const evidence = pa.length > 0 && ca.length > 0 && pa.slice().sort().join() === ca.slice().sort().join();
          if (evidence || app.domainRedirect) rows.push({ hostname: cp, role: "counterpart", ...(app.domainRedirect ? {} : { blockReason: "counterpart-not-served" }) });
        }
      }

      for (const d of rows) {
        let existing = await this.prisma.cutoverDomain.findUnique({ where: { opId_applicationId_hostname: { opId, applicationId: appId, hostname: d.hostname } } });
        if (existing?.state === "ROLLED_BACK" && (await this.cas(existing.id, "ROLLED_BACK", "PLANNED", { lastError: null }))) existing = { ...existing, state: "PLANNED" };
        if (existing && !PRE_FLIP.includes(existing.state as CutoverState) && existing.state !== "BLOCKED" && existing.state !== "CONFLICT") {
          await this.set(existing.id, { stateful });
          continue;
        }
        const z = app.clusterId ? null : await zoneFor(d.hostname);
        const base: Prisma.CutoverDomainUncheckedCreateInput = {
          opId, applicationId: appId, hostname: d.hostname, role: d.role,
          dnsMode: z ? "cloudflare" : "manual", dnsCredentialId: z?.credId ?? null, zoneId: z?.zoneId ?? null, sslMode: z?.sslMode ?? null,
          challenge: app.dnsChallenge ? "dns01" : "http01", targetIps: ips as unknown as Prisma.InputJsonValue, stateful,
        };
        const entry = existing ?? (await this.prisma.cutoverDomain.create({ data: base }));
        if (!existing) created++;
        const warnings: string[] = [];
        let blockReason: string | null = d.blockReason ?? null;
        let state: CutoverState = existing ? (existing.state as CutoverState) : "PLANNED";
        let observed: DnsObserved = "unknown";
        let proxied: boolean | null = null;
        let viaWildcard = false;
        let originalTtl: number | null = existing?.originalTtl ?? null;
        if (!app.clusterId) {
          const probeEntry = { ...entry, ...base } as CutoverDomain;
          try {
            const o = await this.observe(userId, probeEntry, ips);
            observed = o.observed;
            proxied = o.proxied;
            viaWildcard = o.viaWildcard;
            originalTtl = originalTtl ?? o.ttl;
            if (o.tunnel) blockReason = "tunnel-routed";
          } catch {
            warnings.push("dns-lookup-failed");
          }
          if (z && !blockReason) {
            try {
              if (await this.dnsAuto.caaBlocksLetsEncrypt(userId, z.credId, z.zoneId, z.zoneName, d.hostname)) warnings.push("caa");
            } catch {
              /* not blocking */
            }
          }
          if (ips.v4.length === 0) blockReason = blockReason ?? "no-target-ip";
        }
        if (!z && !app.clusterId) warnings.push("manual-dns");
        if (z && proxied) {
          const v = sslModeVerdict(z.sslMode);
          if (v !== "ok") warnings.push(`ssl-mode-${v === "unknown" ? "unknown" : v === "bad" ? "bad" : "weak"}`);
        }
        if (app.clusterId) blockReason = "cluster-app";
        if (!existing) {
          if (blockReason) state = "BLOCKED";
          else if (d.excluded) {
            state = "EXCLUDED";
            blockReason = "generated-host";
          }
        } else if (blockReason && state !== "BLOCKED") state = "BLOCKED";
        else if (!blockReason && state === "BLOCKED" && ["tunnel-routed", "no-target-ip", "cluster-app"].includes(existing.blockReason ?? "")) state = "PLANNED";
        await this.set(entry.id, {
          state, blockReason, dnsObserved: observed, proxied, viaWildcard, originalTtl, warnings,
          dnsMode: base.dnsMode, dnsCredentialId: base.dnsCredentialId, zoneId: base.zoneId, sslMode: base.sslMode, stateful, challenge: base.challenge,
          targetIps: ips as unknown as Prisma.InputJsonValue,
        });
      }
    }
    await this.auditLog(userId, "cutover.init", opId, { apps: c.appIds.length, created });
    return this.view(userId, opId);
  }

  // ── view + settle ──────────────────────────────────────────────────────────────────────────

  /** Settle what a crash may have left (stale SWITCHING rows, a dead run) — called before any view and any new run. */
  async settle(userId: string, opId: string): Promise<void> {
    const now = Date.now();
    const dead = await this.prisma.cutoverRun.findMany({ where: { opId, activeKey: { not: null }, heartbeatAt: { lt: new Date(now - RUN_DEAD_MS) } } });
    for (const r of dead) {
      await this.prisma.cutoverRun.update({ where: { id: r.id }, data: { activeKey: null, finishedAt: new Date(), status: r.status === "running" ? "halted" : r.status, lastError: r.status === "running" ? "run stopped (hub restart or crash)" : r.lastError } });
    }
    const stale = await this.prisma.cutoverDomain.findMany({ where: { opId, state: "SWITCHING", updatedAt: { lt: new Date(now - STALE_SWITCHING_MS) } } });
    for (const e of stale) {
      let next: CutoverState = "CONFLICT";
      let reason: string | null = "record-changed";
      try {
        const steps = Array.isArray(e.ledger) ? (e.ledger as unknown as LedgerRecord[]) : [];
        if (e.dnsCredentialId && e.zoneId && steps.length) {
          const recs = await this.dnsAuto.listRecordsFor(userId, e.dnsCredentialId, e.zoneId, e.hostname);
          const isNew = steps.every((s) => {
            const a = stepAction(s);
            if (a === "noop") return true;
            if (a === "delete") return !recs.some((r) => r.id === s.recordId);
            return recs.some((r) => (a === "update" ? r.id === s.recordId : true) && r.type === s.type && r.content === s.new!.content && r.proxied === s.new!.proxied);
          });
          const isOld = steps.every((s) => {
            const a = stepAction(s);
            if (a === "noop") return true;
            if (a === "create") return !recs.some((r) => r.type === s.type && r.content === s.new!.content);
            return recs.some((r) => r.id === s.recordId && r.content === s.old!.content && r.proxied === s.old!.proxied);
          });
          if (isNew) {
            next = "SWITCHED";
            reason = null;
          } else if (isOld) {
            next = "READY";
            reason = null;
          }
        }
      } catch {
        next = "CONFLICT";
      }
      await this.cas(e.id, "SWITCHING", next, { blockReason: reason, lastError: next === "CONFLICT" ? "the provider records changed during an interrupted flip; check them before retrying" : null, ...(next === "SWITCHED" ? { flippedAt: new Date() } : {}) });
    }
  }

  async view(userId: string, opId: string): Promise<CutoverView> {
    const c = await this.ctx(userId, opId);
    await this.settle(userId, opId);
    const rows = await this.entries(opId);
    const apps = await this.loadApps([...new Set(rows.map((r) => r.applicationId))]);
    const serverIds = [...new Set([...apps.values()].map((a) => a.serverId))];
    const servers: CutoverView["servers"] = [];
    for (const sid of serverIds) {
      const f = await this.serverFacts(sid).catch(() => null);
      if (!f) continue;
      const s = await this.prisma.server.findUnique({ where: { id: sid }, select: { publicIp: true, publicIpv6: true } });
      const warnings: string[] = [];
      if (!f.acmeEmailOk) warnings.push("acme-email");
      if (!f.dnsReady) warnings.push("dns01-not-ready");
      if (f.proxyBind !== "public") warnings.push("port-80-bind");
      if (f.ips.v4.length === 0 && f.ips.v6.length === 0) warnings.push("public-ip");
      if (f.dnsReady && !f.dnsCredentialId) warnings.push("coverage-unverified");
      servers.push({
        serverId: sid, name: f.name, publicIp: s?.publicIp ?? null, publicIpv6: s?.publicIpv6 ?? null, proxyBind: f.proxyBind, acmeEmailOk: f.acmeEmailOk, dnsReady: f.dnsReady,
        dnsProvider: f.dnsProvider, dnsCredentialId: f.dnsCredentialId, coverage: f.dnsCredentialId ? "verified" : f.dnsReady ? "unverified" : "none", warnings,
      });
    }
    const run = await this.prisma.cutoverRun.findFirst({ where: { opId }, orderBy: { startedAt: "desc" } });
    const cnt = (...st: CutoverState[]) => rows.filter((r) => st.includes(r.state as CutoverState)).length;
    const [staged, applied] = await Promise.all([
      this.prisma.cutoverCert.count({ where: { opId, appliedAt: null } }),
      this.prisma.cutoverCert.count({ where: { opId, appliedAt: { not: null } } }),
    ]);
    return {
      opId,
      run: run ? { id: run.id, status: run.status, batchesDone: run.batchesDone, total: run.total, startedAt: run.startedAt.toISOString(), heartbeatAt: run.heartbeatAt.toISOString(), lastError: run.lastError } : null,
      summary: {
        total: rows.length, planned: cnt("PLANNED", "CERT_PENDING"), certReady: cnt("CERT_READY"), ready: cnt("READY"), switched: cnt("SWITCHED", "SWITCHING"), verified: cnt("VERIFIED"),
        blocked: cnt("BLOCKED"), conflict: cnt("CONFLICT"), failed: cnt("VERIFY_FAILED"), excluded: cnt("EXCLUDED"),
      },
      servers,
      entries: rows.map((e) => this.toEntryView(e, apps.get(e.applicationId), c.names.get(e.applicationId) ?? null)),
      certs: { staged, applied },
    };
  }

  private toEntryView(e: CutoverDomain, app: AppRow | undefined, sourceName: string | null): CutoverEntryView {
    const iso = (d: Date | null) => (d ? d.toISOString() : null);
    return {
      id: e.id, applicationId: e.applicationId, appName: app?.name ?? "", hostname: e.hostname, role: e.role, state: e.state, blockReason: e.blockReason, dnsMode: e.dnsMode,
      challenge: e.challenge, certState: e.certState, certIssuer: e.certIssuer, certNotAfter: iso(e.certNotAfter), certError: e.certError, dnsObserved: e.dnsObserved, proxied: e.proxied,
      viaWildcard: e.viaWildcard, sslMode: e.sslMode, currentTtl: e.ttlLoweredAt ? e.targetTtl : e.originalTtl, targetTtl: e.targetTtl, ttlWaitUntil: iso(e.earliestFlipAt),
      stateful: e.stateful, needsDeploy: e.needsDeploy, warnings: (e.warnings ?? []).filter((w) => w !== SOURCE_DEGRADED_TAG), precheckAt: iso(e.precheckAt), flippedAt: iso(e.flippedAt), verifiedAt: iso(e.verifiedAt),
      finalizedAt: iso(e.finalizedAt), lastError: e.lastError, sourceName,
    };
  }

  // ── certificate preparation ────────────────────────────────────────────────────────────────

  /**
   * Choose the challenge per app: dns01 turns on the app's per-host DNS-01 flag (setDomainOptions re-checks the
   * server really has DNS-01 credentials), http01 turns it off. A host the server's credential cannot see, or a
   * CAA policy that forbids Let's Encrypt, is BLOCKED instead of silently half-configured. It does not deploy:
   * `needsDeploy` tells the UI the labels change on the next deploy.
   */
  async certPrepare(userId: string, opId: string, input: CutoverCertPrepInput, opts: { unblockDnsBlocked?: boolean } = {}): Promise<CutoverView & { blocked: Array<{ hostname: string; reason: string }> }> {
    const c = await this.ctx(userId, opId);
    const rows = (await this.entries(opId, input.hostnames)).filter((r) => PRE_FLIP.includes(r.state as CutoverState) || r.state === "BLOCKED");
    const apps = await this.loadApps([...new Set(rows.map((r) => r.applicationId))]);
    await this.requireConfig(userId, apps.keys(), apps);
    const blocked: Array<{ hostname: string; reason: string }> = [];
    const byApp = new Map<string, CutoverDomain[]>();
    for (const r of rows) byApp.set(r.applicationId, [...(byApp.get(r.applicationId) ?? []), r]);

    for (const [appId, list] of byApp) {
      const app = apps.get(appId)!;
      if (input.challenge === "http01") {
        await this.apps.setDomainOptions(userId, appId, { dnsChallenge: false });
        for (const e of list) {
          // Additive (migration runs): an explicit HTTP-01 choice also lifts a block that was only about DNS-01 (the host
          // is then READY for the accepted HTTP-01 gap); without the option the block stays, as before.
          if (opts.unblockDnsBlocked && e.state === "BLOCKED" && DNS01_BLOCK_REASONS.includes(e.blockReason ?? "")) await this.cas(e.id, "BLOCKED", "PLANNED", { blockReason: null });
          await this.set(e.id, { challenge: "http01", needsDeploy: true });
        }
        continue;
      }
      const facts = await this.serverFacts(app.serverId);
      let failReason: string | null = null;
      if (list.some((e) => e.warnings?.includes("caa"))) failReason = "caa-blocks-letsencrypt";
      else if (!facts.dnsReady) failReason = "no-dns-credential";
      else if (facts.dnsCredentialId) {
        for (const e of list) {
          const z = await this.dnsAuto.findZoneFor(userId, facts.dnsCredentialId, e.hostname).catch(() => null);
          if (!z) {
            failReason = "zone-not-covered";
            break;
          }
        }
      }
      if (failReason) {
        for (const e of list) {
          blocked.push({ hostname: e.hostname, reason: failReason });
          if (e.state === "BLOCKED") await this.set(e.id, { blockReason: failReason });
          else await this.cas(e.id, e.state as CutoverState, "BLOCKED", { blockReason: failReason }).catch(() => false);
        }
        continue;
      }
      try {
        await this.apps.setDomainOptions(userId, appId, { dnsChallenge: true });
      } catch (err) {
        const msg = sanitizeText((err as Error).message, 200);
        for (const e of list) {
          blocked.push({ hostname: e.hostname, reason: "no-dns-credential" });
          await this.set(e.id, { lastError: msg });
        }
        continue;
      }
      for (const e of list) {
        const warnings = new Set(e.warnings ?? []);
        if (!facts.dnsCredentialId) warnings.add("coverage-unverified");
        const wasBlocked = e.state === "BLOCKED" && (e.blockReason === "zone-not-covered" || e.blockReason === "no-dns-credential" || e.blockReason === "caa-blocks-letsencrypt");
        if (wasBlocked) await this.cas(e.id, "BLOCKED", "PLANNED", { blockReason: null });
        await this.set(e.id, { challenge: "dns01", needsDeploy: true, warnings: [...warnings] });
      }
    }
    await this.auditLog(userId, "cutover.prepare", opId, { challenge: input.challenge, hosts: rows.length, blocked: blocked.length });
    return { ...(await this.view(userId, opId)), blocked };
  }

  // ── check (probes) ─────────────────────────────────────────────────────────────────────────

  /**
   * Read-only toward DNS: observe where each host resolves, handshake with the target proxy for the host's own
   * certificate, and fetch the health path through it with the Host header. Concurrency 4, serialized per target IP.
   * Promotes PLANNED/CERT_PENDING -> CERT_READY -> READY, demotes a READY entry whose re-check fails, and (for
   * entries already flipped) retries the verification.
   */
  async check(userId: string, opId: string, input: CutoverCheckInput, opts: { degradedAtSource?: readonly string[] } = {}): Promise<CutoverView> {
    const c = await this.ctx(userId, opId);
    if (opts.degradedAtSource) await this.syncSourceDegraded(opId, opts.degradedAtSource);
    const rows = (await this.entries(opId, input.hostnames)).filter((r) => !["EXCLUDED", "BLOCKED", "CONFLICT", "REVERTING", "ROLLED_BACK", "SWITCHING"].includes(r.state));
    const apps = await this.loadApps([...new Set(rows.map((r) => r.applicationId))]);
    await this.requireConfig(userId, apps.keys(), apps);
    const path = input.healthPath ?? "/";
    const chains = new Map<string, Promise<unknown>>();
    const queue = [...rows];
    const worker = async () => {
      for (let e = queue.shift(); e; e = queue.shift()) {
        const app = apps.get(e.applicationId);
        if (!app) continue;
        const ips = await this.targetIps(app.serverId);
        const key = ips.v4[0] ?? ips.v6[0] ?? "none";
        const prev = chains.get(key) ?? Promise.resolve();
        const run = prev.then(() => this.checkOne(userId, e!, app, ips, input.probeVia ?? "hub", path)).catch((err) => this.log.warn(`cutover check failed for ${e!.hostname}: ${sanitizeText((err as Error).message, 120)}`));
        chains.set(key, run);
        await run;
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, rows.length) }, () => worker()));
    await this.auditLog(userId, "cutover.check", opId, { hosts: rows.length });
    return this.view(userId, opId);
  }

  /**
   * The guided run's source health baseline (R52): mark the hosts whose app was ALREADY failing at the source (and clear the mark from
   * every other host). A marked host whose app answers with a failing status on Tugra is excused from the health test only (see
   * {@link isExcusableHealth}); the certificate, DNS and "no answer at all" tests still apply, and the excuse shows as a warning.
   */
  private async syncSourceDegraded(opId: string, hostnames: readonly string[]): Promise<void> {
    const want = new Set(hostnames);
    for (const e of await this.entries(opId)) {
      const has = (e.warnings ?? []).includes(SOURCE_DEGRADED_TAG);
      if (want.has(e.hostname) === has) continue;
      const rest = (e.warnings ?? []).filter((w) => w !== SOURCE_DEGRADED_TAG);
      await this.set(e.id, { warnings: want.has(e.hostname) ? [...rest, SOURCE_DEGRADED_TAG] : rest });
    }
  }

  private async checkOne(userId: string, e: CutoverDomain, app: AppRow, ips: TargetIps, via: "hub" | "agent", path: string): Promise<void> {
    const ip = ips.v4[0] ?? ips.v6[0];
    if (!ip) {
      await this.cas(e.id, e.state as CutoverState, "BLOCKED", { blockReason: "no-target-ip" }).catch(() => false);
      return;
    }
    const patch: Prisma.CutoverDomainUncheckedUpdateInput = { targetIps: ips as unknown as Prisma.InputJsonValue };
    // 1. DNS
    let observed: DnsObserved = e.dnsObserved as DnsObserved;
    try {
      const o = await this.observe(userId, e, ips);
      observed = o.observed;
      patch.dnsObserved = o.observed;
      patch.proxied = o.proxied;
      patch.viaWildcard = o.viaWildcard;
      if (o.tunnel) {
        await this.cas(e.id, e.state as CutoverState, "BLOCKED", { ...patch, blockReason: "tunnel-routed" }).catch(() => false);
        return;
      }
      if (e.originalTtl == null && o.ttl != null) patch.originalTtl = o.ttl;
    } catch {
      /* keep the previous observation */
    }
    if (e.dnsMode === "cloudflare" && e.dnsCredentialId && e.zoneId && e.state !== "SWITCHED" && e.state !== "VERIFIED") {
      patch.sslMode = await this.dnsAuto.zoneSslMode(userId, e.dnsCredentialId, e.zoneId).catch(() => e.sslMode ?? "unknown");
    }
    // 2. certificate on the TARGET (SNI straight at its IP)
    const ssl = await this.probe.sslAt(ip, e.hostname).catch(() => null);
    const certReady = !!ssl && ssl.ok && (ssl.daysRemaining ?? 0) >= 14;
    patch.certState = ssl ? (ssl.ok ? (certReady ? "ready" : "pending") : ssl.reason === "default-cert" || ssl.reason === "connect" || ssl.reason === "timeout" ? "pending" : ssl.reason === "untrusted" ? "untrusted" : ssl.reason === "wrong-host" ? "wrong-host" : ssl.reason === "expired" ? "expired" : "error") : "error";
    if (ssl?.reason === "default-cert") patch.certState = "default-cert";
    patch.certIssuer = ssl?.issuer ? sanitizeText(ssl.issuer, 120) : null;
    patch.certNotAfter = ssl?.validTo ? new Date(ssl.validTo) : null;
    // 3. HTTP through the target proxy
    let h443: { status: number | null; traefik404: boolean } = { status: null, traefik404: false };
    let h80: { status: number | null; location: string | null } = { status: null, location: null };
    if (via === "agent") {
      const r = await this.agentWs.sendCommand(app.serverId, onHostNetwork(buildCutoverLoopbackProbeScript({ host: e.hostname, path })), "deploy", 30_000).catch(() => null);
      const parsed = r ? parseCutoverProbeMarkers(r.output) : null;
      h443 = { status: parsed?.status ?? null, traefik404: false };
    } else {
      h443 = await this.probe.httpAt(ip, e.hostname, { tls: true, path }).catch(() => ({ status: null, traefik404: false, location: null }));
      h80 = await this.probe.httpAt(ip, e.hostname, { tls: false, path: "/" }).catch(() => ({ status: null, traefik404: false, location: null }));
    }
    const classified = classifyHealth(h443.status, h443.traefik404);
    const excused = !classified.pass && (e.warnings ?? []).includes(SOURCE_DEGRADED_TAG) && isExcusableHealth(classified.kind);
    const health = excused ? { ...classified, pass: true } : classified;
    patch.warnings = [...new Set([...(e.warnings ?? []).filter((w) => w !== HEALTH_PRE_EXISTING_TAG), ...(excused ? [HEALTH_PRE_EXISTING_TAG] : [])])];
    patch.needsDeploy = h443.traefik404 || (h443.status === null && !health.pass);
    patch.precheck = { tls: ssl?.reason ?? (ssl?.ok ? "ok" : "none"), https: h443.status, http80: h80.status, port80Redirect: classifyPort80(h80.status, h80.location), probeVia: via, health: classified.kind, at: new Date().toISOString() } as unknown as Prisma.InputJsonValue;
    patch.precheckAt = new Date();
    // stuck certificate: ask the proxy why (diagnostic only; never decides readiness)
    if (!certReady && e.challenge && !patch.needsDeploy && via === "hub") {
      const diag = await this.agentWs.sendCommand(app.serverId, buildAcmeDiagScript(e.hostname), "deploy", 15_000).catch(() => null);
      const d = diag ? parseAcmeDiagMarkers(diag.output) : null;
      patch.certError = d?.err ? sanitizeText(d.err, 400) : null;
    } else if (certReady) patch.certError = null;
    patch.lastError = null;

    // 4. state
    const st = e.state as CutoverState;
    if (st === "SWITCHED" || st === "VERIFY_FAILED") {
      await this.set(e.id, patch);
      await this.verifyAfterFlip(userId, e, app, ips, health.pass, certReady);
      return;
    }
    await this.set(e.id, patch);
    if (!PRE_FLIP.includes(st)) return;
    if (e.dnsMode === "manual" && (st === "READY" || st === "CERT_READY") && observed === "target" && health.pass && certReady) {
      // The owner switched DNS by hand and the public resolvers now agree: record it as switched and verified.
      for (const [from, to] of [[st, "READY"], ["READY", "SWITCHING"], ["SWITCHING", "SWITCHED"], ["SWITCHED", "VERIFIED"]] as Array<[CutoverState, CutoverState]>) {
        if (from === to) continue;
        await this.cas(e.id, from, to, to === "SWITCHED" ? { flippedAt: new Date() } : to === "VERIFIED" ? { verifiedAt: new Date() } : {}).catch(() => false);
      }
      return;
    }
    let cur: CutoverState = st;
    const go = async (to: CutoverState): Promise<void> => {
      if (cur === to) return;
      if (await this.cas(e.id, cur, to).catch(() => false)) cur = to;
    };
    const ready = health.pass && (certReady || e.challenge === "http01");
    if (ready) {
      if (cur === "PLANNED" || cur === "CERT_PENDING") await go("CERT_READY");
      await go("READY");
    } else if (certReady) {
      if (cur === "PLANNED" || cur === "CERT_PENDING") await go("CERT_READY");
      else if (cur === "READY") await go("CERT_PENDING");
    } else if (cur !== "CERT_PENDING") await go("CERT_PENDING");
  }

  // ── TTL ────────────────────────────────────────────────────────────────────────────────────

  /**
   * Lower the TTL of the unproxied Cloudflare records so resolver caches expire before the flip. Manual-DNS hosts get
   * guidance (measured at the authoritative server) instead. Proxied records are skipped: TTL is not honoured for them.
   */
  async ttl(userId: string, opId: string, input: CutoverTtlInput): Promise<{ guidance: Array<{ hostname: string; oldTtl: number; lowerBefore: string }>; view: CutoverView }> {
    const c = await this.ctx(userId, opId);
    const target = input.ttl ?? DEFAULT_TARGET_TTL;
    const rows = (await this.entries(opId, input.hostnames)).filter((r) => PRE_FLIP.includes(r.state as CutoverState));
    const apps = await this.loadApps([...new Set(rows.map((r) => r.applicationId))]);
    await this.requireConfig(userId, apps.keys(), apps);
    const guidance: Array<{ hostname: string; oldTtl: number; lowerBefore: string }> = [];
    let lowered = 0;
    for (const e of rows) {
      if (e.dnsMode === "cloudflare" && e.dnsCredentialId && e.zoneId) {
        const recs = (await this.dnsAuto.listRecordsFor(userId, e.dnsCredentialId, e.zoneId, e.hostname)).filter((r) => r.type === "A" || r.type === "AAAA" || r.type === "CNAME");
        const proxied = recs.some((r) => r.proxied);
        if (proxied || recs.length === 0) {
          await this.set(e.id, { earliestFlipAt: new Date(), targetTtl: target, warnings: [...new Set([...(e.warnings ?? []), ...(proxied ? ["ttl-proxied"] : [])])] });
          continue;
        }
        const original = e.originalTtl ?? recs[0].ttl;
        const todo = recs.filter((r) => r.ttl !== target && (r.ttl > target || r.ttl === 1));
        if (todo.length) await this.dnsAuto.setRecordTtls(userId, e.dnsCredentialId, e.zoneId, todo.map((r) => ({ id: r.id, ttl: target })));
        const now = new Date();
        await this.set(e.id, { originalTtl: original, targetTtl: target, ttlLoweredAt: now, earliestFlipAt: earliestFlip(now, original, false) });
        lowered++;
      } else {
        const auth = await this.lookup.resolveAuthoritative(e.hostname, "A").catch(() => ({ ttl: null as number | null }));
        const g = ttlGuidance(auth.ttl ?? e.originalTtl, new Date());
        guidance.push({ hostname: e.hostname, oldTtl: g.oldTtl, lowerBefore: g.lowerBefore.toISOString() });
        await this.set(e.id, { originalTtl: e.originalTtl ?? auth.ttl ?? null, targetTtl: target });
      }
    }
    await this.auditLog(userId, "cutover.ttl", opId, { lowered, ttl: target });
    return { guidance, view: await this.view(userId, opId) };
  }

  // ── flip plan ──────────────────────────────────────────────────────────────────────────────

  private paramsOf(i: Partial<CutoverFlipInput> & { targetTtl?: number; keepProxied?: boolean }): FlipParams {
    return {
      batchSize: i.batchSize ?? DEFAULT_BATCH, intervalSec: i.intervalSec ?? DEFAULT_INTERVAL_SEC, targetTtl: i.targetTtl ?? DEFAULT_TARGET_TTL,
      stopOnFail: i.stopOnFail ?? true, autoRevert: i.autoRevert ?? false, keepProxied: i.keepProxied ?? true,
      acceptDataRisk: i.acceptDataRisk ?? false, acceptHttp01Gap: i.acceptHttp01Gap ?? false, skipTtlWait: i.skipTtlWait ?? false,
    };
  }

  private async planEntries(userId: string, rows: CutoverDomain[], apps: Map<string, AppRow>, params: FlipParams): Promise<PlannedEntry[]> {
    const out: PlannedEntry[] = [];
    for (const e of rows) {
      const app = apps.get(e.applicationId);
      const ips = app && !app.clusterId ? await this.targetIps(app.serverId) : { v4: [], v6: [] };
      if (e.dnsMode !== "cloudflare" || !e.dnsCredentialId || !e.zoneId) {
        out.push({ entry: e, steps: [], warnings: [], blocked: ips.v4.length === 0 ? "no-target-ip" : null, manual: true });
        continue;
      }
      const recs = await this.dnsAuto.listRecordsFor(userId, e.dnsCredentialId, e.zoneId, e.hostname);
      const at = recs.filter((r) => r.type === "A" || r.type === "AAAA" || r.type === "CNAME");
      const p = planRecords(recs, ips, { hostname: e.hostname, targetTtl: params.targetTtl, keepProxied: params.keepProxied, viaWildcard: at.length === 0 });
      const warnings = [...p.warnings];
      if (e.earliestFlipAt && e.earliestFlipAt.getTime() > Date.now() && !params.skipTtlWait) warnings.push("ttl-not-waited");
      if (e.challenge === "http01" && e.certState !== "ready") warnings.push("http01-gap");
      if (e.stateful) warnings.push("stateful");
      if (e.warnings?.includes("caa")) warnings.push("caa");
      if (e.warnings?.includes("coverage-unverified")) warnings.push("coverage-unverified");
      if (e.warnings?.includes(HEALTH_PRE_EXISTING_TAG)) warnings.push(HEALTH_PRE_EXISTING_TAG);
      if (at.some((r) => r.proxied)) {
        const v = sslModeVerdict(e.sslMode);
        if (v !== "ok") warnings.push(`ssl-mode-${v}`);
      }
      out.push({ entry: e, steps: p.steps, warnings: [...new Set(warnings)], blocked: p.blocked, manual: false });
    }
    return out;
  }

  private selectReady(rows: CutoverDomain[]): CutoverDomain[] {
    return rows.filter((r) => r.state === "READY");
  }

  /** Read-only: the exact record diff per READY host plus the confirm token. Decrypts the Cloudflare token (read:secrets). */
  async flipPlan(userId: string, opId: string, q: CutoverFlipPlanQuery): Promise<FlipPlan> {
    const c = await this.ctx(userId, opId);
    const hostnames = q.hostnames ? q.hostnames.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean) : undefined;
    const params = this.paramsOf({ targetTtl: q.targetTtl, keepProxied: q.keepProxied === undefined ? undefined : q.keepProxied === "true" });
    const all = await this.entries(opId, hostnames);
    const apps = await this.loadApps([...new Set(all.map((r) => r.applicationId))]);
    const ready = this.selectReady(all);
    const planned = await this.planEntries(userId, ready, apps, params);
    const blocked: FlipPlan["blocked"] = all.filter((r) => r.state === "BLOCKED" || r.state === "CONFLICT").map((r) => ({ hostname: r.hostname, reason: r.blockReason ?? "blocked" }));
    for (const p of planned) if (p.blocked) blocked.push({ hostname: p.entry.hostname, reason: p.blocked });
    const live = planned.filter((p) => !p.blocked);
    const entries: FlipPlan["entries"] = live.map((p) => ({
      hostname: p.entry.hostname, appName: apps.get(p.entry.applicationId)?.name ?? "", challenge: p.entry.challenge,
      records: p.steps.map((s): FlipPlanRecord => ({ type: s.type, name: s.name, action: stepAction(s), old: s.old, new: s.new })), warnings: p.warnings,
    }));
    const copyPaste: FlipPlan["copyPaste"] = [];
    for (const p of live.filter((x) => x.manual)) {
      const ips = await this.targetIps(apps.get(p.entry.applicationId)!.serverId);
      const g = ttlGuidance(p.entry.originalTtl, new Date());
      const lower = g.lowerBefore.toISOString();
      for (const ip of ips.v4) copyPaste.push({ hostname: p.entry.hostname, type: "A", name: p.entry.hostname, content: ip, ttl: params.targetTtl, lowerTtlBefore: lower });
      for (const ip of ips.v6) copyPaste.push({ hostname: p.entry.hostname, type: "AAAA", name: p.entry.hostname, content: ip, ttl: params.targetTtl, lowerTtlBefore: lower });
    }
    const hash = computePlanHash(opId, params, live.map((p) => ({ id: p.entry.id, hostname: p.entry.hostname, steps: p.steps })));
    const flipCount = live.filter((p) => !p.manual).length;
    const stopByApp = new Map<string, { appName: string; sourceName: string | null; hostnames: string[] }>();
    for (const p of live) {
      const cur = stopByApp.get(p.entry.applicationId) ?? { appName: apps.get(p.entry.applicationId)?.name ?? "", sourceName: c.names.get(p.entry.applicationId) ?? null, hostnames: [] };
      cur.hostnames.push(p.entry.hostname);
      stopByApp.set(p.entry.applicationId, cur);
    }
    return {
      opId, planHash: hash, entries,
      rate: { batchSize: params.batchSize, intervalSec: params.intervalSec, estimatedSeconds: Math.max(0, Math.ceil(flipCount / params.batchSize) - 1) * params.intervalSec },
      blocked, copyPaste, sourceStop: [...stopByApp.values()],
    };
  }

  // ── flip (background run) ──────────────────────────────────────────────────────────────────

  async flip(userId: string, opId: string, input: CutoverFlipInput): Promise<{ runId: string; planHash: string; queued: number }> {
    const c = await this.ctx(userId, opId);
    await this.settle(userId, opId);
    const params = this.paramsOf(input);
    const all = await this.entries(opId, input.hostnames);
    const apps = await this.loadApps([...new Set(all.map((r) => r.applicationId))]);
    await this.requireConfig(userId, apps.keys(), apps);
    const ready = this.selectReady(all);
    if (ready.length === 0) throw new ConflictException("no host is READY to flip - run check first");
    const planned = await this.planEntries(userId, ready, apps, params);
    const live = planned.filter((p) => !p.blocked);
    const hash = computePlanHash(opId, params, live.map((p) => ({ id: p.entry.id, hostname: p.entry.hostname, steps: p.steps })));
    if (hash !== input.confirmToken) throw new ConflictException("the plan changed since it was reviewed - fetch the flip plan again and re-confirm");
    // Gates that must fail BEFORE any provider write.
    const flippable = live.filter((p) => !p.manual);
    if (!params.acceptDataRisk && flippable.some((p) => p.entry.stateful)) {
      throw new ConflictException("a stateful app is in this flip: its data move must be verified and acceptDataRisk must be set");
    }
    if (!params.acceptHttp01Gap && flippable.some((p) => p.entry.challenge === "http01" && p.entry.certState !== "ready")) {
      throw new ConflictException("an HTTP-01 host has no certificate yet: set acceptHttp01Gap to accept a TLS gap after the flip");
    }
    if (!params.skipTtlWait && flippable.some((p) => p.entry.earliestFlipAt && p.entry.earliestFlipAt.getTime() > Date.now())) {
      throw new ConflictException("the TTL wait has not elapsed for every host - wait, or set skipTtlWait");
    }
    if (flippable.length === 0) throw new ConflictException("nothing to flip: every READY host uses manual DNS or is blocked");
    let runId: string;
    try {
      const run = await this.prisma.cutoverRun.create({
        data: { opId, activeKey: opId, params: { ...params, planHash: hash, hostnames: flippable.map((p) => p.entry.hostname) } as unknown as Prisma.InputJsonValue, total: flippable.length },
      });
      runId = run.id;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw new ConflictException("a cutover run is already active for this operation");
      throw e;
    }
    await this.auditLog(userId, "cutover.flip.start", opId, { runId, hosts: flippable.map((p) => p.entry.hostname), batchSize: params.batchSize, intervalSec: params.intervalSec });
    this.running = this.runFlip(userId, opId, runId, flippable, apps, params, c).finally(() => {
      this.running = null;
    });
    this.running.catch(() => undefined);
    return { runId, planHash: hash, queued: flippable.length };
  }

  /** The batch loop. Public for tests; production calls it from {@link flip}. */
  async runFlip(userId: string, opId: string, runId: string, planned: PlannedEntry[], apps: Map<string, AppRow>, params: FlipParams, c: OpCtx): Promise<void> {
    // Per-zone serialization: order by (zoneId, hostname) so one zone's writes never interleave across batches.
    const sorted = [...planned].sort((a, b) => (a.entry.zoneId ?? "").localeCompare(b.entry.zoneId ?? "") || a.entry.hostname.localeCompare(b.entry.hostname));
    const batches: PlannedEntry[][] = [];
    for (let i = 0; i < sorted.length; i += params.batchSize) batches.push(sorted.slice(i, i + params.batchSize));
    let final: "done" | "halted" | "cancelled" = "done";
    let lastError: string | null = null;
    try {
      for (let b = 0; b < batches.length; b++) {
        if (b > 0) await this.sleep(params.intervalSec * 1000);
        const run = await this.prisma.cutoverRun.findUnique({ where: { id: runId } });
        const op = await this.prisma.bulkOperation.findUnique({ where: { id: opId }, select: { cancelRequestedAt: true } });
        if (!run || run.status !== "running" || op?.cancelRequestedAt) {
          final = "cancelled";
          break;
        }
        await this.prisma.cutoverRun.update({ where: { id: runId }, data: { heartbeatAt: new Date() } });
        const results: Array<{ p: PlannedEntry; r: "verified" | "failed" | "conflict" | "skipped" }> = [];
        for (const p of batches[b]) {
          const r = await this.flipEntry(userId, opId, p, apps.get(p.entry.applicationId)!, params).catch((err) => {
            lastError = sanitizeText((err as Error).message, 200);
            return "failed" as const;
          });
          results.push({ p, r });
        }
        await this.prisma.cutoverRun.update({ where: { id: runId }, data: { batchesDone: b + 1, heartbeatAt: new Date() } });
        const bad = results.filter((x) => x.r === "failed" || x.r === "conflict");
        if (bad.length) {
          if (params.autoRevert) {
            // NEVER reverts a stateful entry: once Tugra may have taken writes, a revert would lose them.
            for (const x of bad.filter((y) => y.r === "failed" && !y.p.entry.stateful)) await this.revertEntry(userId, opId, x.p.entry.id, false).catch(() => undefined);
          }
          if (params.stopOnFail) {
            final = "halted";
            lastError = lastError ?? "a host failed verification";
            break;
          }
        }
      }
    } catch (err) {
      final = "halted";
      lastError = sanitizeText((err as Error).message, 200);
    } finally {
      await this.prisma.cutoverRun.update({ where: { id: runId }, data: { status: final, activeKey: null, finishedAt: new Date(), lastError } }).catch(() => undefined);
      await this.auditLog(userId, "cutover.flip.done", opId, { runId, status: final });
    }
  }

  private async gate(userId: string, e: CutoverDomain, app: AppRow, params: FlipParams): Promise<string | null> {
    const facts = await this.serverFacts(app.serverId);
    if (!facts.acmeEmailOk) return "acme-email";
    if (facts.proxyBind !== "public") return "proxy-not-public";
    if (!e.precheckAt || Date.now() - e.precheckAt.getTime() > PRECHECK_FRESH_MS) {
      // stale precheck: re-run it inline, then re-read the row
      await this.checkOne(userId, e, app, facts.ips, "hub", "/").catch(() => undefined);
      const fresh = await this.prisma.cutoverDomain.findUnique({ where: { id: e.id } });
      if (!fresh || fresh.state !== "SWITCHING") return "precheck-stale";
      Object.assign(e, fresh);
      if (!e.precheckAt || Date.now() - e.precheckAt.getTime() > PRECHECK_FRESH_MS) return "precheck-stale";
    }
    const pre = (e.precheck ?? {}) as { health?: string };
    if (!(e.certState === "ready" || (e.challenge === "http01" && params.acceptHttp01Gap))) return "cert-not-ready";
    const excusedHealth = (e.warnings ?? []).includes(SOURCE_DEGRADED_TAG) && isExcusableHealth(pre.health);
    if (!["ok", "redirect", "auth", "app-404"].includes(pre.health ?? "") && !excusedHealth) return "health-failed";
    if (!params.skipTtlWait && e.earliestFlipAt && e.earliestFlipAt.getTime() > Date.now()) return "ttl-not-waited";
    if (e.proxied && params.keepProxied) {
      if (e.dnsCredentialId && e.zoneId) {
        const mode = await this.dnsAuto.zoneSslMode(userId, e.dnsCredentialId, e.zoneId);
        if (mode === "flexible" || mode === "off") return "ssl-mode-bad";
        if (mode === "unknown") return "ssl-mode-unknown";
      }
    }
    return null;
  }

  private stepsKey(steps: LedgerRecord[]): string {
    return JSON.stringify(steps.map((s) => [s.type, s.name, s.recordId, s.old, s.new]));
  }

  private async flipEntry(userId: string, opId: string, p: PlannedEntry, app: AppRow, params: FlipParams): Promise<"verified" | "failed" | "conflict" | "skipped"> {
    const e = p.entry;
    if (!(await this.cas(e.id, "READY", "SWITCHING", { lastError: null }))) return "skipped";
    const back = async (reason: string) => {
      await this.cas(e.id, "SWITCHING", "READY", { lastError: reason });
      return "skipped" as const;
    };
    const fresh = await this.prisma.cutoverDomain.findUnique({ where: { id: e.id } });
    if (!fresh) return "skipped";
    const gateFail = await this.gate(userId, fresh, app, params);
    if (gateFail) return back(gateFail);
    // Drift guard: re-plan from a fresh provider read; any difference from what the owner confirmed aborts this host.
    const again = (await this.planEntries(userId, [fresh], new Map([[app.id, app]]), params))[0];
    if (again.blocked || this.stepsKey(again.steps) !== this.stepsKey(p.steps)) {
      await this.cas(e.id, "SWITCHING", "CONFLICT", { blockReason: "record-changed", lastError: "the provider records changed since the plan was confirmed" });
      return "conflict";
    }
    const steps = p.steps.map((s) => ({ ...s }));
    // Persist the ledger BEFORE the first provider write.
    await this.set(e.id, { ledger: steps as unknown as Prisma.InputJsonValue, targetTtl: params.targetTtl });
    try {
      await this.dnsAuto.applyLedger(userId, fresh.dnsCredentialId!, fresh.zoneId!, steps, async (s) => {
        await this.set(e.id, { ledger: s as unknown as Prisma.InputJsonValue });
      });
    } catch (err) {
      await this.set(e.id, { ledger: steps as unknown as Prisma.InputJsonValue });
      await this.cas(e.id, "SWITCHING", "CONFLICT", { blockReason: "provider-write-failed", lastError: sanitizeText((err as Error).message, 200) });
      await this.auditLog(userId, "cutover.flip.entry", opId, { hostname: e.hostname, result: "write-failed" });
      return "conflict";
    }
    await this.cas(e.id, "SWITCHING", "SWITCHED", { flippedAt: new Date() });
    await this.dnsAuto.upsertDomainRow(app.id, e.hostname, fresh.dnsCredentialId!, fresh.zoneId!, steps).catch(() => undefined);
    const ips = await this.targetIps(app.serverId);
    for (let attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt++) {
      const v = await this.verifyOnce(userId, { ...fresh, ledger: steps as unknown as Prisma.JsonValue }, app, ips, steps);
      if (v.ok) {
        await this.cas(e.id, "SWITCHED", "VERIFIED", { verifiedAt: new Date(), lastError: null });
        await this.auditLog(userId, "cutover.flip.entry", opId, { hostname: e.hostname, result: "verified" });
        return "verified";
      }
      if (attempt === VERIFY_ATTEMPTS) {
        await this.cas(e.id, "SWITCHED", "VERIFY_FAILED", { lastError: v.reason });
        await this.auditLog(userId, "cutover.flip.entry", opId, { hostname: e.hostname, result: "verify-failed", reason: v.reason });
        return "failed";
      }
      await this.sleep(VERIFY_BACKOFF_MS);
    }
    return "failed";
  }

  /** One verification pass: provider read-back, public resolvers + authoritative NS (unproxied), then cert + health through the target. */
  private async verifyOnce(userId: string, e: CutoverDomain, app: AppRow, ips: TargetIps, steps: LedgerRecord[]): Promise<{ ok: boolean; reason: string }> {
    try {
      const ip = ips.v4[0] ?? ips.v6[0];
      if (!ip) return { ok: false, reason: "no-target-ip" };
      let anyProxied = false;
      if (e.dnsCredentialId && e.zoneId) {
        const recs = await this.dnsAuto.listRecordsFor(userId, e.dnsCredentialId, e.zoneId, e.hostname);
        for (const s of steps) {
          if (!s.written) continue;
          const a = stepAction(s);
          const cur = s.recordId ? recs.find((r) => r.id === s.recordId) : undefined;
          if (a === "delete") {
            if (cur) return { ok: false, reason: "provider-readback" };
          } else if (a !== "noop") {
            if (!cur || cur.content !== s.new!.content || cur.proxied !== s.new!.proxied) return { ok: false, reason: "provider-readback" };
          }
          if (s.new?.proxied) anyProxied = true;
        }
      }
      if (!anyProxied) {
        const pub = await this.lookup.resolvePublic(e.hostname, "A");
        for (const r of Object.values(pub)) if (!ips.v4.every((x) => r.includes(x))) return { ok: false, reason: "dns-not-propagated" };
        const auth = await this.lookup.resolveAuthoritative(e.hostname, "A");
        if (auth.addresses.length === 0 || !ips.v4.every((x) => auth.addresses.includes(x))) return { ok: false, reason: "dns-not-authoritative" };
      }
      const ssl = await this.probe.sslAt(ip, e.hostname);
      if (!ssl.ok) return { ok: false, reason: `cert-${ssl.reason ?? "error"}` };
      const h = await this.probe.httpAt(ip, e.hostname, { tls: true, path: "/" });
      const cls = classifyHealth(h.status, h.traefik404);
      if (!cls.pass && !((e.warnings ?? []).includes(SOURCE_DEGRADED_TAG) && isExcusableHealth(cls.kind))) return { ok: false, reason: `health-${cls.kind}` };
      return { ok: true, reason: "" };
    } catch (err) {
      return { ok: false, reason: sanitizeText((err as Error).message, 160) || "verify-error" };
    }
  }

  /** `check` on an already-switched host: one verification pass (no inline retries). */
  private async verifyAfterFlip(userId: string, e: CutoverDomain, app: AppRow, ips: TargetIps, healthPass: boolean, certReady: boolean): Promise<void> {
    const steps = Array.isArray(e.ledger) ? (e.ledger as unknown as LedgerRecord[]) : [];
    if (e.dnsMode === "manual") {
      const o = await this.observe(userId, e, ips);
      if (o.observed === "target" && healthPass && certReady) await this.cas(e.id, e.state as CutoverState, e.state === "SWITCHED" ? "VERIFIED" : "SWITCHED", e.state === "SWITCHED" ? { verifiedAt: new Date(), lastError: null } : {});
      return;
    }
    const v = await this.verifyOnce(userId, e, app, ips, steps);
    if (v.ok) await this.cas(e.id, e.state as CutoverState, e.state === "VERIFY_FAILED" ? "SWITCHED" : "VERIFIED", e.state === "SWITCHED" ? { verifiedAt: new Date(), lastError: null } : {});
    else if (e.state === "SWITCHED") await this.cas(e.id, "SWITCHED", "VERIFY_FAILED", { lastError: v.reason });
    if (v.ok && e.state === "VERIFY_FAILED") await this.cas(e.id, "SWITCHED", "VERIFIED", { verifiedAt: new Date(), lastError: null });
  }

  // ── cancel / revert / finalize / fix-counterpart / exclude ────────────────────────────────

  async cancel(userId: string, opId: string): Promise<CutoverView> {
    await this.ctx(userId, opId);
    const r = await this.prisma.cutoverRun.updateMany({ where: { opId, activeKey: opId, status: "running" }, data: { status: "cancelled" } });
    await this.auditLog(userId, "cutover.cancel", opId, { cancelled: r.count });
    return this.view(userId, opId);
  }

  async revert(userId: string, opId: string, input: CutoverRevertInput): Promise<CutoverView> {
    await this.ctx(userId, opId);
    // A CONFLICT that carries a ledger (a half-applied or drifted flip, or a revert that found changed records) can be
    // reverted too - with `force` it restores even over records changed since.
    const rows = (await this.entries(opId, input.hostnames)).filter((r) => REVERTIBLE.includes(r.state as CutoverState) || (r.state === "CONFLICT" && r.ledger !== null && r.ledger !== undefined));
    if (rows.length === 0) throw new ConflictException("none of the named hosts has been switched, so there is nothing to revert");
    const apps = await this.loadApps([...new Set(rows.map((r) => r.applicationId))]);
    await this.requireConfig(userId, apps.keys(), apps);
    for (const e of rows) await this.revertEntry(userId, opId, e.id, input.force === true);
    await this.auditLog(userId, "cutover.revert", opId, { hosts: rows.map((r) => r.hostname), force: input.force === true });
    return this.view(userId, opId);
  }

  /** Restore one entry's records from its ledger. A record that no longer equals what we wrote is a CONFLICT and
   *  nothing is overwritten (unless `force`). Manual-DNS entries are an instruction only. */
  private async revertEntry(userId: string, opId: string, entryId: string, force: boolean): Promise<void> {
    const e = await this.prisma.cutoverDomain.findUnique({ where: { id: entryId } });
    if (!e || !(await this.cas(e.id, [...REVERTIBLE, "CONFLICT"], "REVERTING"))) return;
    if (e.dnsMode !== "cloudflare" || !e.dnsCredentialId || !e.zoneId) {
      await this.cas(e.id, "REVERTING", "ROLLED_BACK", { revertedAt: new Date(), lastError: null });
      return;
    }
    try {
      const steps = Array.isArray(e.ledger) ? (e.ledger as unknown as LedgerRecord[]) : [];
      const r = await this.dnsAuto.restoreLedger(userId, e.dnsCredentialId, e.zoneId, steps, { force });
      if (r.conflicts.length > 0 && !force) {
        await this.cas(e.id, "REVERTING", "CONFLICT", { blockReason: "record-changed-since-flip", lastError: "a DNS record changed after the flip; nothing was overwritten (use force to restore anyway)" });
        return;
      }
      await this.cas(e.id, "REVERTING", "ROLLED_BACK", { revertedAt: new Date(), lastError: null, ledger: Prisma.JsonNull, verifiedAt: null, flippedAt: null, finalizedAt: null });
    } catch (err) {
      await this.cas(e.id, "REVERTING", "CONFLICT", { blockReason: "revert-failed", lastError: sanitizeText((err as Error).message, 200) });
    }
  }

  async finalize(userId: string, opId: string, input: CutoverFinalizeInput): Promise<CutoverView> {
    await this.ctx(userId, opId);
    const rows = (await this.entries(opId, input.hostnames, ["VERIFIED"])).filter((r) => !r.finalizedAt);
    const apps = await this.loadApps([...new Set(rows.map((r) => r.applicationId))]);
    await this.requireConfig(userId, apps.keys(), apps);
    for (const e of rows) {
      if (e.dnsMode === "cloudflare" && e.dnsCredentialId && e.zoneId && !e.proxied) {
        const steps = Array.isArray(e.ledger) ? (e.ledger as unknown as LedgerRecord[]) : [];
        await this.dnsAuto.restoreTtls(userId, e.dnsCredentialId, e.zoneId, steps, e.originalTtl);
      }
      await this.set(e.id, { finalizedAt: new Date() });
    }
    await this.auditLog(userId, "cutover.finalize", opId, { hosts: rows.length });
    return this.view(userId, opId);
  }

  /**
   * Put the TTL back on hosts whose TTL was lowered and that carry no live flip any more: never flipped, or already reverted (a
   * revert restores the records as they were just before the flip, i.e. with the lowered TTL). A host still flipped is untouched. Only records that still carry the lowered TTL are patched, so a TTL
   * the owner changed meanwhile is left alone. Returns the number of records patched.
   */
  async restoreTtlsUnflipped(userId: string, opId: string): Promise<number> {
    await this.ctx(userId, opId);
    const rows = (await this.entries(opId)).filter((e) => !!e.ttlLoweredAt && e.originalTtl != null && e.targetTtl != null && e.dnsMode === "cloudflare" && !!e.dnsCredentialId && !!e.zoneId && !e.ledger && (PRE_FLIP.includes(e.state as CutoverState) || e.state === "BLOCKED" || e.state === "EXCLUDED" || e.state === "ROLLED_BACK"));
    const apps = await this.loadApps([...new Set(rows.map((r) => r.applicationId))]);
    await this.requireConfig(userId, apps.keys(), apps);
    let restored = 0;
    for (const e of rows) {
      const recs = (await this.dnsAuto.listRecordsFor(userId, e.dnsCredentialId!, e.zoneId!, e.hostname)).filter((r) => (r.type === "A" || r.type === "AAAA" || r.type === "CNAME") && !r.proxied && r.ttl === e.targetTtl);
      if (recs.length) await this.dnsAuto.setRecordTtls(userId, e.dnsCredentialId!, e.zoneId!, recs.map((r) => ({ id: r.id, ttl: e.originalTtl! })));
      restored += recs.length;
      await this.set(e.id, { ttlLoweredAt: null, earliestFlipAt: null });
    }
    await this.auditLog(userId, "cutover.ttl.restore", opId, { hosts: rows.length, records: restored });
    return restored;
  }

  async fixCounterpart(userId: string, opId: string, input: CutoverFixCounterpartInput): Promise<CutoverView> {
    const c = await this.ctx(userId, opId);
    if (!c.appIds.includes(input.applicationId)) throw new NotFoundException("that application is not part of this operation");
    await this.apps.setDomainOptions(userId, input.applicationId, { domainRedirect: input.direction });
    const rows = await this.prisma.cutoverDomain.findMany({ where: { opId, applicationId: input.applicationId } });
    for (const e of rows) {
      if (e.role === "counterpart" && e.state === "BLOCKED" && e.blockReason === "counterpart-not-served") await this.cas(e.id, "BLOCKED", "PLANNED", { blockReason: null });
      await this.set(e.id, { needsDeploy: true });
    }
    await this.auditLog(userId, "cutover.fixCounterpart", opId, { applicationId: input.applicationId, direction: input.direction });
    return this.view(userId, opId);
  }

  async exclude(userId: string, opId: string, input: CutoverExcludeInput): Promise<CutoverView> {
    await this.ctx(userId, opId);
    const rows = await this.entries(opId, input.hostnames);
    const apps = await this.loadApps([...new Set(rows.map((r) => r.applicationId))]);
    await this.requireConfig(userId, apps.keys(), apps);
    for (const e of rows) {
      if (input.excluded) {
        if (["PLANNED", "CERT_PENDING", "CERT_READY", "READY", "BLOCKED", "CONFLICT"].includes(e.state)) await this.cas(e.id, e.state as CutoverState, "EXCLUDED", { blockReason: "excluded" });
      } else if (e.state === "EXCLUDED") await this.cas(e.id, "EXCLUDED", "PLANNED", { blockReason: null });
    }
    await this.auditLog(userId, "cutover.exclude", opId, { hosts: rows.length, excluded: input.excluded });
    return this.view(userId, opId);
  }
}
