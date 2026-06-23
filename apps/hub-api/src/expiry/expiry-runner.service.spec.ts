import { ExpiryRunnerService } from "./expiry-runner.service";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";

function make(prisma: Partial<PrismaService>, fire = jest.fn().mockResolvedValue(undefined)) {
  const notifications = { fireForEvent: fire } as unknown as NotificationsService;
  const svc = new ExpiryRunnerService(prisma as PrismaService, notifications);
  return { svc, fire };
}

function inDays(n: number): Date {
  return new Date(Date.now() + n * 86_400_000 + 3600_000); // +1h so floor lands on n
}

describe("ExpiryRunnerService", () => {
  describe("shouldNotify", () => {
    it("fires only on the 14/7/3/1-day thresholds", () => {
      const { svc } = make({});
      for (const d of [14, 7, 3, 1]) expect(svc.shouldNotify(d)).toBe(true);
      for (const d of [30, 10, 0, -2]) expect(svc.shouldNotify(d)).toBe(false);
    });
  });

  describe("checkTokens", () => {
    it("warns the owner's teams when a token hits a threshold", async () => {
      const prisma = {
        apiToken: { findMany: jest.fn().mockResolvedValue([{ id: "t1", name: "ci", userId: "u1", expiresAt: inDays(7) }]) },
        membership: { findMany: jest.fn().mockResolvedValue([{ teamId: "team1" }, { teamId: "team2" }]) },
      } as unknown as PrismaService;
      const { svc, fire } = make(prisma);
      await svc.checkTokens();
      expect(fire).toHaveBeenCalledWith("team1", "token_expiring", expect.stringContaining('"ci"'));
      expect(fire).toHaveBeenCalledWith("team2", "token_expiring", expect.stringContaining("7 day"));
    });

    it("ignores tokens far from expiry", async () => {
      const prisma = {
        apiToken: { findMany: jest.fn().mockResolvedValue([{ id: "t1", name: "ci", userId: "u1", expiresAt: inDays(30) }]) },
        membership: { findMany: jest.fn() },
      } as unknown as PrismaService;
      const { svc, fire } = make(prisma);
      await svc.checkTokens();
      expect(fire).not.toHaveBeenCalled();
    });
  });

  describe("checkSsl", () => {
    it("warns when a cert is within a threshold window", async () => {
      const prisma = {
        application: { findMany: jest.fn().mockResolvedValue([{ id: "a1", teamId: "team1", domain: "x.io" }]) },
      } as unknown as PrismaService;
      const { svc, fire } = make(prisma);
      jest.spyOn(svc, "probeDomain").mockResolvedValue({ state: "expiring", daysRemaining: 3, validTo: null, issuer: null });
      await svc.checkSsl();
      expect(fire).toHaveBeenCalledWith("team1", "ssl_expiring", expect.stringContaining("x.io"));
    });

    it("skips healthy certs and probe errors", async () => {
      const prisma = {
        application: { findMany: jest.fn().mockResolvedValue([{ id: "a1", teamId: "team1", domain: "ok.io" }, { id: "a2", teamId: "team1", domain: "err.io" }]) },
      } as unknown as PrismaService;
      const { svc, fire } = make(prisma);
      jest.spyOn(svc, "probeDomain").mockImplementation((host) =>
        Promise.resolve(
          host === "ok.io"
            ? { state: "ok", daysRemaining: 30, validTo: null, issuer: null }
            : { state: "error", daysRemaining: null, validTo: null, issuer: null },
        ),
      );
      await svc.checkSsl();
      expect(fire).not.toHaveBeenCalled();
    });
  });
});
