import { ApiTokensService } from "./api-tokens.service";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { hashToken } from "./api-token.util";

const audit = { log: jest.fn() } as unknown as AuditService;

describe("ApiTokensService", () => {
  it("returns the raw token once and stores only its hash", async () => {
    let saved: Record<string, unknown> = {};
    const prisma = {
      apiToken: {
        create: jest.fn().mockImplementation(({ data }) => {
          saved = data;
          return Promise.resolve({ id: "t1", createdAt: new Date(), expiresAt: null, lastUsedAt: null, ...data });
        }),
      },
    } as unknown as PrismaService;
    const svc = new ApiTokensService(prisma, audit);
    const res = await svc.create("u1", { name: "ci", scopes: ["read", "deploy"] });
    expect(res.token).toMatch(/^tugra_pat_/);
    expect(saved.tokenHash).toBe(hashToken(res.token));
    expect(saved.tokenHash).not.toBe(res.token);
    expect(saved.scopes).toEqual(["read", "deploy"]);
    expect(res.view.scopes).toEqual(["read", "deploy"]);
    expect(res.view).not.toHaveProperty("tokenHash");
  });

  it("validates a good token to its owner, carrying scopes + tokenId", async () => {
    const prisma = {
      apiToken: {
        findUnique: jest.fn().mockResolvedValue({ id: "t1", userId: "u9", scopes: ["read", "write"], expiresAt: null }),
        update: jest.fn().mockResolvedValue({}),
      },
    } as unknown as PrismaService;
    const user = await new ApiTokensService(prisma, audit).validate("tugra_pat_abc");
    expect(user).toEqual({ userId: "u9", scopes: ["read", "write"], tokenId: "t1" });
  });

  it("rejects expired, unknown, and non-PAT tokens", async () => {
    const prisma = {
      apiToken: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({ id: "t1", userId: "u9", expiresAt: new Date(Date.now() - 1000) }) // expired
          .mockResolvedValueOnce(null), // unknown
        update: jest.fn(),
      },
    } as unknown as PrismaService;
    const svc = new ApiTokensService(prisma, audit);
    expect(await svc.validate("tugra_pat_expired")).toBeNull();
    expect(await svc.validate("tugra_pat_unknown")).toBeNull();
    expect(await svc.validate("not-a-pat")).toBeNull(); // never hits DB
  });

  function withToken(token: Record<string, unknown> | null) {
    const update = jest
      .fn()
      .mockResolvedValue({ id: "t1", name: "ci", prefix: "p", scopes: ["read"], expiresAt: null, lastUsedAt: null, createdAt: new Date() });
    const deleteUses = jest.fn().mockResolvedValue({});
    const prisma = { apiToken: { findFirst: jest.fn().mockResolvedValue(token), update }, apiTokenUse: { deleteMany: deleteUses } } as unknown as PrismaService;
    return { svc: new ApiTokensService(prisma, audit), update, deleteUses };
  }

  it("update renames and NARROWS scopes", async () => {
    const { svc, update } = withToken({ id: "t1", userId: "u1", scopes: ["read", "write", "deploy"] });
    await svc.update("u1", "t1", { name: "renamed", scopes: ["read"] });
    expect(update.mock.calls[0][0].data).toEqual({ name: "renamed", scopes: ["read"] });
  });

  it("update REFUSES to widen scopes (admin not already granted)", async () => {
    const { svc, update } = withToken({ id: "t1", userId: "u1", scopes: ["read"] });
    await expect(svc.update("u1", "t1", { scopes: ["read", "admin"] })).rejects.toThrow(/cannot widen/);
    expect(update).not.toHaveBeenCalled();
  });

  it("update 404s a token the caller does not own", async () => {
    const { svc } = withToken(null);
    await expect(svc.update("u1", "nope", { name: "x" })).rejects.toThrow(/not found/);
  });

  it("rotate issues a fresh secret (new hash + prefix), keeps identity, resets lastUsedAt", async () => {
    const { svc, update, deleteUses } = withToken({ id: "t1", userId: "u1", name: "ci", scopes: ["read"], expiresAt: null });
    const res = await svc.rotate("u1", "t1");
    expect(res.token).toMatch(/^tugra_pat_/);
    const data = update.mock.calls[0][0].data;
    expect(data.tokenHash).toBe(hashToken(res.token));
    expect(data.tokenHash).not.toBe(res.token); // stored hashed, never raw
    expect(data.prefix).toBe(res.token.slice(0, 16));
    expect(data.lastUsedAt).toBeNull();
    expect(deleteUses).toHaveBeenCalledWith({ where: { tokenId: "t1" } }); // history of the retired secret goes
    expect(res.view).not.toHaveProperty("tokenHash");
  });

  it("rotate 404s a token the caller does not own", async () => {
    const { svc } = withToken(null);
    await expect(svc.rotate("u1", "nope")).rejects.toThrow(/not found/);
  });

  it("rotate REFUSES an already-expired token (a fresh secret would be dead on arrival)", async () => {
    const { svc, update } = withToken({ id: "t1", userId: "u1", scopes: ["read"], expiresAt: new Date(Date.now() - 1000) });
    await expect(svc.rotate("u1", "t1")).rejects.toThrow(/expired/);
    expect(update).not.toHaveBeenCalled();
  });

  it("update de-duplicates scopes before storing", async () => {
    const { svc, update } = withToken({ id: "t1", userId: "u1", scopes: ["read", "write"] });
    await svc.update("u1", "t1", { scopes: ["read", "read", "write"] });
    expect(update.mock.calls[0][0].data.scopes).toEqual(["read", "write"]);
  });
});

