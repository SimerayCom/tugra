import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { ObjectMigration, ObjectMigrationBucket } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { CryptoService } from "../crypto/crypto.service";
import { TeamAccessService } from "../common/team-access.service";
import { ObjMigrationRunnerService, LIVE_BUCKET } from "./obj-migration-runner.service";
import type {
  CreateObjectMigrationInput,
  ObjectBucketStatus,
  ObjectBucketView,
  ObjectMigrationStatus,
  ObjectMigrationView,
  ObjectMigrationWarning,
  SetBucketsInput,
  StartObjectMigrationInput,
} from "./dto";
import { checkS3Endpoint } from "./endpoint";

const ACTIVE = new Set(["QUEUED", "SEEDING", "FINALIZING"]);
const num = (v: bigint | null): number | null => (v === null ? null : Number(v));

type Row = ObjectMigration & { buckets: ObjectMigrationBucket[] };

/** Project a row into the credential-free view. EXPORTED for the "no secrets in any view" tests. */
export function toObjectMigrationView(m: Row, canWrite: boolean): ObjectMigrationView {
  const bucket = (b: ObjectMigrationBucket): ObjectBucketView => {
    const cfg = (b.config ?? null) as { policy?: unknown; lifecycle?: unknown; tags?: unknown } | null;
    return {
      idx: b.idx,
      srcBucket: b.srcBucket,
      dstBucket: b.dstBucket,
      exclude: b.exclude,
      selected: b.selected,
      status: b.status as ObjectBucketStatus,
      srcObjects: num(b.srcObjects),
      srcBytes: num(b.srcBytes),
      dstObjects: num(b.dstObjects),
      dstBytes: num(b.dstBytes),
      doneObjects: num(b.doneObjects),
      doneBytes: num(b.doneBytes),
      diffMissing: b.diffMissing,
      diffDiffer: b.diffDiffer,
      diffExtra: b.diffExtra,
      versioning: b.versioning,
      configSummary: cfg ? { policy: !!cfg.policy, lifecycle: !!cfg.lifecycle, tags: Array.isArray(cfg.tags) && cfg.tags.length > 0 } : null,
      configStatus: b.configStatus,
      lastError: b.lastError,
      startedAt: b.startedAt,
      finishedAt: b.finishedAt,
    };
  };
  return {
    id: m.id,
    name: m.name,
    teamId: m.teamId,
    targetServerId: m.targetServerId,
    status: m.status as ObjectMigrationStatus,
    phase: m.phase === "seed" || m.phase === "final" ? m.phase : null,
    srcEndpoint: m.srcEndpoint,
    dstEndpoint: m.dstEndpoint,
    preserve: m.preserve,
    removeExtraneous: m.removeExtraneous,
    mergeIntoExisting: m.mergeIntoExisting,
    cancelRequested: m.cancelRequested,
    warnings: Array.isArray(m.warnings) ? (m.warnings as unknown as ObjectMigrationWarning[]) : [],
    buckets: [...m.buckets].sort((a, b) => a.idx - b.idx).map(bucket),
    canWrite,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    finishedAt: m.finishedAt,
  };
}

/**
 * Object (S3/MinIO) migration: authorization, validation and the state machine around the runner. Team-scoped
 * (`apps:config` on the team that owns the target server). Credentials are encrypted on create and decrypted ONLY inside the
 * runner when a script is built; no method here returns or audits them.
 */
