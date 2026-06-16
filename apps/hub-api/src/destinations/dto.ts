import { z } from "zod";

export const CreateDestinationSchema = z
  .object({
    teamId: z.string().min(1),
    name: z.string().min(1),
    type: z.enum(["LOCAL", "S3"]).default("S3"),
    s3Bucket: z.string().min(1).optional(),
    s3Region: z.string().optional(),
    s3Endpoint: z.string().min(1).optional(),
    s3AccessKey: z.string().min(1).optional(),
    s3SecretKey: z.string().min(1).optional(),
    s3Prefix: z.string().optional(),
    encryptionEnabled: z.boolean().optional(),
  })
  .refine((d) => (d.type === "S3" ? !!d.s3Bucket && !!d.s3Endpoint && !!d.s3AccessKey && !!d.s3SecretKey : true), {
    message: "S3 destinations require bucket, endpoint, accessKey and secretKey",
    path: ["type"],
  });
export type CreateDestinationInput = z.infer<typeof CreateDestinationSchema>;
