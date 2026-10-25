import { Role } from "@prisma/client";
import { AuditService } from "./audit.service";
import { auditContext } from "./audit-context";
import { PrismaService } from "../prisma/prisma.service";

function make(prisma: Partial<PrismaService>) {
  return new AuditService(prisma as PrismaService);
}

describe("AuditService.log auth-context stamping", () => {
  it("stamps via + tokenId from the request context onto meta", async () => {
    const create = jest.fn().mockResolvedValue({});
    const svc = make({ auditLog: { create } } as unknown as PrismaService);
    await auditContext.run({ via: "pat", tokenId: "tok1" }, () => svc.log({ actor: "u1", action: "app.deploy", target: "a1", meta: { n: 1 } }));
    expect(create.mock.calls[0][0].data.meta).toEqual({ n: 1, via: "pat", tokenId: "tok1" });
  });

  it("stamps via:session (no tokenId) for a browser session", async () => {
    const create = jest.fn().mockResolvedValue({});
    const svc = make({ auditLog: { create } } as unknown as PrismaService);
    await auditContext.run({ via: "session" }, () => svc.log({ actor: "u1", action: "x" }));
    expect(create.mock.calls[0][0].data.meta).toEqual({ via: "session" });
  });

  it("records no via outside a request context (fire-and-forget log)", async () => {
    const create = jest.fn().mockResolvedValue({});
    const svc = make({ auditLog: { create } } as unknown as PrismaService);
    await svc.log({ actor: "u1", action: "x" });
    expect(create.mock.calls[0][0].data.meta).toBeUndefined();
  });
});

