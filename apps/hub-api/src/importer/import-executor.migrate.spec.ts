import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { ImportExecutorService } from "./import-executor.service";
import { isMigrationToken } from "./migration-token";

const BASE = "http://localhost:3000";
const freshExpiry = () => new Date(Date.now() + 3_600_000);

function harness(opts: {
  op?: Record<string, unknown>;
  serverMissing?: boolean;
  serverTeamId?: string;
  permissionThrows?: boolean;
} = {}) {
  const op = {
    id: "op-1",
    kind: "import",
    actorId: "user-1",
    planId: "h",
    meta: { sourceKind: "coolify", serverId: "srv-1" },
    cancelRequestedAt: null,
    migrationTokenHash: null,
    migrationTokenExpiresAt: null,
    createdAt: new Date(),
    tasks: [{ status: "DONE", resourceType: "database", resourceId: "db-1" }], // a real provisioned destination
    ...opts.op,
  };
  const prisma = {
    bulkTask: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) }, // loadOwnedOp stale reaper
    bulkOperation: { findUnique: jest.fn().mockResolvedValue(op), update: jest.fn().mockResolvedValue({}) },
    server: { findUnique: jest.fn().mockResolvedValue(opts.serverMissing ? null : { id: "srv-1", teamId: opts.serverTeamId ?? "team-1" }) },
  };
  const access = {
    requirePermission: opts.permissionThrows
      ? jest.fn().mockRejectedValue(new ForbiddenException("no apps:config"))
      : jest.fn().mockResolvedValue(undefined),
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const migrationTokens = {
    issue: jest.fn().mockResolvedValue({ token: "tugra_mig_" + "a".repeat(43), expiresAt: freshExpiry() }),
    reissue: jest.fn().mockResolvedValue({ token: "tugra_mig_" + "b".repeat(43), expiresAt: freshExpiry() }),
    revoke: jest.fn().mockResolvedValue(true),
  };
  const svc = new ImportExecutorService(
    prisma as never,
    {} as never,
    access as never,
    audit as never,
    {} as never,
    {} as never,
    {} as never,
    migrationTokens as never,
  );
  return { svc, prisma, access, audit, migrationTokens };
}

describe("ImportExecutorService.mintMigrationToken", () => {
  it("mints for the owner, audits, and returns a command embedding the token + migrator.sh", async () => {
    const { svc, audit, migrationTokens, prisma } = harness();
    const res = await svc.mintMigrationToken("user-1", "op-1", BASE);
    expect(migrationTokens.issue).toHaveBeenCalledWith("op-1");
    // Capture the trusted hub base (the actor's request) so the untrusted ingest path never derives it from a header.
    expect(prisma.bulkOperation.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ meta: expect.objectContaining({ hubBase: BASE }) }) }));
    expect(res.opId).toBe("op-1");
    expect(isMigrationToken(res.token)).toBe(true);
    expect(res.command).toBe(`curl -fsSL ${BASE}/install/migrator.sh | TUGRA_MIGRATION_TOKEN=${res.token} sh -s -- --hub ${BASE}`);
    expect(res.command).not.toContain("--token"); // token rides the env, never an argv
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "import.migration_token.mint", target: "op-1" }));
    expect(JSON.stringify(audit.log.mock.calls[0][0])).not.toContain(res.token); // never audit the secret
  });

  it("403s a non-owner, 404s a non-import op", async () => {
    await expect(harness({ op: { actorId: "someone-else" } }).svc.mintMigrationToken("user-1", "op-1", BASE)).rejects.toThrow(ForbiddenException);
    await expect(harness({ op: { kind: "command" } }).svc.mintMigrationToken("user-1", "op-1", BASE)).rejects.toThrow(NotFoundException);
  });

  it("409s when the op has no target server or the server is gone; 403 when the creator lost apps:config", async () => {
    await expect(harness({ op: { meta: {} } }).svc.mintMigrationToken("user-1", "op-1", BASE)).rejects.toThrow(ConflictException);
    await expect(harness({ serverMissing: true }).svc.mintMigrationToken("user-1", "op-1", BASE)).rejects.toThrow(ConflictException);
    await expect(harness({ permissionThrows: true }).svc.mintMigrationToken("user-1", "op-1", BASE)).rejects.toThrow(ForbiddenException);
  });

  it("409s a cancelled op", async () => {
    await expect(harness({ op: { cancelRequestedAt: new Date() } }).svc.mintMigrationToken("user-1", "op-1", BASE)).rejects.toThrow(ConflictException);
  });

  it("409s the states that are not a settled copy-mode import with a real destination", async () => {
    // local-docker adopts in place → no empty dest to migrate into
    await expect(harness({ op: { meta: { sourceKind: "local-docker", serverId: "srv-1" } } }).svc.mintMigrationToken("user-1", "op-1", BASE)).rejects.toThrow(ConflictException);
    // apply still running → no destination exists yet
    await expect(harness({ op: { tasks: [{ status: "RUNNING", resourceType: null, resourceId: null }] } }).svc.mintMigrationToken("user-1", "op-1", BASE)).rejects.toThrow(ConflictException);
    // nothing was provisioned (all skipped) → nothing to restore into
    await expect(harness({ op: { tasks: [{ status: "SKIPPED", resourceType: null, resourceId: null }] } }).svc.mintMigrationToken("user-1", "op-1", BASE)).rejects.toThrow(ConflictException);
    // rolled back → resources are gone (rollback can never be undone by minting again)
    await expect(harness({ op: { meta: { sourceKind: "coolify", serverId: "srv-1", rolledBackAt: new Date().toISOString() } } }).svc.mintMigrationToken("user-1", "op-1", BASE)).rejects.toThrow(ConflictException);
  });

  it("400s an unsafe hub base URL and does NOT mint a token (nothing left behind)", async () => {
    const { svc, migrationTokens } = harness();
    await expect(svc.mintMigrationToken("user-1", "op-1", "http://evil;rm -rf /")).rejects.toThrow(BadRequestException);
    expect(migrationTokens.issue).not.toHaveBeenCalled();
  });
});

