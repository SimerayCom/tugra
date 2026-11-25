import { z } from "zod";

const Currency = z.string().regex(/^[A-Z]{3}$/, "must be a 3-letter currency code such as EUR");
/** A monthly amount typed by a person (major units, e.g. 12.5). Converted to integer cents in the service. */
const Monthly = z.number().finite().min(0).max(10_000_000);

export const SetServerCostSchema = z.object({ monthly: Monthly, currency: Currency }).strict();
export type SetServerCostInput = z.infer<typeof SetServerCostSchema>;

export const CreateBaselineSchema = z
  .object({
    teamId: z.string().min(1),
    label: z.string().trim().min(1).max(80).optional(),
    /** Omit both to save the CURRENT prices of the team's servers as the "before" bill. */
    monthly: Monthly.optional(),
    currency: Currency.optional(),
  })
  .strict()
  .refine((v) => (v.monthly === undefined) === (v.currency === undefined), { message: "monthly and currency go together" });
export type CreateBaselineInput = z.infer<typeof CreateBaselineSchema>;

export const RescaleSchema = z
  .object({
    planSlug: z.string().regex(/^[a-z0-9]{2,16}$/, "must be a provider plan id"),
    /** The server's name, typed: the move shuts the server down. */
    confirmName: z.string().min(1).max(200),
    /** Grow the disk as well (permanent: a bigger disk can never be shrunk again). Default false keeps the move reversible. */
    upgradeDisk: z.boolean().optional(),
  })
  .strict();
export type RescaleInput = z.infer<typeof RescaleSchema>;

const MoneyTotal = z.object({ currency: z.string(), monthlyCents: z.number().int(), estimatedCents: z.number().int(), servers: z.number().int() });

const AppShare = z.object({
  key: z.string(),
  kind: z.enum(["app", "db", "system", "other"]),
  resourceId: z.string().nullable(),
  name: z.string(),
  sharePct: z.number(),
  cents: z.number().int(),
});

const ServerCostView = z.object({
  serverId: z.string(),
  name: z.string(),
  monthlyCents: z.number().int().nullable(),
  currency: z.string().nullable(),
  /** provider = read from the provider API; manual = typed; estimate = from the bundled dated price snapshot. */
  source: z.enum(["provider", "manual", "estimate", "unknown"]),
  provider: z.string().nullable(),
  /** Where `provider` came from: a link or provisioning, the host's own agent, or a guess from its host name. A hint the price can replace. */
  providerHint: z.enum(["linked", "agent", "hostname"]).nullable(),
  planSlug: z.string().nullable(),
  planLabel: z.string().nullable(),
  /** Estimates only: the plan is from the host's own provider list. Another provider's list never stands in. */
  estimateBasis: z.enum(["list"]).nullable(),
  /** Estimates only: false when this provider's snapshot rows were not re-read on the snapshot date. */
  snapshotVerified: z.boolean().nullable(),
  /** Estimates only: the day this provider's list was read. */
  snapshotDate: z.string().nullable(),
  /** Unknown prices only: no size yet, no provider known, no list for this provider, or no plan close to this size. */
  unknownReason: z.enum(["no_size", "no_provider", "no_list", "no_plan"]).nullable(),
  /** Unknown prices only: a muted comparison, a similar size on another provider's public list. Never this server's plan. */
  similar: z.object({ provider: z.string(), monthlyCents: z.number().int(), currency: z.string(), snapshotDate: z.string() }).nullable(),
  syncedAt: z.string().nullable(),
  /** The server is linked to a provider whose API can report the real price. */
  canSync: z.boolean(),
  cores: z.number().int().nullable(),
  memBytes: z.number().nullable(),
  diskBytes: z.number().nullable(),
  apps: z.array(AppShare),
});

const BaselineView = z.object({ id: z.string(), label: z.string(), monthlyCents: z.number().int(), currency: z.string(), createdAt: z.string(), servers: z.number().int() });

