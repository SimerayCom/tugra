import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import type { ObjectMigration, ObjectMigrationBucket, Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { CryptoService } from "../crypto/crypto.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import type { ObjectBucketStatus, ObjectMigrationStatus, ObjectMigrationWarning } from "./dto";
import {
  buildObjCleanupScript,
  buildObjConfigApplyScript,
  buildObjDiffScript,
  buildObjDuScript,
  buildObjProbeScript,
  buildObjStartScript,
  buildObjStatusScript,
  type ObjConfigApply,
  type ObjSides,
} from "./obj-scripts";
import { classifyMirrorError, parseCfgResults, parseDiff, parseDuOutput, parseProbe, parseStarted, parseStatus, type ExportedConfig, type HelperStatus, type ObjErrorCode } from "./obj-parse";

/** Helpers a single target server runs at once, across ALL migrations (excess selected buckets wait QUEUED). */
export const MAX_HELPERS_PER_SERVER = 2;
const MAX_BUCKETS = 500;
const DU_GROUP = 3;
const MAX_REISSUE = 3;

export const LIVE_BUCKET: ReadonlySet<string> = new Set(["SEEDING", "FINALIZING"]);
const ACTIVE_BUCKET: ReadonlySet<string> = new Set(["QUEUED", "SEEDING", "FINALIZING"]);

const TIMEOUTS = { probe: 240_000, du: 620_000, start: 60_000, status: 60_000, diff: 620_000, cfg: 180_000, clean: 60_000 };

export interface ObjRunnerTiming {
  pollMs: number;
}

type MigrationWithBuckets = ObjectMigration & { buckets: ObjectMigrationBucket[] };

/** Pure: the migration's status from its selected buckets. Never reports success without every selected bucket being
 *  there: DONE only when EVERY selected bucket was VERIFIED after a final pass. */
export function deriveMigrationStatus(current: string, phase: string | null, buckets: Array<{ selected: boolean; status: string }>): ObjectMigrationStatus {
  if (current === "DRAFT") return "DRAFT";
  const sel = buckets.filter((b) => b.selected);
  if (sel.some((b) => ACTIVE_BUCKET.has(b.status))) return phase === "final" ? "FINALIZING" : "SEEDING";
  if (sel.length === 0) return "PREFLIGHTED";
  if (sel.some((b) => b.status === "FAILED")) return "FAILED";
  if (sel.every((b) => b.status === "VERIFIED")) return "DONE";
  if (sel.every((b) => ["FINAL", "VERIFIED", "DIFFERS"].includes(b.status))) return "FINAL";
  if (sel.every((b) => ["SEEDED", "FINAL", "VERIFIED", "DIFFERS"].includes(b.status))) return "SEEDED";
  return "PREFLIGHTED";
}

const big = (n: number | null | undefined): bigint | null => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? BigInt(Math.trunc(n)) : null);

/**
 * Drives the object migration on the TARGET server's agent (capability `backup`): probe, sizes, detached `mc mirror`
 * helpers, polling, verify and the optional config carry. The ObjectMigration rows are the source of truth; helpers are
 * DETACHED containers, so a hub restart or agent reconnect never loses a mirror: the poll loop (re)attaches by
 * `docker inspect` and re-issues a vanished helper (mirror is idempotent). Nothing is ever marked successful without its
 * markers: a missing marker, an unknown state or an unreachable side fails closed.
 */
