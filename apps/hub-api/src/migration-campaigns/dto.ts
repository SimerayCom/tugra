import { z } from "zod";
import { PLACEMENT_KINDS } from "@tugra/shared";
import { CampaignSchema, OwnerInputsRequestSchema, RebuildListSchema, RunModeSchema, RunOptionsSchema, RunScopeSchema, applyFields } from "../migration-runs/core/dto";
import { SERVER_MAP_MAX } from "../migration-runs/core/run-contract";

const Ref = z
  .string()
  .regex(/^[\x21-\x7e]{1,200}$/, "invalid source server ref")
  .refine((k) => k !== "__proto__" && k !== "constructor" && k !== "prototype", "reserved key");

/** One source server's choice. `targetServerId` is required for another server; for in place it may be omitted (the matched Tugra server is used). */
export const SourcePlacementSchema = z
  .object({ sourceServerRef: Ref, kind: z.enum(PLACEMENT_KINDS), targetServerId: z.string().min(1).max(64).nullable().optional() })
  .strict();

const { sourceKind: _k, targetServerId: _t, mapping: _m, mappingHash: _mh, ...runFields } = applyFields;
void _k;
void _t;
void _m;
void _mh;

/**
 * `POST /migration-campaigns/plan` and `POST /migration-campaigns`. A campaign is a placement over the source servers of one Coolify
 * session and the guided runs it becomes. `planHash` binds it to the plan the owner reviewed. The run fields are the ones a single run
 * takes, minus what the placement decides (target, topology, server map, scope, mapping).
 */
export const CampaignPlanSchema = z
  .object({
    sessionId: z.string().min(1).max(64),
    sourceKind: z.literal("coolify").default("coolify"),
    planHash: runFields.planHash,
    placements: z.array(SourcePlacementSchema).min(1).max(SERVER_MAP_MAX),
    /** Apps (plan item refs) of the in-place servers to build with Tugra and verify; each goes to the run of its own source server. Absent = every app reuses Coolify's image. */
    rebuild: RebuildListSchema.optional(),
    /**
     * The data modes the owner chose at review (a PostgreSQL "Volume copy"). They are part of the plan hash, so the plan is read back with the same
     * ones or its hash never matches the reviewed one.
     */
    dbDataModes: runFields.dbDataModes,
    /**
     * What the owner picked in the first step (source servers, projects, items pulled in). Every run keeps to its own source servers inside it.
     * Absent = every item of the placed source servers.
     */
    scope: RunScopeSchema.optional(),
  })
  .strict();
export type CampaignPlanInput = z.infer<typeof CampaignPlanSchema>;

export const CampaignCreateSchema = CampaignPlanSchema.extend({
  label: CampaignSchema.optional(),
  /** The owner types the number of source servers being placed (a deliberate click, the same idea as the typed counts elsewhere). */
  confirm: z.number().int().min(1).max(SERVER_MAP_MAX),
  environmentId: runFields.environmentId,
  acks: runFields.acks,
  serviceChoices: runFields.serviceChoices,
  reconcile: runFields.reconcile,
  mode: RunModeSchema.default("copy"),
  dryRun: z.boolean().default(false),
  options: RunOptionsSchema.prefault({}),
  inputs: OwnerInputsRequestSchema.default({}),
}).strict();
export type CampaignCreateInput = z.infer<typeof CampaignCreateSchema>;

export const CampaignListQuerySchema = z.object({ teamId: z.string().min(1).max(64) }).strict();
export type CampaignListQuery = z.infer<typeof CampaignListQuerySchema>;
