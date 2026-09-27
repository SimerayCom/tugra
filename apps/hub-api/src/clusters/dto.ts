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

/** Add ONE more already-a-member server to an already-ACTIVE swarm as a worker (Phase2b). `advertiseAddr`
 *  optionally overrides the manager's auto-picked dial IP (validated as an IP literal). */
export const JoinNodeSchema = z.object({
  serverId: z.string().min(1),
  advertiseAddr: z.string().trim().min(1).max(45).optional(),
});
export type JoinNodeInput = z.infer<typeof JoinNodeSchema>;

/** Add ONE more MANAGER to an already-formed swarm (FLEET-G): promote an existing worker or have a fresh
 *  member join directly as a manager. `acknowledgeEvenQuorum` bypasses the guardrail that refuses a promote
 *  which would leave an even total manager count (buys no extra Raft fault-tolerance, raises split-vote risk). */
export const AddManagerSchema = z.object({
  serverId: z.string().min(1),
  acknowledgeEvenQuorum: z.boolean().optional(),
});
export type AddManagerInput = z.infer<typeof AddManagerSchema>;

/** Set the swarm-ingress (Traefik) replica count for HA (FLEET-H). Capped at 3 to stay under Let's Encrypt's
 *  duplicate-certificate rate limit (each replica keeps its own DNS-01 ACME store). 1 = today's single node. */
export const SetIngressReplicasSchema = z.object({
  replicas: z.number().int().min(1).max(3),
});
export type SetIngressReplicasInput = z.infer<typeof SetIngressReplicasSchema>;

/** One node in the resolved ingress pool (a swarm-joined server that hosts an ingress task). `ip` is where the
 *  operator points a DNS A record for failover. */
export const IngressNodeViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  ip: z.string().nullable(),
});
export const IngressViewSchema = z.object({
  replicas: z.number().int(),
  nodes: z.array(IngressNodeViewSchema),
});
export type IngressNodeView = z.infer<typeof IngressNodeViewSchema>;
export type IngressView = z.infer<typeof IngressViewSchema>;

// Docker node/service label charset (defence-in-depth; shq() at the shell boundary is the real safety net,
// same convention as applications/dto.ts's GPU_RE). Exported for reuse by applications/dto.ts's placement schema.
export const LABEL_KEY_RE = /^[a-z0-9]([a-z0-9_.-]{0,62})?$/i;
export const LABEL_VALUE_RE = /^[A-Za-z0-9]([A-Za-z0-9_.:/-]{0,62})?$/;

/** Add/remove docker node labels (FLEET-D). superRefine (not the 2-arg z.record form) keeps this robust across
 *  zod versions; requires at least one of add/remove. */
export const SetNodeLabelsSchema = z
  .object({
    add: z.record(z.string()).default({}),
    remove: z.array(z.string()).default([]),
  })
  .strict()
  .superRefine((d, ctx) => {
    for (const [k, v] of Object.entries(d.add)) {
      if (!LABEL_KEY_RE.test(k)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `invalid label key: ${k}`, path: ["add", k] });
      if (typeof v !== "string" || !LABEL_VALUE_RE.test(v)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `invalid label value for ${k}`, path: ["add", k] });
    }
    for (const k of d.remove) {
      if (!LABEL_KEY_RE.test(k)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `invalid label key: ${k}`, path: ["remove"] });
    }
    if (Object.keys(d.add).length === 0 && d.remove.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "provide add and/or remove" });
    }
  });
export type SetNodeLabelsInput = z.infer<typeof SetNodeLabelsSchema>;
