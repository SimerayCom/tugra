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
