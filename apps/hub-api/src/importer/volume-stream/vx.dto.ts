import { z } from "zod";
import { VOLUME_ITEMREF_RE } from "./vx-constants";

/**
 * Bodies of the migration volume stream. Every schema is `.strict()` (an unknown key is a 400, so a drifting
 * migrator fails loudly), every string is length-bounded and charset-checked, and none can carry a secret.
 */

const hex64 = z.string().regex(/^[0-9a-f]{64}$/, "expected 64 hex characters");
export const runIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, "invalid runId");
const nat = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const posInt = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const shortStr = (max: number) => z.string().min(1).max(max).regex(/^[^\u0000-\u001f\u007f]*$/, "no control characters");
export const itemRefSchema = z.string().min(1).max(256).regex(VOLUME_ITEMREF_RE, "not a volume itemRef");

export const PG_LAYOUTS = ["root", "nested", "none"] as const;
export type PgLayout = (typeof PG_LAYOUTS)[number];

const imageRef = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._\/:@-]*$/, "invalid image reference");

export const VxInventoryItemSchema = z
  .object({
    itemRef: itemRefSchema,
    found: z.boolean(),
    mountType: z.enum(["volume", "bind"]),
    rawBytes: nat,
    entries: nat,
    specials: z.object({ sockets: nat, fifos: nat, devices: nat }).strict(),
    running: z.boolean(),
    exitCode: z.number().int().min(-1).max(255).optional(),
    finishedAt: shortStr(40).optional(),
    image: imageRef.optional(),
    pgMajor: z.string().regex(/^[0-9]{1,2}$/).optional(),
    pgLayout: z.enum(PG_LAYOUTS).optional(),
    mountDest: shortStr(256).optional(),
    reason: shortStr(200).optional(),
  })
  .strict();
export type VxInventoryItem = z.infer<typeof VxInventoryItemSchema>;

export const VxInventoryBodySchema = z.object({ runId: runIdSchema, items: z.array(VxInventoryItemSchema).min(1).max(1000) }).strict();
export type VxInventoryBody = z.infer<typeof VxInventoryBodySchema>;

export const VxFingerprintSchema = z
  .object({
    containerId: hex64,
    startedAt: shortStr(40),
    finishedAt: shortStr(40),
    exitCode: z.number().int().min(-1).max(255),
    mountType: z.enum(["volume", "bind"]),
    mountName: shortStr(256).optional(),
    imageId: shortStr(100),
    pgMajor: z.string().regex(/^[0-9]{1,2}$/).optional(),
  })
  .strict();
export type VxFingerprint = z.infer<typeof VxFingerprintSchema>;

export const VxBeginBodySchema = z.object({ runId: runIdSchema, partRawBytes: posInt, rawTotal: nat.optional(), fingerprint: VxFingerprintSchema }).strict();
export type VxBeginBody = z.infer<typeof VxBeginBodySchema>;

export const VxPartBodySchema = z.object({ runId: runIdSchema, rawOffset: nat, rawLen: posInt, rawSha256: hex64, size: posInt, sha256: hex64 }).strict();
export type VxPartBody = z.infer<typeof VxPartBodySchema>;

export const VxRunBodySchema = z.object({ runId: runIdSchema, phase: z.enum(["verifying", "skipping", "streaming", "applying", "provisioning"]).optional() }).strict();
export type VxRunBody = z.infer<typeof VxRunBodySchema>;

export const VxFinishBodySchema = z
  .object({
    runId: runIdSchema,
    parts: posInt,
    rawBytes: posInt,
    entries: nat,
    fingerprintAfter: z.object({ containerId: hex64, startedAt: shortStr(40), finishedAt: shortStr(40), running: z.boolean() }).strict(),
  })
  .strict();
export type VxFinishBody = z.infer<typeof VxFinishBodySchema>;

/** User-authed bodies. */
export const VxDiskCheckBodySchema = z.object({ rawBytes: nat.optional() }).strict();
/** The migrator's own disk-check body (it carries its run id like every token route). */
export const VxMigratorDiskCheckBodySchema = z.object({ runId: runIdSchema, rawBytes: nat.optional() }).strict();
export type VxMigratorDiskCheckBody = z.infer<typeof VxMigratorDiskCheckBodySchema>;
export type VxDiskCheckBody = z.infer<typeof VxDiskCheckBodySchema>;

/** Explicit "this volume is NOT migrated" decision: needs the acknowledgement, never implied. */
export const VxExcludeBodySchema = z.object({ acknowledge: z.literal(true), reason: shortStr(200).optional() }).strict();
export type VxExcludeBody = z.infer<typeof VxExcludeBodySchema>;
