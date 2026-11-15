import { ConflictException } from "@nestjs/common";
import { MigrationTokenService } from "./migration-token.service";
import { hashMigrationToken, isMigrationToken } from "./migration-token";

function harness(findUniqueResult: unknown = null, updateManyCount = 1) {
  const prisma = {
    bulkOperation: {
      findUnique: jest.fn().mockResolvedValue(findUniqueResult),
      updateMany: jest.fn().mockResolvedValue({ count: updateManyCount }),
      update: jest.fn().mockResolvedValue({}),
    },
    migrationVolumeTransfer: { count: jest.fn().mockResolvedValue(1) },
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const svc = new MigrationTokenService(prisma as never, audit as never);
  return { svc, prisma, audit };
}

const live = (over: Record<string, unknown> = {}) => ({
  id: "op-1",
  kind: "import",
  actorId: "user-1",
  cancelRequestedAt: null,
  migrationTokenExpiresAt: new Date(Date.now() + 60_000),
  ...over,
});

describe("MigrationTokenService.validate", () => {
  it("resolves a live token to its op and looks up by HASH, never the raw token", async () => {
    const { svc, prisma } = harness(live());
    const raw = "tugra_mig_" + "a".repeat(43);
    const ctx = await svc.validate(raw);
    expect(ctx).toEqual({ opId: "op-1", actorId: "user-1", expiresAt: expect.any(Date) });
    expect(prisma.bulkOperation.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { migrationTokenHash: hashMigrationToken(raw) } }),
    );
  });

  it("returns null for unknown / wrong-kind / expired / cancelled / rolled-back / no-expiry", async () => {
    expect(await harness(null).svc.validate("x")).toBeNull();
    expect(await harness(live({ kind: "command" })).svc.validate("x")).toBeNull();
    expect(await harness(live({ migrationTokenExpiresAt: new Date(Date.now() - 1) })).svc.validate("x")).toBeNull();
    expect(await harness(live({ cancelRequestedAt: new Date() })).svc.validate("x")).toBeNull();
    expect(await harness(live({ meta: { rolledBackAt: new Date().toISOString() } })).svc.validate("x")).toBeNull();
    expect(await harness(live({ migrationTokenExpiresAt: null })).svc.validate("x")).toBeNull();
  });
});

describe("MigrationTokenService.issue (mint-if-absent)", () => {
  it("mints with a conditional WHERE (no live token) and returns a well-formed token + expiry", async () => {
    const { svc, prisma } = harness(null, 1);
    const res = await svc.issue("op-1");
    expect(isMigrationToken(res.token)).toBe(true);
    expect(res.expiresAt.getTime()).toBeGreaterThan(Date.now());
    const call = prisma.bulkOperation.updateMany.mock.calls[0][0];
    expect(call.where).toEqual(
      expect.objectContaining({ id: "op-1", OR: [{ migrationTokenHash: null }, { migrationTokenExpiresAt: { lt: expect.any(Date) } }] }),
    );
    expect(call.data.migrationTokenHash).toBe(hashMigrationToken(res.token)); // hash stored, not raw
    expect(JSON.stringify(call.data)).not.toContain(res.token);
  });

  it("409s when a token is already live (updateMany matched 0 rows)", async () => {
    const { svc } = harness(null, 0);
    await expect(svc.issue("op-1")).rejects.toThrow(ConflictException);
  });
});

describe("MigrationTokenService.reissue (rotate)", () => {
  it("unconditionally overwrites the hash (atomic revoke-old + mint-new)", async () => {
    const { svc, prisma } = harness();
    const res = await svc.reissue("op-1");
    expect(isMigrationToken(res.token)).toBe(true);
    const call = prisma.bulkOperation.update.mock.calls[0][0];
    expect(call.where).toEqual({ id: "op-1" });
    expect(call.data.migrationTokenHash).toBe(hashMigrationToken(res.token));
  });
});

