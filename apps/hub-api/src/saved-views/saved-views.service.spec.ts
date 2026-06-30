import { NotFoundException } from "@nestjs/common";
import { SavedViewsService } from "./saved-views.service";
import { PrismaService } from "../prisma/prisma.service";

function make(prisma: Partial<PrismaService>) {
  return new SavedViewsService(prisma as PrismaService);
}

describe("SavedViewsService", () => {
  it("creates a view scoped to the user", async () => {
    const create = jest.fn().mockResolvedValue({ id: "v1", name: "prod", status: "ONLINE", tags: ["eu"], createdAt: new Date() });
    const svc = make({ savedView: { create } } as unknown as PrismaService);
    const v = await svc.create("u1", { name: "prod", status: "ONLINE", tags: ["eu"] });
    expect(create).toHaveBeenCalledWith({ data: { userId: "u1", name: "prod", status: "ONLINE", tags: ["eu"] } });
    expect(v).toMatchObject({ id: "v1", name: "prod", status: "ONLINE", tags: ["eu"] });
  });

  it("defaults status to null and tags to [] when omitted", async () => {
    const create = jest.fn().mockResolvedValue({ id: "v2", name: "all", status: null, tags: [], createdAt: new Date() });
    await make({ savedView: { create } } as unknown as PrismaService).create("u1", { name: "all" });
    expect(create).toHaveBeenCalledWith({ data: { userId: "u1", name: "all", status: null, tags: [] } });
  });

  it("lists the user's views", async () => {
    const findMany = jest.fn().mockResolvedValue([{ id: "v1", name: "prod", status: null, tags: [], createdAt: new Date() }]);
    const list = await make({ savedView: { findMany } } as unknown as PrismaService).list("u1");
    expect(findMany).toHaveBeenCalledWith({ where: { userId: "u1" }, orderBy: { createdAt: "asc" } });
    expect(list).toHaveLength(1);
  });

  it("won't delete another user's view (not found)", async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const del = jest.fn();
    const svc = make({ savedView: { findFirst, delete: del } } as unknown as PrismaService);
    await expect(svc.remove("u1", "v9")).rejects.toThrow(NotFoundException);
    expect(del).not.toHaveBeenCalled();
  });

  it("deletes the user's own view", async () => {
    const findFirst = jest.fn().mockResolvedValue({ id: "v1", userId: "u1" });
    const del = jest.fn().mockResolvedValue({});
    await make({ savedView: { findFirst, delete: del } } as unknown as PrismaService).remove("u1", "v1");
    expect(del).toHaveBeenCalledWith({ where: { id: "v1" } });
  });
});
