import { z } from "zod";
import { CUTOVER_HOSTNAME_RE, PROBE_PATH_RE } from "./cutover.logic";

const Hostname = z.string().trim().toLowerCase().regex(CUTOVER_HOSTNAME_RE, "invalid hostname");
const Hostnames = z.array(Hostname).min(1).max(200);
const Cuid = z.string().trim().min(1).max(64);

/** Init: derive/refresh entries from the op's DONE app tasks. Omitted credential = try the team's Cloudflare
 *  credentials in order, first whose zone lookup succeeds. */
export const CutoverInitSchema = z.object({ dnsCredentialId: Cuid.optional() });
export type CutoverInitInput = z.infer<typeof CutoverInitSchema>;

export const CutoverSelectSchema = z.object({ hostnames: Hostnames.optional() });
export type CutoverSelectInput = z.infer<typeof CutoverSelectSchema>;

export const CutoverCertPrepSchema = CutoverSelectSchema.extend({ challenge: z.enum(["dns01", "http01"]) });
export type CutoverCertPrepInput = z.infer<typeof CutoverCertPrepSchema>;

export const CutoverCheckSchema = CutoverSelectSchema.extend({
  probeVia: z.enum(["hub", "agent"]).optional(),
  healthPath: z.string().regex(PROBE_PATH_RE, "healthPath must start with / and be printable ASCII").optional(),
});
export type CutoverCheckInput = z.infer<typeof CutoverCheckSchema>;

export const CutoverTtlSchema = CutoverSelectSchema.extend({ ttl: z.number().int().min(60).max(3600).optional() });
export type CutoverTtlInput = z.infer<typeof CutoverTtlSchema>;

export const CutoverFlipSchema = z.object({
  confirmToken: z.string().regex(/^[0-9a-f]{64}$/, "confirmToken must be the 64-hex planHash from flip-plan"),
  hostnames: Hostnames.optional(),
  batchSize: z.number().int().min(1).max(25).optional(),
  intervalSec: z.number().int().min(5).max(600).optional(),
  targetTtl: z.number().int().min(60).max(3600).optional(),
  stopOnFail: z.boolean().optional(),
  /** OFF by default and refused for stateful entries: once Tugra has taken writes a revert loses them. */
  autoRevert: z.boolean().optional(),
  keepProxied: z.boolean().optional(),
  acceptDataRisk: z.boolean().optional(),
  acceptHttp01Gap: z.boolean().optional(),
  skipTtlWait: z.boolean().optional(),
});
export type CutoverFlipInput = z.infer<typeof CutoverFlipSchema>;

export const CutoverFlipPlanQuerySchema = z.object({
  hostnames: z.string().optional(), // comma-separated, validated in the controller
  targetTtl: z.coerce.number().int().min(60).max(3600).optional(),
  keepProxied: z.enum(["true", "false"]).optional(),
});
export type CutoverFlipPlanQuery = z.infer<typeof CutoverFlipPlanQuerySchema>;

export const CutoverRevertSchema = z.object({
  hostnames: Hostnames,
  force: z.boolean().optional(),
  acknowledgeDataLoss: z.literal(true),
});
export type CutoverRevertInput = z.infer<typeof CutoverRevertSchema>;

export const CutoverFinalizeSchema = CutoverSelectSchema;
export type CutoverFinalizeInput = z.infer<typeof CutoverFinalizeSchema>;

export const CutoverFixCounterpartSchema = z.object({ applicationId: Cuid, direction: z.enum(["root", "www"]) });
export type CutoverFixCounterpartInput = z.infer<typeof CutoverFixCounterpartSchema>;

export const CutoverExcludeSchema = z.object({ hostnames: Hostnames, excluded: z.boolean() });
export type CutoverExcludeInput = z.infer<typeof CutoverExcludeSchema>;

