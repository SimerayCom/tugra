import { z } from "zod";

export const CreateTeamSchema = z.object({ name: z.string().min(1).max(80) });
export type CreateTeamInput = z.infer<typeof CreateTeamSchema>;

export const RenameTeamSchema = z.object({ name: z.string().min(1).max(80) });
export type RenameTeamInput = z.infer<typeof RenameTeamSchema>;

export const InviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(["OWNER", "ADMIN", "VIEWER"]),
});
export type InviteInput = z.infer<typeof InviteSchema>;

export const SetRoleSchema = z.object({ role: z.enum(["OWNER", "ADMIN", "VIEWER"]) });
export type SetRoleInput = z.infer<typeof SetRoleSchema>;

export const SetMemberAccessSchema = z.object({
  restrictedAccess: z.boolean(),
  accessedProjects: z.array(z.string()).default([]),
});
export type SetMemberAccessInput = z.infer<typeof SetMemberAccessSchema>;
