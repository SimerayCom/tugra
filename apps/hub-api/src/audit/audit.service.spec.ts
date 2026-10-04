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

    const { entries } = await svc.list("u1", "t1");
    expect(auditFind.mock.calls[0][0].where).toEqual({ actor: { in: ["u1"] } });
    expect(entries[0].actor).toBe("me@x.io"); // resolved to email
  });

  it("strips sensitive keys from meta on read (a stray reset-link URL must not leak via the API)", async () => {
    const auditFind = jest.fn().mockResolvedValue([
      { id: "l1", actor: "u1", action: "auth.password.forgot", target: null, meta: { delivered: false, resetUrl: "https://x/reset?token=SECRET", email: "me@x.io" }, createdAt: new Date() },
    ]);
    const svc = make({
      membership: { findMany: jest.fn().mockResolvedValue([{ teamId: "t1", userId: "u1", role: Role.VIEWER }]) },
      auditLog: { findMany: auditFind },
      user: { findMany: jest.fn().mockResolvedValue([{ id: "u1", email: "me@x.io" }]) },
    } as unknown as PrismaService);
    const { entries } = await svc.list("u1");
    expect(entries[0].meta).toEqual({ delivered: false, email: "me@x.io" }); // resetUrl stripped, rest kept
    expect(JSON.stringify(entries[0])).not.toContain("SECRET");
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

    const { entries } = await svc.list("u1", "t1");
    expect(auditFind.mock.calls[0][0].where).toEqual({ actor: { in: ["u1", "u2"] } });
    expect(entries[0].actor).toBe("system"); // non-user actor stays raw
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

  it("returns nextCursor=null for a partial page (no more)", async () => {
    const auditFind = jest.fn().mockResolvedValue([
      { id: "l1", actor: "u1", action: "x", target: null, meta: null, createdAt: new Date() },
    ]);
    const svc = make({
      membership: { findMany: jest.fn().mockResolvedValue([{ teamId: "t1", userId: "u1", role: Role.VIEWER }]) },
      auditLog: { findMany: auditFind },
      user: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService);
    const page = await svc.list("u1", "t1");
    expect(page.nextCursor).toBeNull();
    expect(auditFind.mock.calls[0][0].take).toBe(100);
    expect(auditFind.mock.calls[0][0].cursor).toBeUndefined();
  });

  it("paginates with a cursor and returns the last id as nextCursor on a full page", async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ id: `l${i}`, actor: "u1", action: "x", target: null, meta: null, createdAt: new Date() }));
    const auditFind = jest.fn().mockResolvedValue(full);
    const svc = make({
      membership: { findMany: jest.fn().mockResolvedValue([{ teamId: "t1", userId: "u1", role: Role.VIEWER }]) },
      auditLog: { findMany: auditFind },
      user: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService);
    const page = await svc.list("u1", "t1", "l50");
    expect(auditFind.mock.calls[0][0]).toMatchObject({ cursor: { id: "l50" }, skip: 1, take: 100 });
    expect(page.nextCursor).toBe("l99"); // last id of the full page
  });
});
