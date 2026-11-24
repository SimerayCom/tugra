import { isPrivilegedSubject, TwoFactorPolicyService } from "./two-factor-policy.service";

const member = (role: string, teamMemberCount: number) => ({ role, teamMemberCount });

describe("isPrivilegedSubject", () => {
  it("counts the instance owner and team admins", () => {
    expect(isPrivilegedSubject({ isInstanceOwner: true, memberships: [] })).toBe(true);
    expect(isPrivilegedSubject({ isInstanceOwner: false, memberships: [member("ADMIN", 1)] })).toBe(true);
  });

  it("counts a team OWNER only when the team has other members (a solo personal team does not)", () => {
    expect(isPrivilegedSubject({ isInstanceOwner: false, memberships: [member("OWNER", 1)] })).toBe(false);
    expect(isPrivilegedSubject({ isInstanceOwner: false, memberships: [member("OWNER", 3)] })).toBe(true);
  });

  it("never counts a viewer", () => {
    expect(isPrivilegedSubject({ isInstanceOwner: false, memberships: [member("VIEWER", 5)] })).toBe(false);
  });
});

describe("TwoFactorPolicyService.setupRequired", () => {
  function make(opts: { policy: boolean; user: { isInstanceOwner: boolean; twoFaEnabled: boolean; memberships: { role: string; team: { _count: { memberships: number } } }[] } | null }) {
    const prisma = { user: { findUnique: jest.fn().mockResolvedValue(opts.user) } };
    const settings = { get: jest.fn().mockResolvedValue({ require2faForAdmins: opts.policy }) };
    return { svc: new TwoFactorPolicyService(prisma as never, settings as never), prisma };
  }
  const owner = (twoFaEnabled: boolean) => ({ isInstanceOwner: true, twoFaEnabled, memberships: [] });

  it("is false when the policy is off, without loading the user", async () => {
    const { svc, prisma } = make({ policy: false, user: owner(false) });
    expect(await svc.setupRequired("u1")).toBe(false);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("is true for an owner without 2FA, false once enrolled", async () => {
    expect(await make({ policy: true, user: owner(false) }).svc.setupRequired("u1")).toBe(true);
    expect(await make({ policy: true, user: owner(true) }).svc.setupRequired("u1")).toBe(false);
  });

  it("is false for an unprivileged member or a missing user", async () => {
    const viewer = { isInstanceOwner: false, twoFaEnabled: false, memberships: [{ role: "VIEWER", team: { _count: { memberships: 4 } } }] };
    expect(await make({ policy: true, user: viewer }).svc.setupRequired("u2")).toBe(false);
    expect(await make({ policy: true, user: null }).svc.setupRequired("ghost")).toBe(false);
  });
});
