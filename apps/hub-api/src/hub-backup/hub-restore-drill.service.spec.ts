import { ConflictException } from "@nestjs/common";
import { HubRestoreDrillService } from "./hub-restore-drill.service";

const GOOD = "TUGRA_DRILL rc=0 tables=30\nTUGRA_DRILL_COUNT User 2\nTUGRA_DRILL_COUNT Team 1\nTUGRA_DRILL_COUNT Server 1\n";

function make(o: { local?: unknown; backup?: unknown; run?: { exitCode: number; output: string } | Error; inflight?: unknown } = {}) {
  const created = { id: "dr1", status: "RUNNING", trigger: "manual", backupFilename: null, tables: null, checks: null, errorTail: null, durationMs: null, createdAt: new Date(), completedAt: null };
  const update = jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...created, ...data, completedAt: new Date() }));
  const prisma = {
    server: { findFirst: jest.fn().mockResolvedValue("local" in o ? o.local : { id: "s1", teamId: "t1", capabilities: ["backup"] }) },
    hubBackupDrill: {
      findFirst: jest.fn().mockResolvedValue(o.inflight ?? null),
      create: jest.fn().mockResolvedValue(created),
      update,
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn(),
    },
    hubBackup: { findFirst: jest.fn().mockResolvedValue("backup" in o ? o.backup : { id: "b1", filename: "tugra-hub-x.dump.gz.gpg", destinationId: null }) },
  };
  const sendCommand = jest.fn(async () => { if (o.run instanceof Error) throw o.run; return o.run ?? { exitCode: 0, output: GOOD }; });
  const notifications = { fireForEvent: jest.fn().mockResolvedValue(undefined) };
  const backups = { destinationSpecById: jest.fn().mockResolvedValue({ type: "LOCAL", encryption: { enabled: false, key: "" } }) };
  const svc = new HubRestoreDrillService(prisma as never, { log: jest.fn() } as never, { sendCommand } as never, notifications as never, backups as never, { get: () => "k".repeat(32) } as never);
  return { svc, update, notifications, sendCommand };
}

describe("HubRestoreDrillService.run", () => {
  it("records a passing drill without a notification", async () => {
    const t = make();
    const r = await t.svc.run("manual", "u1");
    expect(r.status).toBe("SUCCESS");
    expect(r.tables).toBe(30);
    expect(r.checks).toEqual({ User: 2, Team: 1, Server: 1 });
    expect(t.notifications.fireForEvent).not.toHaveBeenCalled();
    expect(t.sendCommand).toHaveBeenCalledWith("s1", expect.stringContaining("--network none"), "backup", expect.any(Number));
  });

  it("fails and alerts through the restore-failed path when the restore is empty", async () => {
    const t = make({ run: { exitCode: 0, output: "TUGRA_DRILL rc=1 tables=0\n" } });
    const r = await t.svc.run("schedule");
    expect(r.status).toBe("FAILED");
    expect(r.errorTail).toContain("no-tables");
    expect(t.notifications.fireForEvent).toHaveBeenCalledWith("t1", "backup_restore_failed", expect.objectContaining({ dbName: "Tugra hub (restore drill)" }));
  });

  it("fails honestly when there is no backup to restore yet", async () => {
    const t = make({ backup: null });
    const r = await t.svc.run("schedule");
    expect(r.status).toBe("FAILED");
    expect(r.errorTail).toMatch(/no successful hub backup/);
    expect(t.sendCommand).not.toHaveBeenCalled();
  });

  it("scrubs the passphrase out of a failed script's output", async () => {
    const t = make({ run: { exitCode: 2, output: `gpg: bad passphrase ${"x".repeat(5)}` } });
    const r = await t.svc.run("manual");
    expect(r.status).toBe("FAILED");
    expect(r.errorTail).toContain("script-failed");
  });

  it("records a thrown agent error and refuses without a local server", async () => {
    const t = make({ run: new Error("agent offline") });
    expect((await t.svc.run("manual")).errorTail).toContain("agent offline");
    await expect(make({ local: null }).svc.run("manual")).rejects.toBeInstanceOf(ConflictException);
    await expect(make({ local: { id: "s", teamId: "t", capabilities: [] } }).svc.run("manual")).rejects.toBeInstanceOf(ConflictException);
  });

  it("returns the running drill instead of starting a second one", async () => {
    const running = { id: "dr0", status: "RUNNING", trigger: "schedule", backupFilename: null, tables: null, checks: null, errorTail: null, durationMs: null, createdAt: new Date(), completedAt: null };
    const t = make({ inflight: running });
    expect((await t.svc.run("manual")).id).toBe("dr0");
    expect(t.sendCommand).not.toHaveBeenCalled();
  });
});
