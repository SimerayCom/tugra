import { ConflictException } from "@nestjs/common";
import { DatabasesService } from "./databases.service";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { AgentOfflineException } from "../agent-gateway/agent-offline.exception";
import { CryptoService } from "../crypto/crypto.service";

const audit = { log: jest.fn() } as unknown as AuditService;
const crypto = {
  encrypt: (s: string) => `enc:${s}`,
  decrypt: (s: string) => s.replace(/^enc:/, ""),
} as unknown as CryptoService;

const row = (over: Record<string, unknown> = {}) => ({
  id: "db1",
  teamId: "t1",
  serverId: "s1",
  name: "main",
  engine: "POSTGRES",
  version: "16",
  image: "postgres:16",
  port: 5432,
  hostPort: null,
  credentials: `enc:${JSON.stringify({ username: "tugra", password: "pw", database: "main" })}`,
  envEnc: null,
  volumes: null,
  healthCmd: null,
  memoryMb: null,
  cpus: null,
  status: "RUNNING",
  pitrEnabled: false,
  pitrEnabledAt: null,
  ...over,
});

function make(db: Record<string, unknown>, sendResult: { output: string; exitCode: number } | Error = { output: "Up 1s", exitCode: 0 }) {
  const update = jest.fn((args: { data: Record<string, unknown> }) => Promise.resolve({ ...db, ...args.data }));
  const prisma = {
    database: { findUnique: jest.fn().mockResolvedValue(db), update, delete: jest.fn().mockResolvedValue(db) },
    appDatabaseLink: { findMany: jest.fn().mockResolvedValue([]) },
  } as unknown as PrismaService;
  const access = {
    requirePermission: jest.fn().mockResolvedValue(undefined),
    teamRole: jest.fn().mockResolvedValue("OWNER"),
    requireResourceAccess: jest.fn().mockResolvedValue(undefined),
    permissionsByTeam: jest.fn().mockResolvedValue(new Map([["t1", new Set(["databases"])]])),
  } as unknown as TeamAccessService;
  const sendCommand = jest.fn(() => (sendResult instanceof Error ? Promise.reject(sendResult) : Promise.resolve(sendResult)));
  const svc = new DatabasesService(
    prisma,
    access,
    audit,
    { sendCommand } as unknown as AgentWsServer,
    { stream: jest.fn() } as unknown as import("../agent-gateway/log-stream.service").LogStreamService,
    { forApp: jest.fn() } as unknown as import("../metrics/container-metrics.service").ContainerMetricsService,
    crypto,
    { resolveDefaultEnvironmentId: jest.fn() } as unknown as import("../teams/team-defaults.service").TeamDefaultsService,
  );
  return { svc, sendCommand, update };
}

const script = (sendCommand: jest.Mock, i = 0) => String(sendCommand.mock.calls[i][1]);

describe("DatabasesService.reprovision (PITR recreate seam)", () => {
  it("{pitr:true} arms archiving even though the row flag is still false (flag-first enable reads the override)", async () => {
    const { svc, sendCommand } = make(row({ pitrEnabled: false }));
    const out = await svc.reprovision(row() as never, "u1", { pitr: true });
    const s = script(sendCommand);
    expect(s).toContain("-c archive_mode=on");
    expect(s).toContain("-v /etc/tugra/wal/db1:/tugra-wal");
    expect(out).toMatchObject({ exitCode: 0, output: "Up 1s" });
    expect(out.row.status).toBe("RUNNING");
    expect(out.error).toBeUndefined();
  });

  it("{pitr:false} turns archiving OFF even though the row flag is still true (flag-last disable / rollback)", async () => {
    const { svc, sendCommand } = make(row({ pitrEnabled: true }));
    await svc.reprovision(row({ pitrEnabled: true }) as never, "u1", { pitr: false });
    expect(script(sendCommand)).not.toContain("archive_mode");
    expect(script(sendCommand)).not.toContain("/tugra-wal");
  });

  it("an agent throw (offline) is swallowed into FAILED with `error` set — never a rejection", async () => {
    const { svc } = make(row(), new AgentOfflineException());
    const out = await svc.reprovision(row() as never, "u1", { pitr: true });
    expect(out.row.status).toBe("FAILED");
    expect(out.exitCode).toBeNull();
    expect(out.error).toMatch(/offline/i);
  });

  it("a non-zero script exit is FAILED with the exit code + output preserved", async () => {
    const { svc } = make(row(), { output: "docker: pull failed", exitCode: 1 });
    const out = await svc.reprovision(row() as never, "u1", { pitr: true });
    expect(out.row.status).toBe("FAILED");
    expect(out).toMatchObject({ exitCode: 1, output: "docker: pull failed" });
  });

  it("the user provision() path is unchanged: it follows the ROW flag (no override) and audits database.provision", async () => {
    const { svc, sendCommand } = make(row({ pitrEnabled: false }));
    await svc.provision("u1", "db1");
    expect(script(sendCommand)).not.toContain("archive_mode");
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "database.provision", target: "db1" }));
  });

  it("provision() of an ENABLED row keeps archiving on (a re-provision never silently disarms PITR)", async () => {
    const { svc, sendCommand } = make(row({ pitrEnabled: true }));
    await svc.provision("u1", "db1");
    expect(script(sendCommand)).toContain("-c archive_mode=on");
  });
});

