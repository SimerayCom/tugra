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

  describe("resolveDefaultEnvironmentId", () => {
    it("returns the default project's default environment id", async () => {
      const envFindFirst = jest.fn().mockResolvedValue({ id: "env-default" });
      const prisma = { environment: { findFirst: envFindFirst } } as unknown as PrismaService;
      const svc = new TeamDefaultsService(prisma);

      const id = await svc.resolveDefaultEnvironmentId("team1");

      expect(id).toBe("env-default");
      expect(envFindFirst).toHaveBeenCalledWith({
        where: { isDefault: true, project: { teamId: "team1", isDefault: true } },
        select: { id: true },
      });
    });

    it("self-heals by bootstrapping defaults when none exists, then retries", async () => {
      const envFindFirst = jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "env-healed" });
      const projectFindFirst = jest.fn().mockResolvedValue(null);
      const projectCreate = jest.fn().mockResolvedValue({ id: "p1" });
      const prisma = {
        environment: { findFirst: envFindFirst },
        project: { findFirst: projectFindFirst, create: projectCreate },
      } as unknown as PrismaService;
      const svc = new TeamDefaultsService(prisma);

      const id = await svc.resolveDefaultEnvironmentId("team1");

      expect(id).toBe("env-healed");
      expect(projectCreate).toHaveBeenCalled(); // ensureDefaults ran
      expect(envFindFirst).toHaveBeenCalledTimes(2);
    });

    it("throws rather than returning null if it still cannot resolve", async () => {
      const prisma = {
        environment: { findFirst: jest.fn().mockResolvedValue(null) },
        project: { findFirst: jest.fn().mockResolvedValue({ id: "p1" }), create: jest.fn() },
      } as unknown as PrismaService;
      const svc = new TeamDefaultsService(prisma);
      await expect(svc.resolveDefaultEnvironmentId("team1")).rejects.toThrow(/no default environment/);
    });
  });
});
