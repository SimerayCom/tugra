import { z } from "zod";
import { isSafeS3Endpoint, checkS3Endpoint } from "./endpoint";

/** Charset-validated inputs. Every one of these also goes through shq() when it reaches a script. */
const Endpoint = z.string().max(300).superRefine(isSafeS3Endpoint);
const Cred = z.string().min(1).max(256).regex(/^[^\r\n\0]+$/);
/** An S3 / MinIO bucket name (3..63, lowercase letters, digits, dots, hyphens). */
export const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const Bucket = z.string().regex(BUCKET_RE);
/** An `mc --exclude` glob: no path traversal, no shell metacharacters beyond the glob wildcards. */
const Glob = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9._*?/ -]+$/)
  .refine((g) => !g.includes(".."));

const Side = z.object({ endpoint: Endpoint, accessKey: Cred, secretKey: Cred });

export const CreateObjectMigrationSchema = z.object({
  name: z.string().min(1).max(80),
  targetServerId: z.string().min(1),
  preserve: z.boolean().default(true),
  source: Side,
  destination: Side,
});
export type CreateObjectMigrationInput = z.infer<typeof CreateObjectMigrationSchema>;

export const SetBucketsSchema = z.object({
  buckets: z
    .array(
      z.object({
        srcBucket: Bucket,
        dstBucket: Bucket.optional(),
        selected: z.boolean(),
        exclude: z.array(Glob).max(20).optional(),
      }),
    )
    .max(500),
});
export type SetBucketsInput = z.infer<typeof SetBucketsSchema>;

export const StartObjectMigrationSchema = z.object({
  phase: z.enum(["seed", "final"]),
  /** REQUIRED true for the final pass: the operator confirms the writers are stopped (Tugra cannot freeze an object store). */
  acknowledgeWritesFrozen: z.boolean().optional(),
  /** Final pass only: mirror deletions (`mc --remove`). Off by default; true is the explicit acknowledgement. */
  removeExtraneous: z.boolean().optional(),
  /** Acknowledge copying into a destination bucket that already has objects. */
  mergeIntoExisting: z.boolean().optional(),
});
export type StartObjectMigrationInput = z.infer<typeof StartObjectMigrationSchema>;

export const ListObjectMigrationsQuerySchema = z.object({ teamId: z.string().min(1).optional() });

export { checkS3Endpoint };

export type ObjectMigrationStatus = "DRAFT" | "PREFLIGHTED" | "SEEDING" | "SEEDED" | "FINALIZING" | "FINAL" | "VERIFYING" | "DONE" | "FAILED";
export type ObjectBucketStatus = "PENDING" | "QUEUED" | "SEEDING" | "SEEDED" | "FINALIZING" | "FINAL" | "VERIFIED" | "DIFFERS" | "FAILED";

/** A fixed-code, secret-free warning/blocker attached to a migration (no object keys, no credentials). */
export interface ObjectMigrationWarning {
  code: string;
  level: "blocker" | "warn" | "info";
  bucket?: string;
}

export interface ObjectBucketView {
  idx: number;
  srcBucket: string;
  dstBucket: string;
  exclude: string[];
  selected: boolean;
  status: ObjectBucketStatus;
  srcObjects: number | null;
  srcBytes: number | null;
  dstObjects: number | null;
  dstBytes: number | null;
  doneObjects: number | null;
  doneBytes: number | null;
  diffMissing: number | null;
  diffDiffer: number | null;
  diffExtra: number | null;
  versioning: string | null;
  /** What was exported from the source (presence only; the documents themselves are not returned). */
  configSummary: { policy: boolean; lifecycle: boolean; tags: boolean } | null;
  configStatus: string | null;
  lastError: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
}

/** NO credentials, ever: only endpoints, names, counts and fixed codes. */
export interface ObjectMigrationView {
  id: string;
  name: string;
  teamId: string;
  targetServerId: string;
  status: ObjectMigrationStatus;
  phase: "seed" | "final" | null;
  srcEndpoint: string;
  dstEndpoint: string;
  preserve: boolean;
  removeExtraneous: boolean;
  mergeIntoExisting: boolean;
  cancelRequested: boolean;
  warnings: ObjectMigrationWarning[];
  buckets: ObjectBucketView[];
  canWrite: boolean;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
}