describe("DatabasesService.remove — WAL spool reclaim", () => {
  it("a PITR database's removal also reclaims its host WAL spool", async () => {
    const { svc, sendCommand } = make(row({ pitrEnabled: true }));
    await svc.remove("u1", "db1");
    expect(script(sendCommand)).toContain("rm -rf /etc/tugra/wal/db1");
  });

  it("a non-PITR database's remove script is byte-identical (no spool line)", async () => {
    const { svc, sendCommand } = make(row({ pitrEnabled: false }));
    await svc.remove("u1", "db1");
    expect(script(sendCommand)).not.toContain("/etc/tugra/wal");
  });
});

describe("DatabasesService maintenance lock (mutual exclusion with PITR transitions)", () => {
  it("provision / stop / remove refuse (409) while the lock is held, and work again once released", async () => {
    const { svc, sendCommand } = make(row());
    const release = svc.acquireMaintenance("db1");
    expect(svc.isUnderMaintenance("db1")).toBe(true);
    await expect(svc.provision("u1", "db1")).rejects.toBeInstanceOf(ConflictException);
    await expect(svc.stop("u1", "db1")).rejects.toBeInstanceOf(ConflictException);
    await expect(svc.remove("u1", "db1")).rejects.toBeInstanceOf(ConflictException);
    expect(sendCommand).not.toHaveBeenCalled(); // nothing reached the agent
    release();
    expect(svc.isUnderMaintenance("db1")).toBe(false);
    await svc.provision("u1", "db1");
    expect(sendCommand).toHaveBeenCalledTimes(1);
  });

  it("a second acquire of a held lock is a 409; provision() holds the lock only for its own duration", async () => {
    const { svc } = make(row());
    const release = svc.acquireMaintenance("db1");
    expect(() => svc.acquireMaintenance("db1")).toThrow(ConflictException);
    release();
    await svc.provision("u1", "db1");
    expect(svc.isUnderMaintenance("db1")).toBe(false); // released after the recreate
  });

  it("stop() and remove() HOLD the lock for their duration (not just test it) and release it afterwards", async () => {
    const a = make(row());
    await a.svc.stop("u1", "db1");
    expect(a.svc.isUnderMaintenance("db1")).toBe(false);
    const b = make(row());
    await b.svc.remove("u1", "db1");
    expect(b.svc.isUnderMaintenance("db1")).toBe(false);
  });

  it("provision() re-reads the row under the lock and follows the CURRENT flag, not the pre-lock snapshot", async () => {
    // requireWrite loads pitrEnabled=true, but by the time the lock is taken the row has been disabled (false):
    // the run script must NOT arm archiving.
    const { svc, sendCommand } = make(row({ pitrEnabled: true }));
    const prisma = (svc as unknown as { prisma: { database: { findUnique: jest.Mock } } }).prisma;
    prisma.database.findUnique.mockResolvedValueOnce(row({ pitrEnabled: true })).mockResolvedValue(row({ pitrEnabled: false }));
    await svc.provision("u1", "db1");
    expect(script(sendCommand)).not.toContain("archive_mode");
  });
});

