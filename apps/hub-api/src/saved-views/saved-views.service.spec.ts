import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { Role } from "@prisma/client";
import { SavedViewsService } from "./saved-views.service";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";

function make(prisma: Partial<PrismaService>, roleByTeam: Map<string, Role> = new Map()) {
  const access = {
    roleByTeam: jest.fn().mockResolvedValue(roleByTeam),
    teamIds: jest.fn().mockResolvedValue([...roleByTeam.keys()]),
  } as unknown as TeamAccessService;
  return new SavedViewsService(prisma as PrismaService, access);
}

describe("SavedViewsService", () => {
  it("creates a personal view (teamId null)", async () => {
    const create = jest.fn().mockResolvedValue({ id: "v1", userId: "u1", teamId: null, name: "prod", status: "ONLINE", tags: ["eu"], createdAt: new Date() });
    const v = await make({ savedView: { create } } as unknown as PrismaService).create("u1", { name: "prod", status: "ONLINE", tags: ["eu"] });
    expect(create).toHaveBeenCalledWith({ data: { userId: "u1", teamId: null, name: "prod", status: "ONLINE", tags: ["eu"] } });
    expect(v).toMatchObject({ id: "v1", teamId: null, canDelete: true });
  });

  it("shares a view with a team the user belongs to", async () => {
    const create = jest.fn().mockResolvedValue({ id: "v2", userId: "u1", teamId: "t1", name: "team", status: null, tags: [], createdAt: new Date() });
    const svc = make({ savedView: { create } } as unknown as PrismaService, new Map([["t1", Role.OWNER]]));
    const v = await svc.create("u1", { name: "team", teamId: "t1" });
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ userId: "u1", teamId: "t1" }) });
    expect(v.teamId).toBe("t1");
  });

  it("refuses to share with a team the user is not a member of", async () => {
    const create = jest.fn();
    const svc = make({ savedView: { create } } as unknown as PrismaService, new Map([["t1", Role.OWNER]]));
    await expect(svc.create("u1", { name: "x", teamId: "t2" })).rejects.toThrow(ForbiddenException);
    expect(create).not.toHaveBeenCalled();
  });

  it("lists the user's own + team-shared views with canDelete flags", async () => {
    const now = new Date();
    const findMany = jest.fn().mockResolvedValue([
      { id: "p", userId: "u1", teamId: null, name: "personal", status: null, tags: [], createdAt: now }, // own → deletable
      { id: "s", userId: "u2", teamId: "t1", name: "shared", status: null, tags: [], createdAt: now }, // shared, u1 is OWNER → deletable
      { id: "sv", userId: "u3", teamId: "t2", name: "viewer-shared", status: null, tags: [], createdAt: now }, // shared, u1 is VIEWER → not
    ]);
    const svc = make({ savedView: { findMany } } as unknown as PrismaService, new Map([["t1", Role.OWNER], ["t2", Role.VIEWER]]));
    const list = await svc.list("u1");
    expect(findMany).toHaveBeenCalledWith({ where: { OR: [{ userId: "u1" }, { teamId: { in: ["t1", "t2"] } }] }, orderBy: { createdAt: "asc" } });
    expect(list.map((v) => [v.id, v.canDelete])).toEqual([["p", true], ["s", true], ["sv", false]]);
  });

  it("lets a team admin delete a shared view they didn't create", async () => {
    const del = jest.fn().mockResolvedValue({});
    const svc = make(
      { savedView: { findUnique: jest.fn().mockResolvedValue({ id: "s", userId: "u2", teamId: "t1" }), delete: del } } as unknown as PrismaService,
      new Map([["t1", Role.ADMIN]]),
    );
    await svc.remove("u1", "s");
    expect(del).toHaveBeenCalledWith({ where: { id: "s" } });
  });

  it("won't let a non-owner non-admin delete a shared view", async () => {
    const del = jest.fn();
    const svc = make(
      { savedView: { findUnique: jest.fn().mockResolvedValue({ id: "s", userId: "u2", teamId: "t1" }), delete: del } } as unknown as PrismaService,
      new Map([["t1", Role.VIEWER]]),
    );
    await expect(svc.remove("u1", "s")).rejects.toThrow(ForbiddenException);
    expect(del).not.toHaveBeenCalled();
  });

  it("throws NotFound for a missing view", async () => {
    const svc = make({ savedView: { findUnique: jest.fn().mockResolvedValue(null), delete: jest.fn() } } as unknown as PrismaService);
    await expect(svc.remove("u1", "v9")).rejects.toThrow(NotFoundException);
  });
});
