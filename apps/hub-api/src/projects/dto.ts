import { z } from "zod";

export const CreateProjectSchema = z.object({
  teamId: z.string().min(1),
  name: z.string().min(1).max(80),
});
export type CreateProjectInput = z.infer<typeof CreateProjectSchema>;

export const RenameSchema = z.object({
  name: z.string().min(1).max(80),
});
export type RenameInput = z.infer<typeof RenameSchema>;

export const CreateEnvironmentSchema = z.object({
  name: z.string().min(1).max(80),
});
export type CreateEnvironmentInput = z.infer<typeof CreateEnvironmentSchema>;

// Clone an environment with all its apps + databases into a new environment in the same project.
export const CloneEnvironmentSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
});
export type CloneEnvironmentInput = z.infer<typeof CloneEnvironmentSchema>;

// A base64-encoded PNG icon (≈ 4/3 of the 64KB byte cap). Structure/size are validated server-side.
export const SetIconSchema = z.object({
  data: z.string().min(1).max(96_000),
});
export type SetIconInput = z.infer<typeof SetIconSchema>;

// Move a project to another team (only an empty project can move).
export const MoveProjectSchema = z.object({
  teamId: z.string().min(1),
});
export type MoveProjectInput = z.infer<typeof MoveProjectSchema>;

// The empty "Default" projects the owner confirmed for removal.
export const RemoveEmptyDefaultsSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(200),
});
export type RemoveEmptyDefaultsInput = z.infer<typeof RemoveEmptyDefaultsSchema>;