describe("DatabasesService — PITR replay seams (5.6a)", () => {
  const T = new Date("2026-11-13T10:20:30.123Z");

  it("reprovision({recovery}) starts the container in archive recovery toward the target, never archiving", async () => {
    const { svc, sendCommand } = make(row({ pitrEnabled: true }));
    await svc.reprovision(row({ pitrEnabled: true }) as never, "u1", { pitr: false, recovery: { targetTime: T } });
    const s = script(sendCommand);
    expect(s).toContain("-v /etc/tugra/wal-restore/db1:/tugra-wal-restore:ro");
    expect(s).toContain("-c recovery_target_time='2026-11-13 10:20:30.123+00'");
    expect(s).not.toContain("archive_mode=on");
  });

  it("createRecoveryTarget: NEW row on the same server with the SAME credentials, carried config, backups/PITR off", async () => {
    const src = row({ pitrEnabled: true, pitrEnabledAt: new Date(), backupDestinationId: "d1", tags: ["prod"], memoryMb: 512, environmentId: "env1" });
    const create = jest.fn((args: { data: Record<string, unknown> }) => Promise.resolve({ id: "new1", ...args.data }));
    const { svc } = make(src);
    (svc as unknown as { prisma: { database: Record<string, jest.Mock> } }).prisma.database.create = create;
    const out = await svc.createRecoveryTarget(src as never, {}, "u1");
    expect(out.id).toBe("new1");
    const data = create.mock.calls[0][0].data;
    expect(data).toMatchObject({ name: "main (restored)", engine: "POSTGRES", version: "16", image: "postgres:16", hostPort: null, serverId: "s1", teamId: "t1", environmentId: "env1", status: "NEW", backupDestinationId: "d1", tags: ["prod"], memoryMb: 512 });
    // same creds as the source (the base tar's roles/password hashes are authoritative)
    expect(data.credentials).toBe(`enc:${JSON.stringify({ username: "tugra", password: "pw", database: "main" })}`);
    // nothing arms archiving/backups on the copy
    expect(data).not.toHaveProperty("pitrEnabled");
    expect(data).not.toHaveProperty("backupEnabled");
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "database.pitr.restore_target", target: "new1", meta: { from: "db1" } }));
  });

  it("createRecoveryTarget honours a custom name (clamped to 60) and validates a different environment", async () => {
    const src = row({ environmentId: "env1" });
    const create = jest.fn((args: { data: Record<string, unknown> }) => Promise.resolve({ id: "new1", ...args.data }));
    const { svc } = make(src);
    const s = svc as unknown as { prisma: { database: Record<string, jest.Mock>; environment?: Record<string, jest.Mock> }; assertEnvInTeam: jest.Mock };
    s.prisma.database.create = create;
    const envCheck = jest.spyOn(svc as unknown as { assertEnvInTeam: (e: string, t: string) => Promise<void> }, "assertEnvInTeam").mockResolvedValue(undefined);
    await svc.createRecoveryTarget(src as never, { name: " x".repeat(50), environmentId: "env2" }, "u1");
    expect(envCheck).toHaveBeenCalledWith("env2", "t1");
    expect(String(create.mock.calls[0][0].data.name).length).toBeLessThanOrEqual(60);
    expect(create.mock.calls[0][0].data.environmentId).toBe("env2");
  });

  it("reapRecoveryTarget tears the target down best-effort (container + volume + row) and never throws", async () => {
    const { svc, sendCommand } = make(row());
    const prisma = (svc as unknown as { prisma: { database: Record<string, jest.Mock> } }).prisma.database;
    await svc.reapRecoveryTarget(row() as never, "u1");
    expect(script(sendCommand)).toContain("docker volume rm tugra_dbv_db1");
    expect(script(sendCommand)).toContain("rm -rf /etc/tugra/wal-restore/db1"); // staged WAL reclaimed too
    expect(prisma.delete).toHaveBeenCalled();
    sendCommand.mockRejectedValueOnce(new Error("offline"));
    await expect(svc.reapRecoveryTarget(row() as never, "u1")).resolves.toBeUndefined();
  });
});
