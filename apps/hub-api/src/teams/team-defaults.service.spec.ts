import { TeamDefaultsService } from "./team-defaults.service";
import type { PrismaService } from "../prisma/prisma.service";

describe("TeamDefaultsService", () => {
  const teamRow = { findUnique: jest.fn().mockResolvedValue({ name: "Acme" }) };

  it("creates a project named after the team (never \"Default\") when the team has none", async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const create = jest.fn().mockResolvedValue({ id: "p1" });
    const prisma = { team: teamRow, project: { findFirst, create } } as unknown as PrismaService;
    const svc = new TeamDefaultsService(prisma);

    await svc.ensureDefaults("team1");

    expect(findFirst).toHaveBeenCalledWith({ where: { teamId: "team1", isDefault: true }, select: { id: true } });
    expect(create).toHaveBeenCalledWith({
      data: {
        teamId: "team1",
        name: "Acme",
        isDefault: true,
        environments: { create: { name: "production", isDefault: true } },
      },
    });
  });

  it("adopts an existing project that already carries the team name instead of duplicating it", async () => {
    const findFirst = jest
      .fn()
      .mockResolvedValueOnce(null) // no default project
      .mockResolvedValueOnce({ id: "p-acme", environments: [{ id: "e1", isDefault: false }] }); // same-name project
    const update = jest.fn().mockResolvedValue({});
    const envUpdate = jest.fn().mockResolvedValue({});
    const create = jest.fn();
    const prisma = { team: teamRow, project: { findFirst, create, update }, environment: { update: envUpdate, create: jest.fn() } } as unknown as PrismaService;

    await new TeamDefaultsService(prisma).ensureDefaults("team1");

    expect(create).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({ where: { id: "p-acme" }, data: { isDefault: true } });
    expect(envUpdate).toHaveBeenCalledWith({ where: { id: "e1" }, data: { isDefault: true } });
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
    const tx = { team: teamRow, project: { findFirst: txFindFirst, create: txCreate } };
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
        team: teamRow,
        project: { findFirst: projectFindFirst, create: projectCreate },
      } as unknown as PrismaService;
      const svc = new TeamDefaultsService(prisma);

      const id = await svc.resolveDefaultEnvironmentId("team1");

      expect(id).toBe("env-healed");
      expect(projectCreate).toHaveBeenCalled(); // the team-named project was made
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