export const CutoverSeedCertsSchema = z.object({
  serverId: Cuid.optional(),
  /** The proxy restarts for a few seconds and drops ingress for every app on that server. */
  acknowledgeProxyRestart: z.boolean(),
});
export type CutoverSeedCertsInput = z.infer<typeof CutoverSeedCertsSchema>;

// ── response shapes (secret-free: IPs, ids, TTLs, issuers and expiries only) ──

export const CutoverEntryViewSchema = z.object({
  id: z.string(),
  applicationId: z.string(),
  appName: z.string(),
  hostname: z.string(),
  role: z.string(),
  state: z.string(),
  blockReason: z.string().nullable(),
  dnsMode: z.string(),
  challenge: z.string(),
  certState: z.string(),
  certIssuer: z.string().nullable(),
  certNotAfter: z.string().nullable(),
  certError: z.string().nullable(),
  dnsObserved: z.string(),
  proxied: z.boolean().nullable(),
  viaWildcard: z.boolean(),
  sslMode: z.string().nullable(),
  currentTtl: z.number().nullable(),
  targetTtl: z.number().nullable(),
  ttlWaitUntil: z.string().nullable(),
  stateful: z.boolean(),
  needsDeploy: z.boolean(),
  warnings: z.array(z.string()),
  precheckAt: z.string().nullable(),
  flippedAt: z.string().nullable(),
  verifiedAt: z.string().nullable(),
  finalizedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  /** The source PaaS' own name for the app, for the printed stop steps (never a secret). */
  sourceName: z.string().nullable(),
});
export type CutoverEntryView = z.infer<typeof CutoverEntryViewSchema>;

export const CutoverServerViewSchema = z.object({
  serverId: z.string(),
  name: z.string(),
  publicIp: z.string().nullable(),
  publicIpv6: z.string().nullable(),
  proxyBind: z.string(),
  acmeEmailOk: z.boolean(),
  dnsReady: z.boolean(),
  dnsProvider: z.string().nullable(),
  dnsCredentialId: z.string().nullable(),
  coverage: z.enum(["verified", "unverified", "none"]),
  warnings: z.array(z.string()),
});

export const CutoverViewSchema = z.object({
  opId: z.string(),
  run: z
    .object({ id: z.string(), status: z.string(), batchesDone: z.number(), total: z.number(), startedAt: z.string(), heartbeatAt: z.string(), lastError: z.string().nullable() })
    .nullable(),
  summary: z.object({
    total: z.number(), planned: z.number(), certReady: z.number(), ready: z.number(), switched: z.number(), verified: z.number(),
    blocked: z.number(), conflict: z.number(), failed: z.number(), excluded: z.number(),
  }),
  servers: z.array(CutoverServerViewSchema),
  entries: z.array(CutoverEntryViewSchema),
  /** Staged source certificates waiting to be applied (counts only), when the migrator ran with --certs. */
  certs: z.object({ staged: z.number(), applied: z.number() }),
});
export type CutoverView = z.infer<typeof CutoverViewSchema>;

export interface FlipPlanRecord { type: string; name: string; action: "create" | "update" | "delete" | "noop"; old: { content: string; ttl: number; proxied: boolean } | null; new: { content: string; ttl: number; proxied: boolean } | null }
export interface FlipPlan {
  opId: string;
  planHash: string;
  entries: Array<{ hostname: string; appName: string; challenge: string; records: FlipPlanRecord[]; warnings: string[] }>;
  rate: { batchSize: number; intervalSec: number; estimatedSeconds: number };
  blocked: Array<{ hostname: string; reason: string }>;
  /** Manual-DNS hosts: the exact records to create by hand plus the TTL guidance. */
  copyPaste: Array<{ hostname: string; type: string; name: string; content: string; ttl: number; lowerTtlBefore: string | null }>;
  /** Printed stop steps for the source (the Coolify token is read-only, so Cutover never stops it). */
  sourceStop: Array<{ appName: string; sourceName: string | null; hostnames: string[] }>;
}
