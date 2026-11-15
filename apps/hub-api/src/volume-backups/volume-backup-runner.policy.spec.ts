import { VolumeBackupRunnerService } from "./volume-backup-runner.service";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { CryptoService } from "../crypto/crypto.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { NotificationsService } from "../notifications/notifications.service";
import { GIB } from "../backups/retention";

const DAY = 86_400_000;
const crypto = { decrypt: (s: string) => s.replace(/^enc:/, "") } as unknown as CryptoService;

const baseApp = {
  id: "app1", name: "blog", teamId: "t1", serverId: "s1",
  volumes: [{ name: "data" }, { name: "media" }, { name: "cache" }],
  volumeBackupDestinationId: null as string | null,
  volumeBackupRetention: 7,
  volumeBackupRetentionDays: null as number | null,
  volumeBackupMaxSizeGb: null as number | null,
};

function make(opts: { app?: Partial<typeof baseApp>; dest?: unknown; policies?: unknown[]; rows?: unknown[]; send?: jest.Mock } = {}) {
  const app = { ...baseApp, ...opts.app };
  const created: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const del = jest.fn().mockResolvedValue({});
  const prisma = {
    application: { findUnique: jest.fn().mockResolvedValue(app) },
    backupDestination: { findUnique: jest.fn().mockResolvedValue(opts.dest ?? null) },
    volumeBackupPolicy: { findMany: jest.fn().mockResolvedValue(opts.policies ?? []) },
    appMove: { findFirst: jest.fn().mockResolvedValue(null) }, // no app move in flight (D guard)
    volumeBackup: {
      create: jest.fn().mockImplementation(({ data }) => {
        created.push(data);
        return Promise.resolve({ id: `vb${created.length}` });
      }),
      update: jest.fn().mockImplementation(({ data }) => {
        updates.push(data);
        return Promise.resolve({});
      }),
      findUnique: jest.fn().mockResolvedValue({ id: "vb", status: "SUCCESS" }),
      findMany: jest.fn().mockResolvedValue(opts.rows ?? []),
      delete: del,
    },
  } as unknown as PrismaService;
  const send = opts.send ?? jest.fn().mockResolvedValue({ exitCode: 0, output: "1024" });
  const alerts = { shouldNotifyFailure: jest.fn().mockResolvedValue(true), recover: jest.fn().mockResolvedValue(false) };
  const svc = new VolumeBackupRunnerService(
    prisma,
    { log: jest.fn() } as unknown as AuditService,
    crypto,
    { sendCommand: send } as unknown as AgentWsServer,
    { fireForEvent: jest.fn().mockResolvedValue(undefined) } as unknown as NotificationsService,
    alerts as never,
  );
  return { svc, created, updates, send, del, alerts };
}

describe("VolumeBackupRunnerService — encryption on every destination type (volume-LOCAL fix)", () => {
  const localEnc = { id: "d1", type: "LOCAL", encryptionEnabled: true, encryptionKey: "enc:KEY123456" };

  it("a LOCAL+encrypted destination yields a .gpg filename and a gpg stage", async () => {
    const { svc, created, send } = make({ app: { volumeBackupDestinationId: "d1" }, dest: localEnc });
    await svc.runBackup("app1", "u1");
    expect(created[0].filename).toMatch(/\.tar\.gz\.gpg$/);
    expect(created[0].destinationId).toBe("d1");
    const script = send.mock.calls[0][1] as string;
    expect(script).toContain("--symmetric --cipher-algo AES256");
    expect(script).toContain("TUGRA_GPG_MISSING");
  });

  it("TUGRA_GPG_MISSING (exit 5) maps to a one-line errorTail with the key scrubbed", async () => {
    const send = jest.fn().mockResolvedValue({ exitCode: 5, output: "TUGRA_GPG_MISSING: gpg not found on this host (install gnupg) KEY123456" });
    const { svc, updates } = make({ app: { volumeBackupDestinationId: "d1" }, dest: localEnc, send });
    await svc.runBackup("app1", "u1");
    expect(updates[0].status).toBe("FAILED");
    expect(updates[0].errorTail).toContain("TUGRA_GPG_MISSING");
    expect(String(updates[0].errorTail)).not.toContain("KEY123456");
    expect(String(updates[0].errorTail).includes("\n")).toBe(false);
  });

it("fails closed when the destination is encrypted but its key is missing (manual run: no row is created)", async () => {
    const { svc, created } = make({ app: { volumeBackupDestinationId: "d1" }, dest: { ...localEnc, encryptionKey: null } });
    await expect(svc.runBackup("app1", "u1")).rejects.toThrow(/key is missing/);
    expect(created).toHaveLength(0);
  });
});

