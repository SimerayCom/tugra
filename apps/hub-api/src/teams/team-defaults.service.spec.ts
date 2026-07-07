import { TeamDefaultsService } from "./team-defaults.service";
import type { PrismaService } from "../prisma/prisma.service";

describe("TeamDefaultsService", () => {
  it("creates a Default project + default production env when the team has none", async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const create = jest.fn().mockResolvedValue({ id: "p1" });
    const prisma = { project: { findFirst, create } } as unknown as PrismaService;
    const svc = new TeamDefaultsService(prisma);

    await svc.ensureDefaults("team1");

    expect(findFirst).toHaveBeenCalledWith({
      where: { teamId: "team1", isDefault: true },
      select: { id: true },
    });
    expect(create).toHaveBeenCalledWith({
      data: {
        teamId: "team1",
        name: "Default",
        isDefault: true,
        environments: { create: { name: "production", isDefault: true } },
      },
    });
  });

  it("is idempotent: does nothing when a default project already exists", async () => {
    const findFirst = jest.fn().mockResolvedValue({ id: "existing" });
    const create = jest.fn();
    const prisma = { project: { findFirst, create } } as unknown as PrismaService;
    const svc = new TeamDefaultsService(prisma);

    await svc.ensureDefaults("team1");

    expect(create).not.toHaveBeenCalled();
  });

  it("uses the provided transaction client instead of this.prisma", async () => {
    const prismaFindFirst = jest.fn();
    const prisma = { project: { findFirst: prismaFindFirst, create: jest.fn() } } as unknown as PrismaService;
    const txFindFirst = jest.fn().mockResolvedValue(null);
    const txCreate = jest.fn().mockResolvedValue({ id: "p1" });
    const tx = { project: { findFirst: txFindFirst, create: txCreate } };
    const svc = new TeamDefaultsService(prisma);

    await svc.ensureDefaults("team1", tx as never);

    expect(txFindFirst).toHaveBeenCalled();
    expect(txCreate).toHaveBeenCalled();
    expect(prismaFindFirst).not.toHaveBeenCalled();
  });
});
