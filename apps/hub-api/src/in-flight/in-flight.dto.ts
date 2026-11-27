import { z } from "zod";

/** Every kind of work that must not be cut off by a hub or agent update. */
export const IN_FLIGHT_KINDS = [
  "migration-run",
  "takeover",
  "cutover",
  "project-move",
  "app-move",
  "volume-transfer",
  "object-migration",
  "cleanup",
  "import",
  "deployment",
  "backup",
  "restore",
  "pitr-restore",
  "restore-verify",
  "rollout",
  "agent-update",
  "swarm",
  "patch",
  "reboot",
  "bulk-command",
] as const;
export type InFlightKind = (typeof IN_FLIGHT_KINDS)[number];

/**
 * One piece of work in progress. `serverIds` are the Tugra servers it touches (a hub update ignores them: any item holds the hub),
 * `teamId` is null when the owning team cannot be told, `since` is an ISO time.
 */
export const InFlightItemSchema = z.object({
  kind: z.enum(IN_FLIGHT_KINDS),
  id: z.string(),
  label: z.string(),
  serverIds: z.array(z.string()),
  teamId: z.string().nullable(),
  since: z.string(),
});
export type InFlightItem = z.infer<typeof InFlightItemSchema>;