describe("VolumeBackupRunnerService.runBackup — unresolvable destination", () => {
  const noKey = { id: "d1", type: "LOCAL", encryptionEnabled: true, encryptionKey: null };

  it("a manual run is told why with a typed 422 (not a bare 500)", async () => {
    const { svc } = make({ app: { volumeBackupDestinationId: "d1" }, dest: noKey });
    await expect(svc.runBackup("app1", "u1")).rejects.toMatchObject({ status: 422, response: expect.objectContaining({ code: "destination_key_missing" }) });
  });

  it("a SCHEDULED run records a FAILED row per volume, sends nothing, and fires the failure alert", async () => {
    const { svc, created, updates, send, alerts } = make({ app: { volumeBackupDestinationId: "d1" }, dest: noKey });
    const rows = await svc.runBackup("app1", "scheduler", { only: ["data"] });
    expect(rows).toHaveLength(1);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ volumeName: "data", destinationId: "d1", filename: expect.stringMatching(/\.tar\.gz$/) });
    expect(send).not.toHaveBeenCalled();
    expect(updates[0]).toMatchObject({ status: "FAILED", errorTail: expect.stringContaining("key is missing") });
    expect(alerts.shouldNotifyFailure).toHaveBeenCalledWith("volume", "app1:data");
  });
});

describe("VolumeBackupRunnerService.runBackup — volume selection + alert ids", () => {
  it("no opts backs up every volume (manual backup now)", async () => {
    const { svc, created } = make();
    await svc.runBackup("app1", "u1");
    expect(created.map((c) => c.volumeName)).toEqual(["data", "media", "cache"]);
  });

  it("only restricts to the named volumes and ignores unknown names", async () => {
    const { svc, created } = make();
    await svc.runBackup("app1", "scheduler", { only: ["media", "ghost"] });
    expect(created.map((c) => c.volumeName)).toEqual(["media"]);
  });

  it("excludePolicied skips volumes carved out (disabled or own schedule) but keeps inherit-only policies", async () => {
    const policies = [
      { volumeName: "media", enabled: true, cron: "0 * * * *", intervalHours: null },
      { volumeName: "cache", enabled: false, cron: null, intervalHours: null },
      { volumeName: "data", enabled: true, cron: null, intervalHours: null }, // retention-only override
    ];
    const { svc, created } = make({ policies });
    await svc.runBackup("app1", "scheduler", { excludePolicied: true });
    expect(created.map((c) => c.volumeName)).toEqual(["data"]);
  });

  it("an `only` run keys alert state on appId:volumeName; other runs use appId", async () => {
    const send = jest.fn().mockResolvedValue({ exitCode: 1, output: "boom" });
    const only = make({ send });
    await only.svc.runBackup("app1", "scheduler", { only: ["media"] });
    expect(only.alerts.shouldNotifyFailure).toHaveBeenCalledWith("volume", "app1:media");
    const ok = make();
    await ok.svc.runBackup("app1", "scheduler", { only: ["media"] });
    expect(ok.alerts.recover).toHaveBeenCalledWith("volume", "app1:media", "t1", expect.anything());
    const all = make();
    await all.svc.runBackup("app1", "u1");
    expect(all.alerts.recover).toHaveBeenCalledWith("volume", "app1", "t1", expect.anything());
  });
});

