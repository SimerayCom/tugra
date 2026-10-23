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
