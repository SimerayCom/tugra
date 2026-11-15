import { ConflictException, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { generateMigrationToken, hashMigrationToken, MIGRATION_TOKEN_TTL_MS } from "./migration-token";
import { tokenMaxLifeMs } from "./volume-stream/vx-constants";

/** States of a migration volume transfer that are still in flight (a token may keep sliding while one exists). */
const LIVE_TRANSFER_STATES = ["PENDING", "COPYING", "COPIED", "APPLYING"] as const;

/** What the guard needs once a token is resolved — the opId (the host never names the destination itself). */
export interface MigrationTokenContext {
  opId: string;
  actorId: string;
  expiresAt: Date;
}

/**
 * The lifecycle of an importer one-time migration token, mounted on BulkOperation. Stores ONLY the SHA-256
 * (mirrors ApiToken, never the enroll token's plaintext). Mint-if-absent vs. reissue is the difference
 * between "start" (refuse to clobber a command already pasted on the source host) and "rotate" (replace it).
 * Revoke nulls the hash so the unique-hash lookup stops matching. Depends on Prisma + Audit only (both
 * @Global) so it never participates in the importer's DI cycle.
 */
@Injectable()
export class MigrationTokenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Guard path: resolve a raw token to its op, or null for unknown/expired/revoked/cancelled/rolled-back/wrong-kind. */
  async validate(raw: string): Promise<MigrationTokenContext | null> {
    const op = await this.prisma.bulkOperation.findUnique({
      where: { migrationTokenHash: hashMigrationToken(raw) },
      select: { id: true, kind: true, actorId: true, cancelRequestedAt: true, migrationTokenExpiresAt: true, meta: true },
    });
    if (!op || op.kind !== "import" || op.cancelRequestedAt) return null;
    // Defence in depth: a rolled-back op's resources are gone. Even if rollback's best-effort revoke was
    // missed, the persistent meta.rolledBackAt marker still refuses the token here.
    const meta = typeof op.meta === "object" && op.meta ? (op.meta as { rolledBackAt?: string }) : {};
    if (meta.rolledBackAt) return null;
    if (!op.migrationTokenExpiresAt || op.migrationTokenExpiresAt.getTime() <= Date.now()) return null;
    return { opId: op.id, actorId: op.actorId, expiresAt: op.migrationTokenExpiresAt };
  }

  /**
   * Mint a token ONLY if none is live (a NULL or already-expired hash) — the conditional WHERE removes the
   * check-then-write race, and refuses (409) to silently invalidate a token the host may already hold.
   */
  async issue(opId: string): Promise<{ token: string; expiresAt: Date }> {
    const token = generateMigrationToken();
    const expiresAt = new Date(Date.now() + MIGRATION_TOKEN_TTL_MS);
    const res = await this.prisma.bulkOperation.updateMany({
      where: { id: opId, OR: [{ migrationTokenHash: null }, { migrationTokenExpiresAt: { lt: new Date() } }] },
      data: { migrationTokenHash: hashMigrationToken(token), migrationTokenExpiresAt: expiresAt },
    });
    if (res.count !== 1) throw new ConflictException("a migration token is already active — reissue it");
    return { token, expiresAt };
  }

  /**
   * Rotate: unconditionally replace the hash (the single-row UPDATE IS the atomic revoke-old + mint-new —
   * only one hash column exists, so two valid tokens can never coexist). Doubles as a first mint.
   */
  async reissue(opId: string): Promise<{ token: string; expiresAt: Date }> {
    const token = generateMigrationToken();
    const expiresAt = new Date(Date.now() + MIGRATION_TOKEN_TTL_MS);
    await this.prisma.bulkOperation.update({
      where: { id: opId },
      data: { migrationTokenHash: hashMigrationToken(token), migrationTokenExpiresAt: expiresAt },
    });
    return { token, expiresAt };
  }

  /**
   * Sliding renewal for a long streamed copy: `expiresAt = min(now + 1 h, op.createdAt + MIGRATION_TOKEN_MAX_LIFE_HOURS)`.
   * Only while the hash is live (non-null, not expired), the op is not cancelled / rolled back, and a NON-TERMINAL
   * volume transfer exists. Never shortens an expiry, never mints or rotates a secret (same token on the wire) and
   * `revoke` still kills it. Returns the (possibly unchanged) expiry, or null when no renewal is allowed.
   */
  async extend(opId: string): Promise<Date | null> {
    const op = await this.prisma.bulkOperation.findUnique({
      where: { id: opId },
      select: { migrationTokenHash: true, migrationTokenExpiresAt: true, cancelRequestedAt: true, createdAt: true, meta: true },
    });
    if (!op || !op.migrationTokenHash || !op.migrationTokenExpiresAt || op.cancelRequestedAt) return null;
    const meta = typeof op.meta === "object" && op.meta ? (op.meta as { rolledBackAt?: string }) : {};
    if (meta.rolledBackAt) return null;
    const now = Date.now();
    const current = op.migrationTokenExpiresAt;
    if (current.getTime() <= now) return null;
    const live = await this.prisma.migrationVolumeTransfer.count({ where: { opId, state: { in: [...LIVE_TRANSFER_STATES] } } });
    if (live === 0) return null;
    const target = Math.min(now + MIGRATION_TOKEN_TTL_MS, op.createdAt.getTime() + tokenMaxLifeMs());
    if (target <= current.getTime()) return current; // already at (or beyond) the cap: never shorten, never extend past it
    const next = new Date(target);
    const res = await this.prisma.bulkOperation.updateMany({
      where: { id: opId, migrationTokenHash: { not: null }, cancelRequestedAt: null },
      data: { migrationTokenExpiresAt: next },
    });
    return res.count === 1 ? next : null;
  }

  /** Kill any live token for an op (on cancel/rollback/complete). Idempotent; audits only when it took effect. */
  async revoke(opId: string, actor = `import:${opId}`): Promise<boolean> {
    const res = await this.prisma.bulkOperation.updateMany({
      where: { id: opId, migrationTokenHash: { not: null } },
      data: { migrationTokenHash: null, migrationTokenExpiresAt: null },
    });
    if (res.count > 0) {
      await this.audit.log({ actor, action: "import.migration_token.revoke", target: opId });
    }
    return res.count > 0;
  }
}
