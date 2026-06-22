import { NotificationsService } from "./notifications.service";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";
import { CryptoService } from "../crypto/crypto.service";

const audit = { log: jest.fn() } as unknown as AuditService;
// reversible stub crypto: enc(<plain>)
const crypto = {
  encrypt: (s: string) => `enc(${s})`,
  decrypt: (s: string) => s.replace(/^enc\(/, "").replace(/\)$/, ""),
} as unknown as CryptoService;

function make(prisma: Partial<PrismaService>, access: Partial<TeamAccessService>) {
  return new NotificationsService(prisma as PrismaService, access as TeamAccessService, audit, crypto);
}

describe("NotificationsService", () => {
  it("encrypts the config blob on create (never plaintext)", async () => {
    const create = jest.fn().mockResolvedValue({ id: "c1", name: "n", type: "webhook", teamId: "t1", enabled: true, eventTypes: [] });
    const svc = make(
      { notificationChannel: { create } } as unknown as PrismaService,
      { requireRole: jest.fn().mockResolvedValue(undefined) },
    );
    await svc.create("u1", { name: "n", type: "webhook", teamId: "t1", config: { url: "https://x" }, eventTypes: ["deploy_failed"] });
    const data = create.mock.calls[0][0].data;
    expect(data.configEnc).toBe(`enc(${JSON.stringify({ url: "https://x" })})`);
    expect(data.eventTypes).toEqual(["deploy_failed"]);
    expect(data).not.toHaveProperty("config");
  });

  it("rejects an unsupported channel type", async () => {
    const svc = make({} as PrismaService, { requireRole: jest.fn().mockResolvedValue(undefined) });
    await expect(
      svc.create("u1", { name: "n", type: "carrierpigeon", teamId: "t1", config: {} }),
    ).rejects.toThrow(/unsupported/);
  });

  it("fireForEvent only queries enabled channels subscribed to the event", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const svc = make({ notificationChannel: { findMany } } as unknown as PrismaService, {});
    await svc.fireForEvent("t1", "deploy_failed", "boom");
    expect(findMany).toHaveBeenCalledWith({
      where: { teamId: "t1", enabled: true, eventTypes: { has: "deploy_failed" } },
    });
  });

  it("fireForEvent dispatches to matching channels and swallows provider errors", async () => {
    const findMany = jest.fn().mockResolvedValue([
      { id: "c1", type: "webhook", configEnc: `enc(${JSON.stringify({ url: "https://hook" })})` },
    ]);
    const fetchMock = jest.fn().mockResolvedValue({ ok: false, status: 500 });
    (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
    const svc = make({ notificationChannel: { findMany } } as unknown as PrismaService, {});
    await expect(svc.fireForEvent("t1", "deploy_failed", "boom")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith("https://hook", expect.objectContaining({ method: "POST" }));
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "notification.failed", target: "c1" }));
  });

  it("update can change eventTypes without re-encrypting when no config given", async () => {
    const existing = { id: "c1", teamId: "t1", name: "n", type: "webhook", enabled: true, eventTypes: [], configEnc: "enc({})" };
    const update = jest.fn().mockResolvedValue({ ...existing, eventTypes: ["server_offline"] });
    const svc = make(
      { notificationChannel: { findUnique: jest.fn().mockResolvedValue(existing), update } } as unknown as PrismaService,
      { requireRole: jest.fn().mockResolvedValue(undefined) },
    );
    const v = await svc.update("u1", "c1", { eventTypes: ["server_offline"] });
    expect(v.eventTypes).toEqual(["server_offline"]);
    expect(update.mock.calls[0][0].data).not.toHaveProperty("configEnc");
  });
});