describe("MigrationTokenService.revoke", () => {
  it("nulls a live token and audits once (idempotent: no audit when nothing was live)", async () => {
    const hit = harness(null, 1);
    expect(await hit.svc.revoke("op-1")).toBe(true);
    expect(hit.prisma.bulkOperation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "op-1", migrationTokenHash: { not: null } }, data: { migrationTokenHash: null, migrationTokenExpiresAt: null } }),
    );
    expect(hit.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "import.migration_token.revoke", target: "op-1" }));

    const miss = harness(null, 0);
    expect(await miss.svc.revoke("op-1")).toBe(false);
    expect(miss.audit.log).not.toHaveBeenCalled();
  });

  it("never writes the raw token or a hash into the audit meta", async () => {
    const { svc, audit } = harness(null, 1);
    await svc.revoke("op-1");
    expect(JSON.stringify(audit.log.mock.calls[0][0])).not.toMatch(/tugra_mig_|[a-f0-9]{64}/);
  });
});

describe("MigrationTokenService.extend (sliding renewal, hard cap)", () => {
  const H = 3_600_000;
  const row = (over: Record<string, unknown> = {}) => ({
    migrationTokenHash: "h",
    migrationTokenExpiresAt: new Date(Date.now() + 10 * 60_000),
    cancelRequestedAt: null,
    createdAt: new Date(Date.now() - 2 * H),
    meta: {},
    ...over,
  });

  afterEach(() => {
    delete process.env.MIGRATION_TOKEN_MAX_LIFE_HOURS;
  });

  it("slides the expiry to now + 1 h while a transfer is in flight, with a conditional WHERE", async () => {
    const { svc, prisma } = harness(row());
    const next = await svc.extend("op-1");
    expect(next!.getTime()).toBeGreaterThan(Date.now() + H - 5_000);
    expect(next!.getTime()).toBeLessThanOrEqual(Date.now() + H + 5_000);
    const call = prisma.bulkOperation.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: "op-1", migrationTokenHash: { not: null }, cancelRequestedAt: null });
    expect(call.data).toEqual({ migrationTokenExpiresAt: next });
    expect(prisma.migrationVolumeTransfer.count).toHaveBeenCalledWith({ where: { opId: "op-1", state: { in: ["PENDING", "COPYING", "COPIED", "APPLYING"] } } });
  });

  it("never extends past createdAt + the 72 h hard cap (and never shortens a longer-lived expiry)", async () => {
    const createdAt = new Date(Date.now() - 71.5 * H);
    const capped = await harness(row({ createdAt, migrationTokenExpiresAt: new Date(Date.now() + 5 * 60_000) })).svc.extend("op-1");
    expect(capped!.getTime()).toBe(createdAt.getTime() + 72 * H);
    // already at the cap: the current expiry is returned untouched, no write
    const atCap = harness(row({ createdAt, migrationTokenExpiresAt: new Date(createdAt.getTime() + 72 * H) }));
    const same = await atCap.svc.extend("op-1");
    expect(same!.getTime()).toBe(createdAt.getTime() + 72 * H);
    expect(atCap.prisma.bulkOperation.updateMany).not.toHaveBeenCalled();
  });

  it("honours MIGRATION_TOKEN_MAX_LIFE_HOURS", async () => {
    process.env.MIGRATION_TOKEN_MAX_LIFE_HOURS = "3";
    const createdAt = new Date(Date.now() - 2.5 * H);
    const next = await harness(row({ createdAt })).svc.extend("op-1");
    expect(next!.getTime()).toBe(createdAt.getTime() + 3 * H);
  });

  it("refuses terminal ops: revoked, expired, cancelled, rolled back, unknown, or no in-flight transfer", async () => {
    expect(await harness(null).svc.extend("op-1")).toBeNull();
    expect(await harness(row({ migrationTokenHash: null })).svc.extend("op-1")).toBeNull();
    expect(await harness(row({ migrationTokenExpiresAt: new Date(Date.now() - 1) })).svc.extend("op-1")).toBeNull();
    expect(await harness(row({ cancelRequestedAt: new Date() })).svc.extend("op-1")).toBeNull();
    expect(await harness(row({ meta: { rolledBackAt: new Date().toISOString() } })).svc.extend("op-1")).toBeNull();
    const idle = harness(row());
    idle.prisma.migrationVolumeTransfer.count.mockResolvedValue(0);
    expect(await idle.svc.extend("op-1")).toBeNull();
    expect(idle.prisma.bulkOperation.updateMany).not.toHaveBeenCalled();
  });

  it("returns null when a concurrent revoke wins the conditional update", async () => {
    expect(await harness(row(), 0).svc.extend("op-1")).toBeNull();
  });
});
