import { z } from "zod";

export const CreateAppSchema = z
  .object({
    name: z.string().min(1),
    serverId: z.string().min(1),
    source: z.enum(["IMAGE", "GIT"]).optional(),
    image: z.string().min(1).optional(),
    gitUrl: z.string().min(1).optional(),
    gitBranch: z.string().min(1).optional(),
    buildType: z.enum(["NIXPACKS", "DOCKERFILE"]).optional(),
    dockerfilePath: z.string().min(1).optional(),
    env: z.record(z.string()).optional(),
    hostPort: z.number().int().min(1).max(65535).optional(),
    containerPort: z.number().int().min(1).max(65535).optional(),
    domain: z.string().min(1).optional(),
    https: z.boolean().optional(),
  })
  .refine((d) => (d.source === "GIT" ? !!d.gitUrl : !!d.image), {
    message:
      "image is required for IMAGE source; gitUrl is required for GIT source",
    path: ["source"],
  });
export type CreateAppInput = z.infer<typeof CreateAppSchema>;

export const SetEnvSchema = z.object({
  env: z.record(z.string()),
});
export type SetEnvInput = z.infer<typeof SetEnvSchema>;
