import { z } from "zod";

/** Sign in to a Beszel hub. The credentials are kept encrypted for the import only (1 h), or 30 days when `keepCredentials`. */
export const BeszelConnectSchema = z.object({
  teamId: z.string().min(1),
  baseUrl: z.string().url().max(2048),
  identity: z.string().min(1).max(320),
  password: z.string().min(1).max(1024),
  keepCredentials: z.boolean().optional(),
});
export type BeszelConnectInput = z.infer<typeof BeszelConnectSchema>;

const PbId = z.string().regex(/^[A-Za-z0-9]{1,32}$/, "invalid id");
/** Manual match for a Beszel system the automatic match left open: Beszel system id → Tugra server id (null = leave out). */
const Overrides = z.record(PbId, z.string().min(1).nullable()).refine((r) => Object.keys(r).length <= 1000, "too many entries");

export const BeszelPreviewSchema = z.object({
  sessionId: z.string().min(1),
  serverOverrides: Overrides.optional(),
});
export type BeszelPreviewInput = z.infer<typeof BeszelPreviewSchema>;

export const BeszelApplySchema = z.object({
  sessionId: z.string().min(1),
  /** The `hash` of the preview the operator reviewed: the apply re-plans and refuses (409) when the plan moved. */
  previewHash: z.string().regex(/^[a-f0-9]{32}$/),
  serverOverrides: Overrides.optional(),
  /** Which parts to import. Alerts need their server matched; the 30-day history is opt-in. */
  parts: z.object({ alerts: z.boolean(), channels: z.boolean(), history: z.boolean() }),
  /** Narrow to some Beszel systems (default: every matched one). */
  systemIds: z.array(PbId).max(1000).optional(),
});
export type BeszelApplyInput = z.infer<typeof BeszelApplySchema>;
