import { z } from "zod";
import { APP_MOVE_ACKS, APP_MOVE_PHASES } from "@tugra/shared";

/** The risks an operator can accept explicitly for a move (each one a documented consequence, not a toggle). */
export const MoveAckSchema = z
  .object({
    hostMounts: z.boolean().default(false), // host bind-mount DATA is not transferred
    externalVolumes: z.boolean().default(false), // compose name:/external: volumes are not transferred
    dropPrivilegedOptions: z.boolean().default(false), // OWNER-only: clears allowPrivilegedDockerOptions + dockerOptions
    dropGpus: z.boolean().default(false),
    resetCpuset: z.boolean().default(false),
    hostPortChanged: z.boolean().default(false), // plain hostPort busy on target -> reallocated
    domainChanges: z.boolean().default(false), // magic domain changes/dropped, or custom domain DNS must be repointed
  })
  .strict();
export type MoveAckInput = z.infer<typeof MoveAckSchema>;

export const MoveAppPreflightSchema = z
  .object({
    targetServerId: z.string().min(1).max(64),
    acknowledge: MoveAckSchema.default({}),
    probeLink: z.boolean().default(false), // run one real 16 MiB relay transfer source->target
  })
  .strict();
export type MoveAppPreflightInput = z.infer<typeof MoveAppPreflightSchema>;

export const StartAppMoveSchema = z
  .object({
    targetServerId: z.string().min(1).max(64),
    acknowledge: MoveAckSchema.default({}),
    repointDns: z.boolean().default(false),
    archiveRetainDays: z.number().int().min(0).max(90).default(7),
    confirmName: z.string().min(1).max(128),
  })
  .strict();
export type StartAppMoveInput = z.infer<typeof StartAppMoveSchema>;

const BlockerSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.record(z.unknown()).optional(),
  /** True when the blocker is an acknowledgement the operator can tick (cleared by `acknowledge.<ack>`). */
  ack: z.boolean().optional(),
});

export const MoveAppPreflightResultSchema = z.object({
  ok: z.boolean(), // no hard blocker and every required acknowledgement given
  blockers: z.array(BlockerSchema),
  warnings: z.array(z.object({ code: z.string(), details: z.record(z.unknown()).optional() })),
  requiredAcks: z.array(z.enum(APP_MOVE_ACKS)),
  plan: z.object({
    cheap: z.boolean(), // NEW app / nothing to move: config flip only
    volumes: z.array(
      z.object({
        name: z.string(),
        dockerName: z.string(),
        kind: z.enum(["app", "compose"]),
        sizeBytes: z.number().int().nullable(),
        state: z.enum(["move", "absent_skip", "external_skip"]),
      }),
    ),
    totalBytes: z.number().int(),
    partBytes: z.number().int(),
    estimatedParts: z.number().int(),
    sourceStagingFreeBytes: z.number().int().nullable(),
    targetFreeBytes: z.number().int().nullable(),
    estimatedDowntimeSec: z.object({ low: z.number().int(), high: z.number().int() }),
    domain: z.object({ kind: z.string(), from: z.string().nullable(), to: z.string().nullable() }),
    hostPort: z.object({ from: z.number().int().nullable(), to: z.number().int().nullable() }),
    targetIp: z.string().nullable(),
    link: z.object({ ok: z.boolean(), mbps: z.number().nullable() }).nullable(),
  }),
});
export type MoveAppPreflightResult = z.infer<typeof MoveAppPreflightResultSchema>;

export const AppMoveVolumeViewSchema = z.object({
  name: z.string(),
  state: z.string(),
  sizeBytes: z.number().int().nullable(),
  parts: z.number().int(),
  partsDone: z.number().int(),
  bytesDone: z.number().int(),
});

export const AppMoveViewSchema = z.object({
  id: z.string(),
  appId: z.string(),
  appName: z.string(),
  phase: z.enum(APP_MOVE_PHASES),
  prevStatus: z.string(),
  sourceServerId: z.string(),
  targetServerId: z.string(),
  volumes: z.array(AppMoveVolumeViewSchema),
  progress: z.object({ volumeIndex: z.number().int(), volumeCount: z.number().int(), bytesDone: z.number().int(), bytesTotal: z.number().int() }),
  warnings: z.array(z.object({ code: z.string(), details: z.record(z.unknown()).optional() })),
  failureReason: z.string().nullable(),
  failurePhase: z.enum(APP_MOVE_PHASES).nullable(),
  deploymentId: z.string().nullable(),
  cutoverAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
  archiveUntil: z.string().datetime().nullable(),
  sourcePurgedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  canCancel: z.boolean(),
  needsAttention: z.boolean(),
  /** An apply rollback snapshot is deliberately kept on the target (the only intact copy of data an apply wiped). */
  snapshotKept: z.boolean(),
  // WRITER-ONLY (apps:config): null for read-only members.
  plan: z.record(z.unknown()).nullable(),
  acks: z.record(z.boolean()).nullable(),
  logTail: z.string().nullable(),
});
export type AppMoveView = z.infer<typeof AppMoveViewSchema>;

export const StartAppMoveResultSchema = z.object({ moveId: z.string(), phase: z.enum(APP_MOVE_PHASES) });
export const OkSchema = z.object({ ok: z.literal(true) });
