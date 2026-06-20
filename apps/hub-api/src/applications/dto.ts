import { z } from "zod";

export const CreateAppSchema = z
  .object({
    name: z.string().min(1),
    serverId: z.string().min(1),
    source: z.enum(["IMAGE", "GIT", "COMPOSE"]).optional(),
    image: z.string().min(1).optional(),
    gitUrl: z.string().min(1).optional(),
    gitBranch: z.string().min(1).optional(),
    buildType: z.enum(["NIXPACKS", "DOCKERFILE", "STATIC"]).optional(),
    dockerfilePath: z.string().min(1).optional(),
    buildCommand: z.string().min(1).optional(),
    outputDir: z.string().min(1).optional(),
    composeFile: z.string().min(1).optional(),
    env: z.record(z.string()).optional(),
    environmentId: z.string().min(1).optional(),
    hostPort: z.number().int().min(1).max(65535).optional(),
    containerPort: z.number().int().min(1).max(65535).optional(),
    domain: z.string().min(1).optional(),
    https: z.boolean().optional(),
  })
  .refine(
    (d) =>
      d.source === "COMPOSE"
        ? !!d.composeFile
        : d.source === "GIT"
          ? !!d.gitUrl
          : !!d.image,
    {
      message:
        "image (IMAGE), gitUrl (GIT) or composeFile (COMPOSE) is required for the chosen source",
      path: ["source"],
    },
  );
export type CreateAppInput = z.infer<typeof CreateAppSchema>;

export const SetEnvSchema = z.object({
  env: z.record(z.string()),
});
export type SetEnvInput = z.infer<typeof SetEnvSchema>;

export const SetLimitsSchema = z.object({
  healthCmd: z.string().min(1).nullable().optional(),
  memoryMb: z.number().int().min(16).max(1024 * 1024).nullable().optional(),
  cpus: z.number().min(0.1).max(64).nullable().optional(),
});
export type SetLimitsInput = z.infer<typeof SetLimitsSchema>;

export const SetCredentialsSchema = z
  .object({
    gitToken: z.string().min(1).nullable().optional(),
    registry: z
      .object({
        url: z.string().min(1).optional(),
        user: z.string().min(1),
        token: z.string().min(1),
      })
      .nullable()
      .optional(),
  })
  .refine((d) => d.gitToken !== undefined || d.registry !== undefined, {
    message: "provide gitToken and/or registry",
  });
export type SetCredentialsInput = z.infer<typeof SetCredentialsSchema>;

export const SetEnvironmentSchema = z.object({
  environmentId: z.string().min(1).nullable(),
});
export type SetEnvironmentInput = z.infer<typeof SetEnvironmentSchema>;

export const SetDomainOptionsSchema = z
  .object({
    domainRedirect: z.enum(["www", "root"]).nullable().optional(),
    securityHeaders: z.boolean().optional(),
  })
  .refine((d) => d.domainRedirect !== undefined || d.securityHeaders !== undefined, {
    message: "provide domainRedirect and/or securityHeaders",
  });
export type SetDomainOptionsInput = z.infer<typeof SetDomainOptionsSchema>;

export const PreviewConfigSchema = z.object({
  enabled: z.boolean(),
});
export type PreviewConfigInput = z.infer<typeof PreviewConfigSchema>;

export const FromTemplateSchema = z.object({
  name: z.string().min(1),
  serverId: z.string().min(1),
});
export type FromTemplateInput = z.infer<typeof FromTemplateSchema>;

export const SetVolumesSchema = z.object({
  volumes: z
    .array(
      z.object({
        name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,40}$/, "lowercase name, [a-z0-9_-]"),
        path: z.string().regex(/^\/.+/, "absolute container path"),
      }),
    )
    .max(20)
    .refine((vs) => new Set(vs.map((v) => v.name)).size === vs.length, {
      message: "volume names must be unique",
    }),
});
export type SetVolumesInput = z.infer<typeof SetVolumesSchema>;
