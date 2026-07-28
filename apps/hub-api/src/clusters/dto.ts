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

/** Form a Docker Swarm from the cluster's members (Phase2): `managerServerId` becomes the swarm manager;
 *  every other online member joins as a worker. `advertiseAddr` optionally overrides the manager's
 *  auto-picked IP (private LAN preferred) that workers dial on :2377 — validated as an IP literal. */
export const FormSwarmSchema = z.object({
  managerServerId: z.string().min(1),
  advertiseAddr: z.string().trim().min(1).max(45).optional(),
});
export type FormSwarmInput = z.infer<typeof FormSwarmSchema>;