describe("ImportExecutorService.reissueMigrationToken", () => {
  it("rotates via reissue (not issue) and audits as reissue", async () => {
    const { svc, migrationTokens, audit } = harness();
    const res = await svc.reissueMigrationToken("user-1", "op-1", BASE);
    expect(migrationTokens.reissue).toHaveBeenCalledWith("op-1");
    expect(migrationTokens.issue).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "import.migration_token.reissue" }));
    expect(res.command).toContain(res.token);
  });
});

describe("ImportExecutorService.migrateCommand", () => {
  it("reports inactive + a <TOKEN> template when no token is live, never the raw token", async () => {
    const res = await harness().svc.migrateCommand("user-1", "op-1", BASE);
    expect(res).toEqual({ opId: "op-1", active: false, expiresAt: null, commandTemplate: expect.stringContaining("<TOKEN>") });
    expect(res.commandTemplate).not.toContain("tugra_mig_");
  });

  it("reports active + expiry when a live token exists", async () => {
    const exp = freshExpiry();
    const res = await harness({ op: { migrationTokenHash: "deadbeef", migrationTokenExpiresAt: exp } }).svc.migrateCommand("user-1", "op-1", BASE);
    expect(res.active).toBe(true);
    expect(res.expiresAt).toEqual(exp);
  });

  it("reports inactive for an expired, cancelled, or rolled-back token", async () => {
    const expired = await harness({ op: { migrationTokenHash: "x", migrationTokenExpiresAt: new Date(Date.now() - 1) } }).svc.migrateCommand("user-1", "op-1", BASE);
    expect(expired.active).toBe(false);
    const cancelled = await harness({ op: { migrationTokenHash: "x", migrationTokenExpiresAt: freshExpiry(), cancelRequestedAt: new Date() } }).svc.migrateCommand("user-1", "op-1", BASE);
    expect(cancelled.active).toBe(false);
    const rolledBack = await harness({ op: { migrationTokenHash: "x", migrationTokenExpiresAt: freshExpiry(), meta: { sourceKind: "coolify", serverId: "srv-1", rolledBackAt: new Date().toISOString() } } }).svc.migrateCommand("user-1", "op-1", BASE);
    expect(rolledBack.active).toBe(false);
  });
});