describe("VolumeBackupRunnerService.prune — whole-app plan with per-volume policies", () => {
  const now = Date.now();
  const r = (id: string, vol: string, ageDays: number, gb: number | null) => ({
    id, volumeName: vol, filename: `${id}.tar.gz`, destinationId: null, status: "SUCCESS",
    createdAt: new Date(now - ageDays * DAY), sizeBytes: gb == null ? null : BigInt(gb) * GIB,
  });

  it("applies the app's keep-N per volume, and a policy's retention/age override for its volume", async () => {
    const rows = [r("d1", "data", 1, 1), r("d2", "data", 2, 1), r("d3", "data", 3, 1), r("m1", "media", 1, 1), r("m2", "media", 2, 1), r("m3", "media", 40, 1)];
    const policies = [{ volumeName: "media", retention: 5, retentionDays: 30, maxSizeGb: null }];
    const { svc, del } = make({ app: { volumeBackupRetention: 2 }, rows, policies });
    await svc.prune({ ...baseApp, volumeBackupRetention: 2 } as never);
    const removed = del.mock.calls.map((c) => c[0].where.id).sort();
    // data keeps 2 -> d3 goes; media keeps 5 but maxAge 30 -> m3 goes
    expect(removed).toEqual(["d3", "m3"]);
  });

  it("shares ONE size pool across volumes without their own budget, and gives a budgeted volume its own pool", async () => {
    const rows = [
      r("d1", "data", 1, 4), r("d2", "data", 5, 4), r("c1", "cache", 2, 4), r("c2", "cache", 6, 4),
      r("m1", "media", 1, 6), r("m2", "media", 9, 6),
    ];
    const policies = [{ volumeName: "media", retention: null, retentionDays: null, maxSizeGb: 8 }];
    const { svc, del } = make({ app: { volumeBackupMaxSizeGb: 10 }, rows, policies });
    await svc.prune({ ...baseApp, volumeBackupMaxSizeGb: 10 } as never);
    const removed = del.mock.calls.map((c) => c[0].where.id).sort();
    // app pool (data+cache): 16 GiB > 10 -> oldest unprotected first: c2 (6d) then d2 (5d) -> 8 GiB
    // media pool: 12 > 8 -> m2 goes (m1 protected)
    expect(removed).toEqual(["c2", "d2", "m2"]);
  });

  it("a volume literally named \"app\" with its own budget does NOT merge into the shared pool", async () => {
    const rows = [
      r("a1", "app", 1, 6), r("a2", "app", 9, 6), // own pool, cap 8 -> a2 goes (a1 protected)
      r("d1", "data", 1, 4), r("d2", "data", 5, 4), // shared pool, cap 100 GiB -> nothing goes
    ];
    const policies = [{ volumeName: "app", retention: null, retentionDays: null, maxSizeGb: 8 }];
    const { svc, del } = make({ app: { volumes: [{ name: "app" }, { name: "data" }], volumeBackupMaxSizeGb: 100 }, rows, policies });
    await svc.prune({ ...baseApp, volumes: [{ name: "app" }, { name: "data" }], volumeBackupMaxSizeGb: 100 } as never);
    expect(del.mock.calls.map((c) => c[0].where.id).sort()).toEqual(["a2"]);
  });

  it("never removes the newest backup of a volume, even when over budget", async () => {
    const rows = [r("d1", "data", 1, 50)];
    const { svc, del } = make({ app: { volumeBackupMaxSizeGb: 1 }, rows });
    await svc.prune({ ...baseApp, volumeBackupMaxSizeGb: 1 } as never);
    expect(del).not.toHaveBeenCalled();
  });

  it("with no age and no size it equals the old keep-N-per-volume rule and ignores undeclared volumes", async () => {
    const rows = [r("d1", "data", 1, 1), r("d2", "data", 2, 1), r("d3", "data", 3, 1), r("g1", "ghost", 1, 1), r("g2", "ghost", 2, 1)];
    const { svc, del } = make({ app: { volumeBackupRetention: 1 }, rows });
    await svc.prune({ ...baseApp, volumeBackupRetention: 1 } as never);
    expect(del.mock.calls.map((c) => c[0].where.id).sort()).toEqual(["d2", "d3"]);
  });
});