describe("AuditService.list filters", () => {
  it("applies action + date filters alongside the actor scope", async () => {
    const find = jest.fn().mockResolvedValue([]);
    const svc = make({
      membership: { findMany: jest.fn().mockResolvedValue([{ teamId: "t1", userId: "u1", role: Role.VIEWER }]) },
      auditLog: { findMany: find },
      user: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService);
    await svc.list("u1", undefined, undefined, { action: "app.deploy", to: new Date("2026-10-10") });
    const where = find.mock.calls[0][0].where;
    expect(where.actor).toEqual({ in: ["u1"] });
    expect(where.action).toBe("app.deploy");
    expect(where.createdAt).toMatchObject({ lte: expect.any(Date) });
  });
});

describe("AuditService.listForTarget", () => {
  it("filters by target id + action/date, paginates, and sanitizes meta", async () => {
    const find = jest.fn().mockResolvedValue([
      { id: "l1", actor: "u1", action: "app.deploy", target: "a1", meta: { resetUrl: "SECRET", via: "pat" }, createdAt: new Date() },
    ]);
    const svc = make({
      auditLog: { findMany: find },
      user: { findMany: jest.fn().mockResolvedValue([{ id: "u1", email: "me@x.io" }]) },
    } as unknown as PrismaService);
    const page = await svc.listForTarget("a1", { action: "app.deploy", from: new Date("2026-10-01"), cursor: "c1" });
    const arg = find.mock.calls[0][0];
    expect(arg.where).toMatchObject({ target: "a1", action: "app.deploy", createdAt: { gte: expect.any(Date) } });
    expect(arg.cursor).toEqual({ id: "c1" });
    expect(page.entries[0].meta).toEqual({ via: "pat" }); // resetUrl stripped, actor resolved to email
    expect(page.entries[0].actor).toBe("me@x.io");
  });
});

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

describe("AuditService.exportEntries", () => {
  it("reads the first keyset batch with the actor scope + filters, no cursor, and sanitizes meta", async () => {
    const auditFind = jest.fn().mockResolvedValue([
      { id: "l1", actor: "u1", action: "instance.license", target: "singleton", meta: { resetUrl: "SECRET", via: "session" }, createdAt: new Date() },
    ]);
    const svc = make({
      membership: { findMany: jest.fn().mockResolvedValue([{ teamId: "t1", userId: "u1", role: Role.VIEWER }]) },
      auditLog: { findMany: auditFind },
      user: { findMany: jest.fn().mockResolvedValue([{ id: "u1", email: "me@x.io" }]) },
    } as unknown as PrismaService);
    const { entries, truncated } = await svc.exportEntries("u1", "t1", { action: "instance.license" });
    const arg = auditFind.mock.calls[0][0];
    expect(arg.where).toEqual({ actor: { in: ["u1"] }, action: "instance.license" }); // non-admin → self only
    expect(arg.take).toBe(1_000); // EXPORT_BATCH
    expect(arg.cursor).toBeUndefined(); // first batch has no cursor
    expect(truncated).toBe(false); // a partial batch means the table is exhausted
    expect(entries[0].meta).toEqual({ via: "session" }); // resetUrl stripped
    expect(entries[0].actor).toBe("me@x.io");
  });

  it("team admins export every member's actions", async () => {
    const membershipFind = jest
      .fn()
      .mockResolvedValueOnce([{ teamId: "t1", userId: "u1", role: Role.ADMIN }])
      .mockResolvedValueOnce([{ userId: "u1" }, { userId: "u2" }]);
    const auditFind = jest.fn().mockResolvedValue([]);
    const svc = make({
      membership: { findMany: membershipFind },
      auditLog: { findMany: auditFind },
      user: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService);
    await svc.exportEntries("u1", "t1");
    expect(auditFind.mock.calls[0][0].where).toEqual({ actor: { in: ["u1", "u2"] } });
  });

  it("advances the keyset cursor across full batches until the table is exhausted", async () => {
    const full = Array.from({ length: 1_000 }, (_, i) => ({ id: `a${i}`, actor: "u1", action: "x", target: null, meta: null, createdAt: new Date() }));
    const auditFind = jest
      .fn()
      .mockResolvedValueOnce(full) // a full batch → there may be more
      .mockResolvedValueOnce([]); // …then empty → done
    const svc = make({
      membership: { findMany: jest.fn().mockResolvedValue([{ teamId: "t1", userId: "u1", role: Role.VIEWER }]) },
      auditLog: { findMany: auditFind },
      user: { findMany: jest.fn().mockResolvedValue([{ id: "u1", email: "me@x.io" }]) },
    } as unknown as PrismaService);
    const { entries, truncated } = await svc.exportEntries("u1");
    expect(auditFind).toHaveBeenCalledTimes(2);
    expect(auditFind.mock.calls[1][0]).toMatchObject({ cursor: { id: "a999" }, skip: 1 }); // keyset from last id
    expect(entries).toHaveLength(1_000);
    expect(truncated).toBe(false);
  });

  it("stops at the byte budget (not just the row cap) and flags truncated when rows carry large meta", async () => {
    const big = "x".repeat(1_000_000); // ~1 MB each → the ~25 MB budget trips well before any row cap
    const rows = Array.from({ length: 40 }, (_, i) => ({ id: `b${i}`, actor: "u1", action: "x", target: null, meta: { blob: big }, createdAt: new Date() }));
    const svc = make({
      membership: { findMany: jest.fn().mockResolvedValue([{ teamId: "t1", userId: "u1", role: Role.VIEWER }]) },
      auditLog: { findMany: jest.fn().mockResolvedValue(rows) },
      user: { findMany: jest.fn().mockResolvedValue([{ id: "u1", email: "me@x.io" }]) },
    } as unknown as PrismaService);
    const { entries, truncated } = await svc.exportEntries("u1");
    expect(truncated).toBe(true);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.length).toBeLessThan(40); // budget stopped it before consuming all rows
  });
});

describe("AuditService.log meta cap", () => {
  it("truncates an oversized meta at write, keeping only the auth stamps + a marker", async () => {
    const create = jest.fn().mockResolvedValue({});
    const svc = make({ auditLog: { create } } as unknown as PrismaService);
    const huge = "y".repeat(20_000); // > META_MAX_BYTES (16 KB)
    await auditContext.run({ via: "pat", tokenId: "tok1" }, () => svc.log({ actor: "u1", action: "mcp.tools_call", meta: { args: huge } }));
    expect(create.mock.calls[0][0].data.meta).toEqual({ _truncated: true, via: "pat", tokenId: "tok1" });
  });

  it("leaves a normal-sized meta untouched", async () => {
    const create = jest.fn().mockResolvedValue({});
    const svc = make({ auditLog: { create } } as unknown as PrismaService);
    await svc.log({ actor: "u1", action: "app.deploy", meta: { n: 1 } });
    expect(create.mock.calls[0][0].data.meta).toEqual({ n: 1 });
  });
});