const ComparisonView = z.object({
  baseline: BaselineView,
  currency: z.string(),
  beforeCents: z.number().int(),
  afterCents: z.number().int(),
  deltaCents: z.number().int(),
  /** Whole percent of the before bill (negative = cheaper now). */
  deltaPct: z.number(),
  yearlyDeltaCents: z.number().int(),
  /** The current prices include estimates (the figure is as good as they are). */
  includesEstimates: z.boolean(),
});

export const TeamCostSchema = z.object({
  teamId: z.string(),
  teamName: z.string(),
  canManage: z.boolean(),
  canOps: z.boolean(),
  totals: z.array(MoneyTotal),
  servers: z.array(ServerCostView),
  baselines: z.array(BaselineView),
  /** Null when there is no baseline, or its currency differs from every current total. */
  comparison: ComparisonView.nullable(),
  snapshotDate: z.string(),
});
export type TeamCostView = z.infer<typeof TeamCostSchema>;

export const CostsReportSchema = z.object({ teams: z.array(TeamCostSchema) });
export type CostsReport = z.infer<typeof CostsReportSchema>;

export const SyncResultSchema = z.object({
  synced: z.number().int(),
  failed: z.array(z.object({ credentialName: z.string(), message: z.string() })),
});
export type SyncResult = z.infer<typeof SyncResultSchema>;

const PlanView = z.object({
  slug: z.string(),
  label: z.string(),
  cores: z.number(),
  memoryGb: z.number(),
  diskGb: z.number(),
  monthlyCents: z.number().int(),
  currency: z.string(),
});

const AdviceView = z.object({
  serverId: z.string(),
  name: z.string(),
  teamId: z.string(),
  kind: z.enum(["learning", "ok", "downsize", "near_limit"]),
  reasons: z.array(z.enum(["cpu", "memory", "disk"])),
  daysCollected: z.number(),
  daysNeeded: z.number().int(),
  usage: z
    .object({ cpuAvgPct: z.number(), cpuP95Pct: z.number(), memP95Pct: z.number(), diskUsedPct: z.number() })
    .nullable(),
  provider: z.string().nullable(),
  current: z
    .object({
      slug: z.string().nullable(),
      label: z.string().nullable(),
      cores: z.number(),
      memoryGb: z.number(),
      diskGb: z.number(),
      monthlyCents: z.number().int().nullable(),
      currency: z.string().nullable(),
    })
    .nullable(),
  target: PlanView.nullable(),
  /** Positive = saves per month, negative = costs more; null when no price comparison is possible. */
  savingsCents: z.number().int().nullable(),
  /** Price source of the comparison: the provider's own price list ("provider"), the dated snapshot of the host's provider ("list"), or none (no price list for this provider: usage only). */
  priceBasis: z.enum(["provider", "list", "none"]),
  upgradeDisk: z.boolean(),
  /** The smaller plan has a smaller disk than this server: disks do not shrink, so it takes a new, smaller server. */
  diskBlocked: z.boolean(),
  /** "api": the provider API is connected, one click can rescale (needs Read & Write on the token); "guide": steps only. */
  rescale: z.enum(["api", "guide"]),
  rescaleBlocked: z.enum(["local_hub", "active"]).nullable(),
});
export type AdviceViewT = z.infer<typeof AdviceView>;

export const AdviceReportSchema = z.object({ advice: z.array(AdviceView), snapshotDate: z.string() });
export type AdviceReport = z.infer<typeof AdviceReportSchema>;

export const RescaleViewSchema = z.object({
  id: z.string(),
  serverId: z.string(),
  provider: z.string(),
  fromPlan: z.string(),
  toPlan: z.string(),
  phase: z.enum(["SHUTTING_DOWN", "RESIZING", "POWERING_ON", "DONE", "FAILED"]),
  error: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type RescaleView = z.infer<typeof RescaleViewSchema>;

export const RescaleStatusSchema = z.object({ rescale: RescaleViewSchema.nullable() });