@Injectable()
export class ObjMigrationRunnerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ObjMigrationRunnerService.name);
  timing: ObjRunnerTiming = { pollMs: 10_000 };
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly ticking = new Set<string>();
  private readonly reissues = new Map<string, number>();
  private destroyed = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentWs: AgentWsServer,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
  ) {}

  /** Hub restart: re-attach to every migration that still has active buckets (the poll re-issues a vanished helper). */
  async onModuleInit(): Promise<void> {
    try {
      const rows = await this.prisma.objectMigration.findMany({ where: { buckets: { some: { status: { in: [...ACTIVE_BUCKET] } } } }, select: { id: true } });
      for (const r of rows) this.ensurePolling(r.id);
    } catch (e) {
      this.logger.warn(`object-migration reconcile skipped: ${e instanceof Error ? e.constructor.name : "error"}`);
    }
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  // ───────────────────────────── helpers ─────────────────────────────

  /** Decrypt the two credential pairs. Callers must not log or return the result. */
  sides(m: ObjectMigration): ObjSides {
    return {
      src: { endpoint: m.srcEndpoint, accessKey: this.crypto.decrypt(m.srcAccessKeyEnc), secretKey: this.crypto.decrypt(m.srcSecretKeyEnc) },
      dst: { endpoint: m.dstEndpoint, accessKey: this.crypto.decrypt(m.dstAccessKeyEnc), secretKey: this.crypto.decrypt(m.dstSecretKeyEnc) },
    };
  }

  private run(m: { targetServerId: string }, script: string, timeoutMs: number): Promise<{ exitCode: number; output: string }> {
    return this.agentWs.sendCommand(m.targetServerId, script, "backup", timeoutMs);
  }

  private async load(id: string): Promise<MigrationWithBuckets | null> {
    return this.prisma.objectMigration.findUnique({ where: { id }, include: { buckets: { orderBy: { idx: "asc" } } } });
  }

  /** Recompute + persist the migration status (and clear `phase` when nothing is active). */
  async refreshStatus(id: string, extra: Prisma.ObjectMigrationUpdateInput = {}): Promise<ObjectMigrationStatus | null> {
    const m = await this.load(id);
    if (!m) return null;
    const active = m.buckets.some((b) => b.selected && ACTIVE_BUCKET.has(b.status));
    const status = deriveMigrationStatus(m.status === "VERIFYING" ? "PREFLIGHTED" : m.status, m.phase, m.buckets);
    await this.prisma.objectMigration.update({
      where: { id },
      data: { status, ...(active ? {} : { phase: null }), ...(status === "DONE" || status === "FAILED" ? { finishedAt: new Date() } : {}), ...extra },
    });
    return status;
  }

  // ───────────────────────────── preflight ─────────────────────────────

  /** Probe both S3 sides, list buckets, size them (du, <= 3 per call) and export each bucket's read-only config. Returns
   *  the fixed-code warnings (a `blocker` keeps the migration in DRAFT). Never assumes anything: an unreachable side, a
   *  missing mc, a truncated probe or an unknown size is reported. */
  async preflight(m: MigrationWithBuckets): Promise<ObjectMigrationWarning[]> {
    const sides = this.sides(m);
    const warnings: ObjectMigrationWarning[] = [];
    const probeRes = await this.run(m, buildObjProbeScript(sides), TIMEOUTS.probe);
    const probe = parseProbe(probeRes.output);
    if (probe.noAgentImage) warnings.push({ code: "no_agent_image", level: "blocker" });
    else if (!probe.complete || !probe.protocol) warnings.push({ code: "probe_incomplete", level: "blocker" });
    else if (!probe.tool || !probe.tool.present) warnings.push({ code: "no_mc", level: "blocker" });
    else {
      if (!probe.reach.src?.ok) warnings.push({ code: "src_unreachable", level: "blocker" });
      if (!probe.reach.dst?.ok) warnings.push({ code: "dst_unreachable", level: "blocker" });
    }
    if (warnings.some((w) => w.level === "blocker")) {
      await this.prisma.objectMigration.update({ where: { id: m.id }, data: { warnings: warnings as unknown as Prisma.InputJsonValue } });
      return warnings;
    }

    const names = probe.srcBuckets.slice(0, MAX_BUCKETS);
    if (probe.srcBuckets.length > MAX_BUCKETS) warnings.push({ code: "too_many_buckets", level: "warn" });
    if (names.length === 0) warnings.push({ code: "no_buckets", level: "warn" });
    const existing = new Map(m.buckets.map((b) => [b.srcBucket, b]));
    let nextIdx = m.buckets.reduce((n, b) => Math.max(n, b.idx + 1), 0);
    for (const name of names) {
      if (existing.has(name)) continue;
      const row = await this.prisma.objectMigrationBucket.create({ data: { migrationId: m.id, idx: nextIdx++, srcBucket: name, dstBucket: name, selected: false } });
      existing.set(name, row);
    }
    // A source bucket that vanished and was never started is dropped; a started one stays (the data may already be copied).
    for (const b of m.buckets) if (!names.includes(b.srcBucket) && b.status === "PENDING") await this.prisma.objectMigrationBucket.delete({ where: { id: b.id } });

    const dstSet = new Set(probe.dstBuckets);
    const rows = [...existing.values()].filter((b) => names.includes(b.srcBucket)).sort((a, b) => a.idx - b.idx);
    let totalBytes = 0;
    for (let i = 0; i < rows.length; i += DU_GROUP) {
      const group = rows.slice(i, i + DU_GROUP);
      let parsed: ReturnType<typeof parseDuOutput> | null = null;
      try {
        const r = await this.run(m, buildObjDuScript(sides, group.map((b) => ({ src: b.srcBucket, dst: b.dstBucket, dstExists: dstSet.has(b.dstBucket) }))), TIMEOUTS.du);
        parsed = parseDuOutput(r.output);
      } catch (e) {
        if (e instanceof Error && /offline/i.test(e.message)) throw e; // the agent went away: surface it, do not pretend sizes are unknown
        parsed = null;
      }
      for (const b of group) {
        const res = parsed?.get(b.srcBucket);
        if (!res || !res.src) {
          warnings.push({ code: "size_unknown", level: "warn", bucket: b.srcBucket });
        } else totalBytes += res.src.bytes;
        if (res?.versioning === "enabled" || res?.versioning === "suspended") warnings.push({ code: "versions_not_carried", level: "warn", bucket: b.srcBucket });
        if (res?.dst && res.dst.objects > 0) warnings.push({ code: "dst_not_empty", level: "info", bucket: b.srcBucket });
        const cfg = res?.config ?? ({} as ExportedConfig);
        const hasCfg = !!(cfg.policy || cfg.lifecycle || cfg.tags);
        const prevStatus = b.configStatus;
        await this.prisma.objectMigrationBucket.update({
          where: { id: b.id },
          data: {
            srcObjects: res?.src ? big(res.src.objects) : null,
            srcBytes: res?.src ? big(res.src.bytes) : null,
            dstObjects: dstSet.has(b.dstBucket) ? (res?.dst ? big(res.dst.objects) : null) : big(0),
            dstBytes: dstSet.has(b.dstBucket) ? (res?.dst ? big(res.dst.bytes) : null) : big(0),
            versioning: res?.versioning ?? null,
            config: hasCfg ? ({ policy: cfg.policy ?? null, lifecycle: cfg.lifecycle ?? null, tags: cfg.tags ?? null } as unknown as Prisma.InputJsonValue) : undefined,
            configStatus: !res ? prevStatus : hasCfg ? (prevStatus === "APPLIED" || prevStatus === "FAILED" ? prevStatus : "EXPORTED") : "NONE",
          },
        });
      }
    }
    // Informational: mc streams through the helper's memory (no local disk); a same-host destination keeps its data under
    // the docker root, so warn (never block) when the selected data would not fit.
    if (probe.dfAvailKb !== null && /^https?:\/\/host\.docker\.internal(?::\d+)?$/i.test(m.dstEndpoint) && totalBytes > probe.dfAvailKb * 1024) {
      warnings.push({ code: "dst_space_low", level: "warn" });
    }
    await this.prisma.objectMigration.update({ where: { id: m.id }, data: { warnings: warnings as unknown as Prisma.InputJsonValue } });
    await this.refreshStatus(m.id, {});
    const after = await this.prisma.objectMigration.findUnique({ where: { id: m.id }, select: { status: true } });
    if (after?.status === "DRAFT") await this.prisma.objectMigration.update({ where: { id: m.id }, data: { status: "PREFLIGHTED" } });
    return warnings;
  }

  // ───────────────────────────── start / poll ─────────────────────────────

  /** Mark the selected, startable buckets QUEUED for `phase` and start up to the slot cap. On a dispatch failure the
   *  buckets go back to their previous status and the error propagates (an offline agent is a clean 503 for the caller). */
  async start(id: string, opts: { phase: "seed" | "final"; remove: boolean; bucketIds: string[] }): Promise<void> {
    const before = (await this.load(id))?.buckets ?? [];
    const prior = new Map(before.filter((b) => opts.bucketIds.includes(b.id)).map((b) => [b.id, b.status]));
    await this.prisma.objectMigration.update({ where: { id }, data: { phase: opts.phase, removeExtraneous: opts.phase === "final" ? opts.remove : undefined, cancelRequested: false } });
    await this.prisma.objectMigrationBucket.updateMany({ where: { id: { in: opts.bucketIds } }, data: { status: "QUEUED", lastError: null, doneObjects: null, doneBytes: null, startedAt: null, finishedAt: null } });
    try {
      const m = await this.load(id);
      if (!m) return;
      await this.fillSlots(m.targetServerId, true);
    } catch (e) {
      for (const [bid, status] of prior) await this.prisma.objectMigrationBucket.update({ where: { id: bid }, data: { status } });
      await this.refreshStatus(id, {});
      throw e;
    }
    await this.refreshStatus(id, {});
    this.ensurePolling(id);
  }

  /** Start QUEUED buckets of this server (oldest migration first, by idx) while helper slots are free. `strict` rethrows a
   *  dispatch error (the user-triggered start); the poll loop swallows it and retries next tick. */
  async fillSlots(serverId: string, strict = false): Promise<void> {
    const live = await this.prisma.objectMigrationBucket.count({ where: { status: { in: [...LIVE_BUCKET] }, migration: { targetServerId: serverId } } });
    let free = MAX_HELPERS_PER_SERVER - live;
    if (free <= 0) return;
    const queued = await this.prisma.objectMigrationBucket.findMany({
      where: { status: "QUEUED", migration: { targetServerId: serverId, cancelRequested: false } },
      orderBy: [{ migration: { createdAt: "asc" } }, { idx: "asc" }],
      include: { migration: true },
      take: free,
    });
    const byMig = new Map<string, ObjectMigrationBucket[]>();
    for (const b of queued) {
      if (free-- <= 0) break;
      byMig.set(b.migrationId, [...(byMig.get(b.migrationId) ?? []), b]);
    }
    for (const [migId, buckets] of byMig) {
      const m = queued.find((q) => q.migrationId === migId)!.migration;
      try {
        await this.dispatch(m, buckets);
      } catch (e) {
        if (strict) throw e;
        this.logger.debug(`object-migration dispatch deferred: ${e instanceof Error ? e.constructor.name : "error"}`);
      }
    }
  }

  /** Run the start script for these buckets and record which helpers actually started (a missing STARTED => run-failed). */
  private async dispatch(m: ObjectMigration, buckets: ObjectMigrationBucket[]): Promise<void> {
    const phase = m.phase === "final" ? "final" : "seed";
    const script = buildObjStartScript(this.sides(m), {
      id: m.id,
      phase,
      remove: phase === "final" && m.removeExtraneous,
      preserve: m.preserve,
      buckets: buckets.map((b) => ({ idx: b.idx, src: b.srcBucket, dst: b.dstBucket, exclude: b.exclude })),
    });
    const r = await this.run(m, script, TIMEOUTS.start);
    const parsed = parseStarted(r.output);
    for (const b of buckets) {
      if (parsed.started.has(b.idx) && parsed.complete) {
        await this.prisma.objectMigrationBucket.update({ where: { id: b.id }, data: { status: phase === "final" ? "FINALIZING" : "SEEDING", startedAt: b.startedAt ?? new Date(), lastError: null } });
      } else {
        const code: ObjErrorCode = parsed.noAgentImage ? "helper-missing" : "run-failed";
        await this.prisma.objectMigrationBucket.update({ where: { id: b.id }, data: { status: "FAILED", lastError: code, finishedAt: new Date() } });
      }
    }
  }

  ensurePolling(id: string): void {
    if (this.destroyed || this.timers.has(id)) return;
    const t = setTimeout(() => {
      this.timers.delete(id);
      void this.tick(id).catch(() => undefined);
    }, this.timing.pollMs);
    t.unref?.();
    this.timers.set(id, t);
  }

  /** One poll: read the helpers' state, settle finished ones, fill free slots, and re-arm while anything is active. */
  async tick(id: string): Promise<void> {
    if (this.ticking.has(id)) return;
    this.ticking.add(id);
    try {
      const m = await this.load(id);
      if (!m) return;
      const live = m.buckets.filter((b) => LIVE_BUCKET.has(b.status));
      if (live.length > 0 && !m.cancelRequested) {
        let status: Map<number, HelperStatus> | null = null;
        try {
          const r = await this.run(m, buildObjStatusScript({ id: m.id, idxs: live.map((b) => b.idx) }), TIMEOUTS.status);
          status = parseStatus(r.output);
        } catch {
          status = null; // agent offline / timeout: keep every state as it is and retry next tick
        }
        if (status) for (const b of live) await this.settle(m, b, status.get(b.idx));
      }
      if (!m.cancelRequested) await this.fillSlots(m.targetServerId).catch(() => undefined);
      await this.refreshStatus(id, {});
      const fresh = await this.load(id);
      if (fresh && fresh.buckets.some((b) => ACTIVE_BUCKET.has(b.status)) && !fresh.cancelRequested) this.ensurePolling(id);
    } finally {
      this.ticking.delete(id);
    }
  }

  /** Apply ONE helper's observed state to its bucket row. A missing/unknown observation changes nothing. */
  private async settle(m: MigrationWithBuckets, b: ObjectMigrationBucket, st: HelperStatus | undefined): Promise<void> {
    if (!st) return;
    const key = `${m.id}:${b.idx}`;
    const progress = { doneObjects: big(st.doneObjects), doneBytes: big(st.doneBytes) };
    if (st.state === "exited") {
      const ok = st.exitCode === 0 && st.errors === 0;
      if (ok) {
        const done = m.phase === "final" ? "FINAL" : "SEEDED";
        await this.prisma.objectMigrationBucket.update({ where: { id: b.id }, data: { status: done, finishedAt: new Date(), lastError: null, ...progress } });
      } else {
        const code: ObjErrorCode = st.exitCode === 0 ? "mirror-errors" : classifyMirrorError(st.last);
        await this.prisma.objectMigrationBucket.update({ where: { id: b.id }, data: { status: "FAILED", finishedAt: new Date(), lastError: code, ...progress } });
      }
      this.reissues.delete(key);
      await this.run(m, buildObjCleanupScript(m.id, b.idx), TIMEOUTS.clean).catch(() => undefined);
      return;
    }
    if (st.state === "dead") {
      await this.prisma.objectMigrationBucket.update({ where: { id: b.id }, data: { status: "FAILED", finishedAt: new Date(), lastError: "run-failed", ...progress } });
      return;
    }
    if (st.state === "absent") {
      // The detached helper is gone (hub restart race, manual removal): mirror is idempotent, so re-issue it, a bounded number of times.
      const n = (this.reissues.get(key) ?? 0) + 1;
      this.reissues.set(key, n);
      if (n > MAX_REISSUE) {
        await this.prisma.objectMigrationBucket.update({ where: { id: b.id }, data: { status: "FAILED", finishedAt: new Date(), lastError: "helper-missing" } });
        this.reissues.delete(key);
        return;
      }
      await this.dispatch(m, [b]).catch(() => undefined);
      return;
    }
    await this.prisma.objectMigrationBucket.update({ where: { id: b.id }, data: progress }); // running (or transitional): progress only
  }

  // ───────────────────────────── verify ─────────────────────────────

  /** `mc diff` per selected bucket (counts tallied in the script; no key leaves the host). From a FINAL bucket a clean diff
   *  is VERIFIED, a dirty one DIFFERS; from a SEEDED bucket the numbers are recorded and the status is unchanged (DONE is
   *  only reachable after a final pass). A missing marker, a non-zero mc exit or any error line is reported as a failure
   *  (lastError verify-failed), never as "no differences". */
  async verify(id: string): Promise<void> {
    const m = await this.load(id);
    if (!m) return;
    const sides = this.sides(m);
    const targets = m.buckets.filter((b) => b.selected && ["SEEDED", "FINAL", "VERIFIED", "DIFFERS"].includes(b.status));
    await this.prisma.objectMigration.update({ where: { id }, data: { status: "VERIFYING" } });
    try {
      for (let i = 0; i < targets.length; i += DU_GROUP) {
        const group = targets.slice(i, i + DU_GROUP);
        const r = await this.run(m, buildObjDiffScript(sides, group.map((b) => ({ src: b.srcBucket, dst: b.dstBucket }))), TIMEOUTS.diff);
        const parsed = parseDiff(r.output);
        for (const b of group) {
          const row = parsed.complete ? parsed.rows.get(b.srcBucket) : undefined;
          if (!row || row.rc !== 0 || row.errors > 0) {
            await this.prisma.objectMigrationBucket.update({ where: { id: b.id }, data: { lastError: "verify-failed", diffMissing: null, diffDiffer: null, diffExtra: null } });
            continue;
          }
          const du = parsed.du.get(b.srcBucket);
          const clean = row.missing === 0 && row.differ === 0;
          const afterFinal = b.status !== "SEEDED";
          await this.prisma.objectMigrationBucket.update({
            where: { id: b.id },
            data: {
              diffMissing: row.missing,
              diffDiffer: row.differ,
              diffExtra: row.extra,
              lastError: null,
              ...(du?.src ? { srcObjects: big(du.src.objects), srcBytes: big(du.src.bytes) } : {}),
              ...(du?.dst ? { dstObjects: big(du.dst.objects), dstBytes: big(du.dst.bytes) } : {}),
              ...(afterFinal ? { status: clean ? "VERIFIED" : "DIFFERS" } : {}),
            },
          });
        }
      }
    } finally {
      await this.refreshStatus(id, {});
    }
  }

  // ───────────────────────────── config carry ─────────────────────────────

  /** Apply the exported anonymous policy / lifecycle / tags to the destination buckets, AFTER the data. A failure only marks
   *  that bucket's configStatus FAILED (loud); it never touches data states. A policy for a renamed bucket has its ARNs
   *  rewritten to the destination name. */
  async carryConfig(id: string): Promise<{ applied: number; failed: number }> {
    const m = await this.load(id);
    if (!m) return { applied: 0, failed: 0 };
    const targets = m.buckets.filter((b) => b.selected && ["SEEDED", "FINAL", "VERIFIED", "DIFFERS"].includes(b.status) && (b.configStatus === "EXPORTED" || b.configStatus === "FAILED") && b.config);
    if (targets.length === 0) return { applied: 0, failed: 0 };
    const items: ObjConfigApply[] = [];
    const expected = new Map<string, Set<string>>();
    for (const b of targets) {
      const cfg = b.config as { policy?: string | null; lifecycle?: string | null; tags?: Array<[string, string]> | null };
      const item: ObjConfigApply = { dst: b.dstBucket };
      const want = new Set<string>();
      if (cfg.policy) {
        item.policy = b.srcBucket === b.dstBucket ? cfg.policy : rewriteArns(cfg.policy, b.srcBucket, b.dstBucket);
        want.add("policy");
      }
      if (cfg.lifecycle) {
        item.ilm = cfg.lifecycle;
        want.add("ilm");
      }
      if (cfg.tags && cfg.tags.length) {
        item.tags = cfg.tags;
        want.add("tag");
      }
      if (want.size) {
        items.push(item);
        expected.set(b.dstBucket, want);
      }
    }
    const r = await this.run(m, buildObjConfigApplyScript(this.sides(m), items), TIMEOUTS.cfg);
    const parsed = parseCfgResults(r.output);
    let applied = 0;
    let failed = 0;
    for (const b of targets) {
      const want = expected.get(b.dstBucket);
      if (!want) continue;
      const got = parsed.results.filter((x) => x.bucket === b.dstBucket);
      const ok = parsed.complete && [...want].every((k) => got.some((x) => x.kind === k && x.ok));
      await this.prisma.objectMigrationBucket.update({ where: { id: b.id }, data: { configStatus: ok ? "APPLIED" : "FAILED" } });
      if (ok) applied++;
      else failed++;
    }
    return { applied, failed };
  }

  // ───────────────────────────── cancel / cleanup ─────────────────────────────

  /** Cooperative cancel: stop polling, remove every helper, send running buckets back so a later `start` resumes. */
  async cancel(id: string): Promise<void> {
    const m = await this.load(id);
    if (!m) return;
    await this.prisma.objectMigration.update({ where: { id }, data: { cancelRequested: true } });
    const t = this.timers.get(id);
    if (t) {
      clearTimeout(t);
      this.timers.delete(id);
    }
    try {
      await this.run(m, buildObjCleanupScript(id), TIMEOUTS.clean);
    } catch {
      /* agent offline: the rows are reset below; any orphan helper is removed by the label sweep on the next start/cleanup */
    }
    for (const b of m.buckets) {
      if (!ACTIVE_BUCKET.has(b.status)) continue;
      const back: ObjectBucketStatus = b.status === "FINALIZING" || (b.status === "QUEUED" && m.phase === "final") ? "SEEDED" : "PENDING";
      await this.prisma.objectMigrationBucket.update({ where: { id: b.id }, data: { status: back, startedAt: null, finishedAt: null } });
    }
    await this.refreshStatus(id, { cancelRequested: false });
  }

  /** Best-effort removal of any helper of this migration (used on delete). */
  async cleanup(m: { id: string; targetServerId: string }): Promise<void> {
    try {
      await this.run(m, buildObjCleanupScript(m.id), TIMEOUTS.clean);
    } catch {
      /* best effort */
    }
    const t = this.timers.get(m.id);
    if (t) clearTimeout(t);
    this.timers.delete(m.id);
  }
}

/** Rewrite the source bucket's ARNs in an exported policy to the destination bucket's name (exact bucket boundary only). */
export function rewriteArns(policy: string, src: string, dst: string): string {
  const esc = src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return policy.replace(new RegExp(`arn:aws:s3:::${esc}(?=["/])`, "g"), `arn:aws:s3:::${dst}`);
}