describe("ApiTokensService — usage history", () => {
  const info = { ip: "203.0.113.7", userAgent: "claude-code/1.0", action: "mcp:list_servers" };
  function mk(over: Record<string, jest.Mock> = {}) {
    const use = {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({}),
      ...over,
    };
    const apiToken = { findFirst: jest.fn().mockResolvedValue({ id: "t1" }) };
    const prisma = { apiToken, apiTokenUse: use } as unknown as PrismaService;
    return { svc: new ApiTokensService(prisma, audit), use, apiToken };
  }

  it("creates a new row for a first use and prunes nothing when under the cap", async () => {
    const { svc, use } = mk();
    await svc.recordUse("t1", info);
    expect(use.create).toHaveBeenCalledWith({ data: expect.objectContaining({ tokenId: "t1", ...info }) });
    expect(use.deleteMany).not.toHaveBeenCalled();
  });

  it("coalesces an identical call inside the window into a counter", async () => {
    const { svc, use } = mk({ findFirst: jest.fn().mockResolvedValue({ id: "u1", at: new Date(Date.now() - 5000), ...info }) });
    await svc.recordUse("t1", info);
    expect(use.update).toHaveBeenCalledWith({ where: { id: "u1" }, data: expect.objectContaining({ count: { increment: 1 } }) });
    expect(use.create).not.toHaveBeenCalled();
  });

  it("starts a new row when the action, ip or window differs", async () => {
    const old = { id: "u1", at: new Date(Date.now() - 5000), ...info };
    for (const last of [{ ...old, action: "mcp:other" }, { ...old, ip: "198.51.100.1" }, { ...old, at: new Date(Date.now() - 3_600_000) }]) {
      const { svc, use } = mk({ findFirst: jest.fn().mockResolvedValue(last) });
      await svc.recordUse("t1", info);
      expect(use.create).toHaveBeenCalledTimes(1);
      expect(use.update).not.toHaveBeenCalled();
    }
  });

  it("keeps the history bounded by deleting everything past the newest 50", async () => {
    const { svc, use } = mk({ findMany: jest.fn().mockResolvedValue([{ id: "old1" }, { id: "old2" }]) });
    await svc.recordUse("t1", info);
    expect(use.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 50, where: { tokenId: "t1" } }));
    expect(use.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["old1", "old2"] } } });
  });

  it("lists uses only for the caller's own token", async () => {
    const { svc, use, apiToken } = mk({ findMany: jest.fn().mockResolvedValue([{ id: "u1", at: new Date(), ip: "1.1.1.1", userAgent: null, action: "GET /x", count: 3, tokenId: "t1" }]) });
    const rows = await svc.listUses("u1", "t1");
    expect(apiToken.findFirst).toHaveBeenCalledWith({ where: { id: "t1", userId: "u1" }, select: { id: true } });
    expect(rows).toEqual([expect.objectContaining({ id: "u1", count: 3 })]);
    expect(rows[0]).not.toHaveProperty("tokenId");
    expect(use.findMany).toHaveBeenCalledTimes(1);
  });

  it("404s (and never reads history) for someone else's or unknown token", async () => {
    const { svc, use, apiToken } = mk();
    apiToken.findFirst.mockResolvedValue(null);
    await expect(svc.listUses("u2", "t1")).rejects.toThrow(/not found/);
    expect(use.findMany).not.toHaveBeenCalled();
  });
});
