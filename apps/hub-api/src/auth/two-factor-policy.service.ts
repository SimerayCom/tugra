import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { InstanceSettingsService } from "../instance/instance-settings.service";

/** The slice of a user the policy decides on. */
export interface PolicySubject {
  isInstanceOwner: boolean;
  twoFaEnabled: boolean;
  memberships: { role: string; teamMemberCount: number }[];
}

/**
 * Whether a user counts as an "owner/admin" for the instance 2FA policy: the instance owner, any team ADMIN, or
 * the OWNER of a team that has other members. Every self-registered account owns its own one-person team, so a
 * plain OWNER role alone would sweep in every account; a solo team owner manages nobody but themselves and is
 * left to opt in through their own settings.
 */
export function isPrivilegedSubject(u: Pick<PolicySubject, "isInstanceOwner" | "memberships">): boolean {
  if (u.isInstanceOwner) return true;
  return u.memberships.some((m) => m.role === "ADMIN" || (m.role === "OWNER" && m.teamMemberCount > 1));
}

/**
 * Instance "Require 2FA for owners/admins" policy. `setupRequired` is true when the policy is on, the user is an
 * owner/admin and has not enrolled two-factor yet. Such a user is not locked out: login still succeeds and the
 * account self-service routes (including 2FA enrolment) stay reachable, so they can always enrol (see
 * TwoFactorRequiredGuard). Turning the policy on is refused unless the acting owner has 2FA themselves.
 */
@Injectable()
export class TwoFactorPolicyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: InstanceSettingsService,
  ) {}

  async policyEnabled(): Promise<boolean> {
    return (await this.settings.get()).require2faForAdmins;
  }

  /** Load the policy-relevant slice of a user (null when it doesn't exist). */
  async subject(userId: string): Promise<PolicySubject | null> {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        isInstanceOwner: true,
        twoFaEnabled: true,
        memberships: { select: { role: true, team: { select: { _count: { select: { memberships: true } } } } } },
      },
    });
    if (!u) return null;
    return {
      isInstanceOwner: u.isInstanceOwner,
      twoFaEnabled: u.twoFaEnabled,
      memberships: u.memberships.map((m) => ({ role: m.role, teamMemberCount: m.team._count.memberships })),
    };
  }

  /** True when the policy is on and this user must still enrol 2FA. */
  async setupRequired(userId: string): Promise<boolean> {
    if (!(await this.policyEnabled())) return false;
    const u = await this.subject(userId);
    return !!u && !u.twoFaEnabled && isPrivilegedSubject(u);
  }
}
