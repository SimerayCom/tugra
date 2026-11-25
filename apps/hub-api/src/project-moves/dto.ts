import { z } from "zod";
import { MoveAckSchema } from "../app-moves/dto";

/** Read-only: what would move and what stops it. Nothing is changed. */
export const PreviewProjectMoveSchema = z
  .object({
    projectId: z.string().min(1).max(64),
    targetServerId: z.string().min(1).max(64),
    /** Needed only when the project's items sit on several servers: the move takes the items that are here. */
    sourceServerId: z.string().min(1).max(64).optional(),
    /** The risks the owner accepts for the apps' own moves (same list as one app's move). */
    acknowledge: MoveAckSchema.prefault({}),
  })
  .strict();
export type PreviewProjectMoveInput = z.infer<typeof PreviewProjectMoveSchema>;

export const StartProjectMoveSchema = PreviewProjectMoveSchema.extend({
  repointDns: z.boolean().default(false),
  /** Days the old copy is kept (the apps' source volumes, the old databases). */
  retainDays: z.number().int().min(0).max(90).default(7),
  /** The project's exact name. */
  confirmName: z.string().min(1).max(128),
}).strict();
export type StartProjectMoveInput = z.infer<typeof StartProjectMoveSchema>;

/** The owner's undo of a failed move: the project's exact name, as for starting one. */
export const RollbackProjectMoveSchema = z.object({ confirmName: z.string().min(1).max(128) }).strict();
export type RollbackProjectMoveInput = z.infer<typeof RollbackProjectMoveSchema>;
