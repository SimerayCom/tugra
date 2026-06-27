import { loadProjectCtx } from "./resource-project";
import { PrismaService } from "../prisma/prisma.service";

const prismaWith = (findUnique: jest.Mock) =>
  ({ environment: { findUnique } }) as unknown as PrismaService;

describe("loadProjectCtx", () => {
  it("returns empty context (no lookup) for an unassigned resource", async () => {
    const findUnique = jest.fn();
    const ctx = await loadProjectCtx(prismaWith(findUnique), null);
    expect(ctx).toEqual({ projectId: null, projectName: null, environmentName: null });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("resolves the owning project + environment name when assigned", async () => {
    const findUnique = jest.fn().mockResolvedValue({
      id: "e1",
      name: "production",
      project: { id: "p1", name: "Shop" },
    });
    const ctx = await loadProjectCtx(prismaWith(findUnique), "e1");
    expect(ctx).toEqual({ projectId: "p1", projectName: "Shop", environmentName: "production" });
  });

  it("returns empty context when the environment no longer exists", async () => {
    const ctx = await loadProjectCtx(prismaWith(jest.fn().mockResolvedValue(null)), "gone");
    expect(ctx).toEqual({ projectId: null, projectName: null, environmentName: null });
  });
});
