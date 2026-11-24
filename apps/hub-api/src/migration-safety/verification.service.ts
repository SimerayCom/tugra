import { ConflictException, Inject, Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { CryptoService } from "../crypto/crypto.service";
import { AuditService } from "../audit/audit.service";
import { MIGRATION_RUNS_FACADE, type MigrationRunsFacade, type RunActor } from "../migration-runs/core/run-contract";
import type { DbStats } from "../migration-runs/steps/data/data-contract";
import { compareDbStats } from "../migration-runs/steps/data/verify/db-stats";
import { CUTOVER_HOSTNAME_RE } from "../cutover/cutover.logic";
import { samplePageAt, type PageTransport, realTransport } from "./preview-fetch";
import {
  EMPTY_SAMPLE,
  envRow,
  pageRow,
  summarize,
  tableDiffs,
  volumeRow,
  type DbRow,
  type EnvRow,
  type PageRow,
  type VerificationReport,
  type Verdict,
  type VolumeRow,
} from "./verify-compare";

const MAX_HOSTS = 20;
const MAX_PATHS = 6;
const CONCURRENCY = 4;
const KEEP_REPORTS = 5;
const SOURCE_STATS_CHECK = "source-stats";
const TARGET_STATS_CHECK = "target-stats";

export interface VerificationView {
  report: VerificationReport | null;
  /** Hosts with an address the owner can open on the target before the DNS change (only apps that have a generated preview domain). */
  previews: Array<{ host: string; url: string | null }>;
}

const num = (v: bigint | number | null | undefined): number | null => (v === null || v === undefined ? null : Number(v));

/**
 * The verification report of a migration run (item 92): before the DNS change, compare what the source serves with what
 * the target serves (status and a normalized content hash of the key pages), the database tables' row counts, the volumes'
 * file count and size, and the variables the source has that the target does not. Read-only: it never writes to the source or
 * the target; it stores the secret-free result. Authorization is the run facade's (creator-only, team permission re-checked).
 */
@Injectable()
export class VerificationService {
  private readonly running = new Set<string>();
  /** Test seam: the real transport is SSRF-pinned. */
  transport: PageTransport = realTransport;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    @Inject(MIGRATION_RUNS_FACADE) private readonly runs: MigrationRunsFacade,
  ) {}

  async latest(actor: RunActor, runId: string): Promise<VerificationView> {
    const run = await this.runs.get(actor, runId); // authorization
    const row = await this.prisma.migrationVerification.findFirst({ where: { runId: run.id }, orderBy: { createdAt: "desc" } });
    return { report: (row?.report as unknown as VerificationReport | undefined) ?? null, previews: await this.previews(run.opId) };
  }

  async run(actor: RunActor, runId: string, extraPaths: readonly string[]): Promise<VerificationView> {
    const run = await this.runs.get(actor, runId); // authorization (creator-only, team permission)
    if (!run.opId) throw new ConflictException("the run has not imported anything yet");
    if (this.running.has(run.id)) throw new ConflictException("a verification is already running for this run");
    this.running.add(run.id);
    try {
      const paths = [...new Set(["/", ...(run.options.healthPath ? [run.options.healthPath] : []), ...extraPaths])].slice(0, MAX_PATHS);
      const pages = await this.pages(run.opId, run.topology, paths);
      const databases = await this.databases(run.id, run.opId);
      const volumes = await this.volumes(run.opId);
      const env = await this.env(run.opId);
      const rows: Array<{ verdict: Verdict }> = [...pages, ...databases, ...volumes, ...env];
      const { state, counts } = summarize(rows);
      const report: VerificationReport = { runId: run.id, at: new Date().toISOString(), state, counts, pages, databases, volumes, env, previewHosts: [...new Set(pages.map((p) => p.host))] };
      await this.prisma.migrationVerification.create({ data: { runId: run.id, teamId: run.teamId, state, report: report as unknown as Prisma.InputJsonValue, createdBy: actor.userId } });
      const old = await this.prisma.migrationVerification.findMany({ where: { runId: run.id }, orderBy: { createdAt: "desc" }, select: { id: true }, skip: KEEP_REPORTS });
      if (old.length) await this.prisma.migrationVerification.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
      await this.audit.log({ actor: actor.userId, action: "migration.verification", target: run.id, meta: { state, checked: counts.checked, differs: counts.differs } });
      return { report, previews: await this.previews(run.opId) };
    } finally {
      this.running.delete(run.id);
    }
  }

  // ───────────────────────────── pages ─────────────────────────────

  private async pages(opId: string, topology: string, paths: readonly string[]): Promise<PageRow[]> {
    const domains = await this.prisma.cutoverDomain.findMany({
      where: { opId, role: { in: ["primary", "alias"] } },
      select: { hostname: true, applicationId: true },
      orderBy: { hostname: "asc" },
      take: MAX_HOSTS,
    });
    const hosts = domains.filter((d) => CUTOVER_HOSTNAME_RE.test(d.hostname));
    if (!hosts.length) return [];
    const apps = await this.prisma.application.findMany({ where: { id: { in: [...new Set(hosts.map((h) => h.applicationId))] } }, select: { id: true, serverId: true } });
    const servers = await this.prisma.server.findMany({ where: { id: { in: [...new Set(apps.map((a) => a.serverId))] } }, select: { id: true, publicIp: true, publicIpv6: true } });
    const ipOf = (appId: string): string | undefined => {
      const a = apps.find((x) => x.id === appId);
      const s = servers.find((x) => x.id === a?.serverId);
      return s?.publicIp ?? s?.publicIpv6 ?? undefined;
    };
    const jobs = hosts.flatMap((h) => paths.map((path) => ({ host: h.hostname, path, ip: ipOf(h.applicationId) })));
    const out: PageRow[] = new Array(jobs.length);
    let next = 0;
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= jobs.length) return;
        const j = jobs[i];
        const source = await samplePageAt(j.host, j.path, undefined, this.transport);
        // A same-host takeover keeps the new proxy dark (no published port): the hub cannot reach it, only the agent can.
        const target = topology === "swap-proxy" ? { ...EMPTY_SAMPLE, error: "dark-proxy" } : j.ip ? await samplePageAt(j.host, j.path, j.ip, this.transport) : { ...EMPTY_SAMPLE, error: "no-address" };
        out[i] = pageRow(j.host, j.path, source, target);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));
    return out;
  }

  /** Addresses the owner can open on the target now: only apps that carry a generated (sslip-style) domain. */
  private async previews(opId: string | null): Promise<VerificationView["previews"]> {
    if (!opId) return [];
    const domains = await this.prisma.cutoverDomain.findMany({ where: { opId, role: "primary" }, select: { hostname: true, applicationId: true }, take: MAX_HOSTS });
    if (!domains.length) return [];
    const apps = await this.prisma.application.findMany({ where: { id: { in: domains.map((d) => d.applicationId) } }, select: { id: true, domain: true, domainKind: true, https: true } });
    return domains.map((d) => {
      const a = apps.find((x) => x.id === d.applicationId);
      return { host: d.hostname, url: a && a.domainKind === "magic" && a.domain ? `${a.https ? "https" : "http"}://${a.domain}` : null };
    });
  }

  // ───────────────────────────── databases ─────────────────────────────

  private async databases(runId: string, opId: string): Promise<DbRow[]> {
    const checks = await this.prisma.migrationRunCheck.findMany({ where: { runId, stepKey: "VERIFY", checkId: { in: [SOURCE_STATS_CHECK, TARGET_STATS_CHECK] } } });
    const asStats = (v: unknown): DbStats | undefined => (v && typeof v === "object" && Array.isArray((v as DbStats).tables) ? (v as DbStats) : undefined);
    const src = new Map<string, DbStats>();
    const tgt = new Map<string, DbStats>();
    for (const c of checks) {
      const s = asStats(c.evidence);
      if (s) (c.checkId === SOURCE_STATS_CHECK ? src : tgt).set(c.subject, s);
    }
    const tasks = await this.prisma.bulkTask.findMany({ where: { opId, kind: "database", status: "DONE" }, select: { itemRef: true, result: true } });
    const refs = new Set([...src.keys(), ...tgt.keys(), ...tasks.map((t) => t.itemRef).filter((r): r is string => !!r)]);
    const nameOf = (ref: string): string | null => {
      const r = tasks.find((t) => t.itemRef === ref)?.result;
      return r && typeof r === "object" && typeof (r as { name?: unknown }).name === "string" ? (r as { name: string }).name : null;
    };
    return [...refs].sort().map((itemRef): DbRow => {
      const s = src.get(itemRef);
      const t = tgt.get(itemRef);
      const r = compareDbStats(s, t);
      const verdict: Verdict = r.status === "pass" ? "same" : r.status === "warn" ? "similar" : r.status === "fail" ? "differs" : "unknown";
      const total = (x?: DbStats) => (x ? x.tables.reduce((a, b) => a + Math.max(0, b.rows), 0) : null);
      return {
        itemRef,
        name: nameOf(itemRef),
        engine: (s ?? t)?.engine ?? null,
        verdict,
        code: r.code,
        sourceRows: total(s),
        targetRows: total(t),
        tables: verdict === "same" || !s || !t ? [] : tableDiffs(s.tables, t.tables),
      };
    });
  }

  // ───────────────────────────── volumes ─────────────────────────────

  private async volumes(opId: string): Promise<VolumeRow[]> {
    const rows = await this.prisma.migrationVolumeTransfer.findMany({ where: { opId, destType: "app-volume", NOT: { state: "EXCLUDED" as never } }, orderBy: { itemRef: "asc" }, take: 200 });
    return rows.map((r) =>
      volumeRow({ itemRef: r.itemRef, name: r.itemRef.split(":").slice(3).join(":") || null, state: r.state, entries: r.entries, rawBytesFinal: num(r.rawBytesFinal), rawBytesDone: Number(r.rawBytesDone) }),
    );
  }

  // ───────────────────────────── env keys ─────────────────────────────

  private async env(opId: string): Promise<EnvRow[]> {
    const tasks = await this.prisma.bulkTask.findMany({ where: { opId, kind: "app", status: "DONE", resourceType: "application" }, select: { itemRef: true, resourceId: true, result: true }, take: 200 });
    const ids = tasks.map((t) => t.resourceId).filter((x): x is string => !!x);
    const apps = ids.length ? await this.prisma.application.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, envEnc: true } }) : [];
    const names = (v: unknown, cap = 50): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, cap) : []);
    return tasks
      .filter((t) => t.itemRef)
      .map((t) => {
        const a = apps.find((x) => x.id === t.resourceId);
        const res = (t.result && typeof t.result === "object" ? t.result : {}) as { unresolvedKeys?: unknown; droppedInvalidKeys?: unknown; sourceEnvKeys?: unknown };
        const sourceKeys = Array.isArray(res.sourceEnvKeys) ? names(res.sourceEnvKeys, 500) : null;
        let targetKeys: number | null = null;
        let targetKeyNames: string[] | null = null;
        if (a?.envEnc) {
          try {
            const parsed = JSON.parse(this.crypto.decrypt(a.envEnc)) as Record<string, unknown>;
            targetKeyNames = Object.keys(parsed); // names only: the values are not read further
            targetKeys = targetKeyNames.length;
          } catch {
            targetKeys = null;
          }
        } else if (a) {
          targetKeys = 0;
          targetKeyNames = [];
        }
        return envRow({ itemRef: t.itemRef as string, name: a?.name ?? null, targetKeys, unresolved: names(res.unresolvedKeys), dropped: names(res.droppedInvalidKeys), sourceKeys, targetKeyNames });
      });
  }
}