@Injectable()
export class ObjectMigrationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly runner: ObjMigrationRunnerService,
  ) {}

  // ───────────────────────────── authorization ─────────────────────────────

  private async loadRow(id: string): Promise<Row> {
    const m = await this.prisma.objectMigration.findUnique({ where: { id }, include: { buckets: { orderBy: { idx: "asc" } } } });
    if (!m) throw new NotFoundException("object migration not found");
    return m;
  }

  private async authorizeRead(userId: string, id: string): Promise<{ m: Row; canWrite: boolean }> {
    const m = await this.loadRow(id);
    if (!(await this.access.teamRole(userId, m.teamId))) throw new ForbiddenException("not a member of this team");
    const perms = await this.access.membershipPermissions(userId, m.teamId);
    return { m, canWrite: !!perms?.has("apps:config") };
  }

  private async authorizeWrite(userId: string, id: string): Promise<Row> {
    const m = await this.loadRow(id);
    await this.access.requirePermission(userId, m.teamId, "apps:config");
    return m;
  }

  // ───────────────────────────── CRUD ─────────────────────────────

  async create(userId: string, input: CreateObjectMigrationInput): Promise<ObjectMigrationView> {
    const server = await this.prisma.server.findUnique({ where: { id: input.targetServerId }, select: { id: true, teamId: true } });
    if (!server) throw new NotFoundException("target server not found");
    await this.access.requirePermission(userId, server.teamId, "apps:config");
    const src = checkS3Endpoint(input.source.endpoint);
    const dst = checkS3Endpoint(input.destination.endpoint);
    if (!src.ok || !dst.ok) throw new BadRequestException("invalid endpoint"); // the DTO already refused; belt and braces
    if (src.endpoint === dst.endpoint) throw new BadRequestException("source and destination are the same endpoint");
    const m = await this.prisma.objectMigration.create({
      data: {
        teamId: server.teamId,
        createdById: userId,
        name: input.name,
        targetServerId: server.id,
        srcEndpoint: src.endpoint,
        srcAccessKeyEnc: this.crypto.encrypt(input.source.accessKey),
        srcSecretKeyEnc: this.crypto.encrypt(input.source.secretKey),
        dstEndpoint: dst.endpoint,
        dstAccessKeyEnc: this.crypto.encrypt(input.destination.accessKey),
        dstSecretKeyEnc: this.crypto.encrypt(input.destination.secretKey),
        preserve: input.preserve,
      },
      include: { buckets: true },
    });
    await this.audit.log({ actor: userId, action: "object_migration.create", target: m.id, meta: { name: m.name, targetServerId: server.id, srcEndpoint: m.srcEndpoint, dstEndpoint: m.dstEndpoint } });
    return toObjectMigrationView(m, true);
  }

  async list(userId: string, teamId?: string): Promise<ObjectMigrationView[]> {
    const perms = await this.access.permissionsByTeam(userId);
    const teamIds = teamId ? [teamId].filter((t) => perms.has(t)) : [...perms.keys()];
    if (teamId && teamIds.length === 0) throw new ForbiddenException("not a member of this team");
    const rows = await this.prisma.objectMigration.findMany({ where: { teamId: { in: teamIds } }, include: { buckets: true }, orderBy: { createdAt: "desc" }, take: 200 });
    return rows.map((m) => toObjectMigrationView(m, !!perms.get(m.teamId)?.has("apps:config")));
  }

  async get(userId: string, id: string): Promise<ObjectMigrationView> {
    const { m, canWrite } = await this.authorizeRead(userId, id);
    return toObjectMigrationView(m, canWrite);
  }

  private assertIdle(m: Row, what: string): void {
    if (m.buckets.some((b) => ACTIVE.has(b.status)) || m.status === "VERIFYING") throw new ConflictException(`cannot ${what} while helpers are running: cancel first`);
  }

  // ───────────────────────────── preflight / buckets ─────────────────────────────

  async preflight(userId: string, id: string): Promise<ObjectMigrationView> {
    const m = await this.authorizeWrite(userId, id);
    this.assertIdle(m, "re-run preflight");
    const warnings = await this.runner.preflight(m);
    await this.audit.log({ actor: userId, action: "object_migration.preflight", target: id, meta: { blockers: warnings.filter((w) => w.level === "blocker").map((w) => w.code), buckets: m.buckets.length } });
    return this.get(userId, id);
  }

  async setBuckets(userId: string, id: string, input: SetBucketsInput): Promise<ObjectMigrationView> {
    const m = await this.authorizeWrite(userId, id);
    if (m.status === "DRAFT" || m.buckets.length === 0) throw new ConflictException("run preflight first");
    this.assertIdle(m, "change the bucket selection");
    const bySrc = new Map(m.buckets.map((b) => [b.srcBucket, b]));
    const next = new Map<string, { selected: boolean; dst: string; exclude: string[]; dstChanged: boolean }>();
    for (const b of input.buckets) {
      const cur = bySrc.get(b.srcBucket);
      if (!cur) throw new BadRequestException(`unknown source bucket: ${b.srcBucket}`);
      const dst = b.dstBucket ?? cur.dstBucket;
      next.set(b.srcBucket, { selected: b.selected, dst, exclude: b.exclude ?? cur.exclude, dstChanged: dst !== cur.dstBucket });
    }
    // Two selected buckets may not land in the same destination bucket.
    const picked = [...m.buckets].map((b) => ({ src: b.srcBucket, sel: next.get(b.srcBucket)?.selected ?? b.selected, dst: next.get(b.srcBucket)?.dst ?? b.dstBucket })).filter((x) => x.sel);
    const seen = new Set<string>();
    for (const p of picked) {
      if (seen.has(p.dst)) throw new BadRequestException("two selected buckets map to the same destination bucket");
      seen.add(p.dst);
    }
    for (const [src, v] of next) {
      const cur = bySrc.get(src)!;
      await this.prisma.objectMigrationBucket.update({
        where: { id: cur.id },
        data: {
          selected: v.selected,
          dstBucket: v.dst,
          exclude: v.exclude,
          // a changed destination invalidates the measured destination counts: the next start demands a fresh preflight
          ...(v.dstChanged ? { dstObjects: null, dstBytes: null } : {}),
        },
      });
    }
    await this.runner.refreshStatus(id, {});
    return this.get(userId, id);
  }

  // ───────────────────────────── start / verify / config / cancel / delete ─────────────────────────────

  async start(userId: string, id: string, input: StartObjectMigrationInput): Promise<ObjectMigrationView> {
    const m = await this.authorizeWrite(userId, id);
    if (m.status === "DRAFT") throw new ConflictException("run preflight first");
    this.assertIdle(m, "start");
    const selected = m.buckets.filter((b) => b.selected);
    if (selected.length === 0) throw new BadRequestException("select at least one bucket");
    if (input.phase === "final") {
      if (input.acknowledgeWritesFrozen !== true) throw new BadRequestException("the final pass requires acknowledging that writes to the source are stopped");
      if (!["SEEDED", "FINAL", "FAILED", "DONE"].includes(m.status)) throw new ConflictException("run the seed pass first");
    } else {
      if (input.removeExtraneous) throw new BadRequestException("removeExtraneous only applies to the final pass");
      if (!["PREFLIGHTED", "SEEDED", "FAILED"].includes(m.status)) throw new ConflictException(`cannot seed from status ${m.status}`);
    }
    // Destination hygiene: an unmeasured destination (renamed since preflight) must be re-checked; a non-empty one needs the ack.
    const merge = input.mergeIntoExisting === true || m.mergeIntoExisting;
    for (const b of selected) {
      if (b.status === "PENDING") {
        // Only a bucket this migration never touched: a started one holds OUR OWN partial copy, which is not "existing" data.
        if (b.dstObjects === null) throw new ConflictException("the destination size of a selected bucket is unknown (changed or not measured): run preflight again");
        if (b.dstObjects > 0n && !merge) throw new BadRequestException("a destination bucket already has objects: acknowledge mergeIntoExisting to copy into it");
      }
    }
    // One active migration per (target server, source bucket, destination bucket).
    for (const b of selected) {
      const clash = await this.prisma.objectMigrationBucket.findFirst({
        where: { migrationId: { not: id }, srcBucket: b.srcBucket, dstBucket: b.dstBucket, status: { in: [...ACTIVE] }, migration: { targetServerId: m.targetServerId } },
        select: { id: true },
      });
      if (clash) throw new ConflictException("another migration is already copying this bucket pair on this server");
    }
    if (merge && !m.mergeIntoExisting) await this.prisma.objectMigration.update({ where: { id }, data: { mergeIntoExisting: true } });
    await this.runner.start(id, { phase: input.phase, remove: input.removeExtraneous === true, bucketIds: selected.map((b) => b.id) });
    await this.audit.log({
      actor: userId,
      action: input.phase === "final" ? "object_migration.final" : "object_migration.start",
      target: id,
      meta: { phase: input.phase, buckets: selected.length, removeExtraneous: input.phase === "final" && input.removeExtraneous === true, merge },
    });
    return this.get(userId, id);
  }

  async verify(userId: string, id: string): Promise<ObjectMigrationView> {
    const m = await this.authorizeWrite(userId, id);
    this.assertIdle(m, "verify");
    if (!["SEEDED", "FINAL", "DONE", "FAILED"].includes(m.status)) throw new ConflictException("verify runs after the seed or final pass");
    const eligible = m.buckets.filter((b) => b.selected && ["SEEDED", "FINAL", "VERIFIED", "DIFFERS"].includes(b.status));
    if (eligible.length === 0) throw new ConflictException("no seeded bucket to verify");
    await this.runner.verify(id);
    await this.audit.log({ actor: userId, action: "object_migration.verify", target: id, meta: { buckets: eligible.length } });
    return this.get(userId, id);
  }

  async carryConfig(userId: string, id: string): Promise<ObjectMigrationView> {
    const m = await this.authorizeWrite(userId, id);
    this.assertIdle(m, "carry the bucket configuration");
    if (!["SEEDED", "FINAL", "DONE"].includes(m.status)) throw new ConflictException("carry the configuration after the data has been copied");
    const r = await this.runner.carryConfig(id);
    await this.audit.log({ actor: userId, action: "object_migration.carry_config", target: id, meta: r });
    return this.get(userId, id);
  }

  async cancel(userId: string, id: string): Promise<ObjectMigrationView> {
    const m = await this.authorizeWrite(userId, id);
    if (!m.buckets.some((b) => ACTIVE.has(b.status))) throw new ConflictException("nothing is running");
    await this.runner.cancel(id);
    await this.audit.log({ actor: userId, action: "object_migration.cancel", target: id, meta: {} });
    return this.get(userId, id);
  }

  async remove(userId: string, id: string): Promise<{ ok: true }> {
    const m = await this.authorizeWrite(userId, id);
    if (m.buckets.some((b) => LIVE_BUCKET.has(b.status) || b.status === "QUEUED")) throw new ConflictException("a helper is still running: cancel first");
    await this.runner.cleanup(m);
    await this.prisma.objectMigration.delete({ where: { id } }); // cascades the bucket rows; the encrypted credentials go with it
    await this.audit.log({ actor: userId, action: "object_migration.delete", target: id, meta: { name: m.name } });
    return { ok: true };
  }
}
