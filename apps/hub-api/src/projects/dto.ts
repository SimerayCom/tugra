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
