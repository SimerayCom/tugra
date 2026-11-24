import { ConflictException } from "@nestjs/common";
import type { TeamPermission } from "@tugra/shared";
import type { PrismaService } from "../prisma/prisma.service";

/** The customer-portal presets: a restricted role that only reaches the portal surface (common/portal-surface.ts). */
export type ClientAccess = "view" | "deploy";

export const CLIENT_ROLE_NAMES: Record<ClientAccess, string> = { view: "Client", deploy: "Client (deploy)" };

/** The only resource permissions a portal role can ever carry; anything else is dropped on every write. */
export const CLIENT_ALLOWED_PERMISSIONS: readonly TeamPermission[] = ["apps:deploy"];

const PRESET_PERMISSIONS: Record<ClientAccess, TeamPermission[]> = { view: [], deploy: ["apps:deploy"] };

export function clientPermissions(perms: string[]): TeamPermission[] {
  return CLIENT_ALLOWED_PERMISSIONS.filter((p) => perms.includes(p));
}

/** What a portal role grants, for the views: view-only or view + deploy. */
export function clientAccessOf(role: { portal: boolean; permissions: string[] } | null | undefined): ClientAccess | null {
  if (!role?.portal) return null;
  return role.permissions.includes("apps:deploy") ? "deploy" : "view";
}

/** Find or create the team's portal preset. A hand-made role that already uses the preset's name is never reused
 *  (it would not carry the portal confinement), so that is reported instead of silently granting the wrong access. */
export async function ensureClientRole(prisma: PrismaService, teamId: string, access: ClientAccess) {
  const name = CLIENT_ROLE_NAMES[access];
  const existing = await prisma.teamRole.findUnique({ where: { teamId_name: { teamId, name } } });
  if (existing) {
    if (!existing.portal) throw new ConflictException(`a role named "${name}" already exists and is not a client role`);
    return existing;
  }
  return prisma.teamRole.create({ data: { teamId, name, portal: true, permissions: PRESET_PERMISSIONS[access] } });
}
