import { z } from "zod";

// Bucket + prefix are spliced (unquoted) into the `mc` object target the agent runs via sh -c, so
// constrain them to S3-safe characters — no shell metacharacters — as defence-in-depth against
// command injection at the source (the mc scripts also escape at the point of use).
const bucketRe = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const prefixRe = /^[a-zA-Z0-9._/-]*$/;

export const CreateDestinationSchema = z
  .object({
    teamId: z.string().min(1),
    name: z.string().min(1),
    type: z.enum(["LOCAL", "S3"]).default("S3"),
    s3Bucket: z.string().min(1).max(63).regex(bucketRe, "invalid bucket name").optional(),
    s3Region: z.string().max(64).optional(),
    s3Endpoint: z.string().min(1).optional(),
    s3AccessKey: z.string().min(1).optional(),
    s3SecretKey: z.string().min(1).optional(),
    s3Prefix: z.string().max(200).regex(prefixRe, "invalid prefix").optional(),
    encryptionEnabled: z.boolean().optional(),
  })
  .refine((d) => (d.type === "S3" ? !!d.s3Bucket && !!d.s3Endpoint && !!d.s3AccessKey && !!d.s3SecretKey : true), {
    message: "S3 destinations require bucket, endpoint, accessKey and secretKey",
    path: ["type"],
  });
export type CreateDestinationInput = z.infer<typeof CreateDestinationSchema>;

// Edit an existing destination in place. DELIBERATELY limited to the fields that are SAFE to change after
// backups exist: the name, the region, and credential ROTATION (the stated parity need — rotating S3 keys
// without delete+recreate+re-point). The bucket, endpoint, prefix and encryption flag are NOT editable here:
// restore + retention-prune read the destination's CURRENT bucket/prefix/encryptionKey (backup-runner
// destinationSpecById), so changing them would orphan every existing backup (unrestorable + silently
// un-pruned) and disabling encryption would destroy the key those backups need. Those changes still mean a
// new destination. type/teamId are likewise fixed (a team change would move it out from under its databases).
// An omitted/blank s3AccessKey/s3SecretKey KEEPS the stored credential. At least one field must be present.
export const UpdateDestinationSchema = z
  .object({
    name: z.string().min(1).optional(),
    s3Region: z.string().max(64).nullable().optional(),
    s3AccessKey: z.string().min(1).optional(),
    s3SecretKey: z.string().min(1).optional(),
  })
  .strict() // reject bucket/endpoint/prefix/encryption/type/teamId loudly — they are not editable (see above)
  .refine((d) => Object.values(d).some((v) => v !== undefined), { message: "provide at least one field to update" });
export type UpdateDestinationInput = z.infer<typeof UpdateDestinationSchema>;
