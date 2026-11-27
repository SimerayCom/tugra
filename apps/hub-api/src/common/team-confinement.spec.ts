import { teamConfinement, teamHiddenByConfinement } from "./team-confinement";
import { TeamAccessService } from "./team-access.service";

describe("team confinement", () => {
  it("hides nothing outside a confined call", () => {
    expect(teamHiddenByConfinement("t1")).toBe(false);
  });
  it("hides every other team inside a confined call", () => {
    teamConfinement.run({ teamId: "t1" }, () => {
      expect(teamHiddenByConfinement("t1")).toBe(false);
      expect(teamHiddenByConfinement("t2")).toBe(true);
    });
  });

  const rows = [
    { teamId: "t1", role: "OWNER", teamRole: null },
    { teamId: "t2", role: "OWNER", teamRole: null },
  ];
  const prisma = {
    membership: {
      findMany: jest.fn(async () => rows),
      findUnique: jest.fn(async ({ where }: { where: { userId_teamId: { teamId: string } } }) => rows.find((r) => r.teamId === where.userId_teamId.teamId) ?? null),
    },
  };
  const svc = new TeamAccessService(prisma as never);

  it("TeamAccessService answers for the confined team only", async () => {
    await teamConfinement.run({ teamId: "t1" }, async () => {
      expect([...(await svc.roleByTeam("u")).keys()]).toEqual(["t1"]);
      expect([...(await svc.permissionsByTeam("u")).keys()]).toEqual(["t1"]);
      expect([...(await svc.accessByTeam("u")).keys()]).toEqual(["t1"]);
      expect(await svc.teamRole("u", "t1")).toBe("OWNER");
      expect(await svc.teamRole("u", "t2")).toBeNull();
      expect(await svc.membershipPermissions("u", "t2")).toBeNull();
      expect(await svc.membershipAccess("u", "t2")).toBeNull();
      await expect(svc.requirePermission("u", "t2", "apps:deploy")).rejects.toThrow(/insufficient/);
      await expect(svc.requirePermission("u", "t1", "apps:deploy")).resolves.toBeUndefined();
    });
  });
  it("is unchanged without confinement", async () => {
    expect([...(await svc.roleByTeam("u")).keys()]).toEqual(["t1", "t2"]);
    expect(await svc.teamRole("u", "t2")).toBe("OWNER");
  });
});
