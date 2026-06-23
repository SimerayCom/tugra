import { Role } from "@prisma/client";
import { AuditService } from "./audit.service";
import { PrismaService } from "../prisma/prisma.service";

function make(prisma: Partial<PrismaService>) {
  return new AuditService(prisma as PrismaService);
}

describe("AuditService.list", () => {
  it("non-admins only see their own actions", async () => {
    const auditFind = jest.fn().mockResolvedValue([
      { id: "l1", actor: "u1", action: "app.deploy", target: "a1", meta: null, createdAt: new Date() },
    ]);
    const svc = make({
      membership: { findMany: jest.fn().mockResolvedValue([{ teamId: "t1", userId: "u1", role: Role.VIEWER }]) },
      auditLog: { findMany: auditFind },
      user: { findMany: jest.fn().mockResolvedValue([{ id: "u1", email: "me@x.io" }]) },
    } as unknown as PrismaService);

    const rows = await svc.list("u1", "t1");
    expect(auditFind.mock.calls[0][0].where).toEqual({ actor: { in: ["u1"] } });
    expect(rows[0].actor).toBe("me@x.io"); // resolved to email
  });

  it("team admins see every member's actions", async () => {
    const membershipFind = jest
      .fn()
      .mockResolvedValueOnce([{ teamId: "t1", userId: "u1", role: Role.OWNER }]) // caller's memberships
      .mockResolvedValueOnce([{ userId: "u1" }, { userId: "u2" }]); // team members
    const auditFind = jest.fn().mockResolvedValue([
      { id: "l1", actor: "system", action: "notification.failed", target: "c1", meta: null, createdAt: new Date() },
    ]);
    const svc = make({
      membership: { findMany: membershipFind },
      auditLog: { findMany: auditFind },
      user: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService);

    const rows = await svc.list("u1", "t1");
    expect(auditFind.mock.calls[0][0].where).toEqual({ actor: { in: ["u1", "u2"] } });
    expect(rows[0].actor).toBe("system"); // non-user actor stays raw
  });

  it("falls back to own actions when not an admin of the requested team", async () => {
    const auditFind = jest.fn().mockResolvedValue([]);
    const svc = make({
      membership: { findMany: jest.fn().mockResolvedValue([{ teamId: "t1", userId: "u1", role: Role.VIEWER }]) },
      auditLog: { findMany: auditFind },
      user: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService);

    await svc.list("u1", "t1");
    expect(auditFind.mock.calls[0][0].where).toEqual({ actor: { in: ["u1"] } });
  });
});
