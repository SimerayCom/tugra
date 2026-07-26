import { z } from "zod";

/** Create a cluster (a named group of a team's servers). */
export const CreateClusterSchema = z.object({
  teamId: z.string().min(1),
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(500).optional(),
});
export type CreateClusterInput = z.infer<typeof CreateClusterSchema>;

/** Rename / re-describe a cluster (partial). `description: ""` clears it. */
export const UpdateClusterSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  description: z.string().trim().max(500).nullable().optional(),
});
export type UpdateClusterInput = z.infer<typeof UpdateClusterSchema>;

/** Set the cluster's exact server membership (replaces the current set). */
export const SetServersSchema = z.object({
  serverIds: z.array(z.string().min(1)),
});
export type SetServersInput = z.infer<typeof SetServersSchema>;
