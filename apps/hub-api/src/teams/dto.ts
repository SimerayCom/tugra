import { z } from "zod";

export const CreateTeamSchema = z.object({ name: z.string().min(1).max(80) });
export type CreateTeamInput = z.infer<typeof CreateTeamSchema>;

export const RenameTeamSchema = z.object({ name: z.string().min(1).max(80) });
export type RenameTeamInput = z.infer<typeof RenameTeamSchema>;

export const InviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(["OWNER", "ADMIN", "VIEWER"]),
  // Customer portal: invite as a Client (sees only the team's apps, uptime and backups; "deploy" may also deploy).
  clientAccess: z.enum(["view", "deploy"]).optional(),
});
export type InviteInput = z.infer<typeof InviteSchema>;

// Assign a built-in role OR a custom team role (exactly one).
export const SetRoleSchema = z
  .object({
    role: z.enum(["OWNER", "ADMIN", "VIEWER"]).optional(),
    teamRoleId: z.string().min(1).optional(),
  })
  .refine((v) => (v.role === undefined) !== (v.teamRoleId === undefined), "provide exactly one of role / teamRoleId");
export type SetRoleInput = z.infer<typeof SetRoleSchema>;

export const TeamRoleSchema = z.object({
  name: z.string().min(1).max(60),
  permissions: z.array(z.string()).default([]),
});
export type TeamRoleInput = z.infer<typeof TeamRoleSchema>;

export const UpdateTeamRoleSchema = z
  .object({
    name: z.string().min(1).max(60).optional(),
    permissions: z.array(z.string()).optional(),
  })
  .refine((v) => v.name !== undefined || v.permissions !== undefined, "nothing to update");
export type UpdateTeamRoleInput = z.infer<typeof UpdateTeamRoleSchema>;

// The customer-portal presets ("Client" / "Client (deploy)"): created on first use, reused after.
export const ClientRoleSchema = z.object({ access: z.enum(["view", "deploy"]) });
export type ClientRoleInput = z.infer<typeof ClientRoleSchema>;

export const SetMemberAccessSchema = z.object({
  restrictedAccess: z.boolean(),
  accessedProjects: z.array(z.string()).default([]),
});
export type SetMemberAccessInput = z.infer<typeof SetMemberAccessSchema>;

// A base64-encoded PNG icon (≈ 4/3 of the 64KB byte cap). Structure/size are validated server-side.
export const SetIconSchema = z.object({
  data: z.string().min(1).max(96_000),
});
export type SetIconInput = z.infer<typeof SetIconSchema>;
