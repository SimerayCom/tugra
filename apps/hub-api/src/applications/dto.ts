import { z } from "zod";

export const CreateAppSchema = z
  .object({
    name: z.string().min(1),
    serverId: z.string().min(1),
    templateSlug: z.string().min(1).optional(),
    source: z.enum(["IMAGE", "GIT", "COMPOSE"]).optional(),
    image: z.string().min(1).optional(),
    gitUrl: z.string().min(1).optional(),
    gitBranch: z.string().min(1).optional(),
    gitSourceId: z.string().min(1).optional(),
    buildType: z.enum(["NIXPACKS", "DOCKERFILE", "STATIC", "RAILPACK", "HEROKU"]).optional(),
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
    tags: z.array(z.string().max(40)).max(50).optional(),
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

export const SetBuildArgsSchema = z.object({
  buildArgs: z.record(z.string()),
});
export type SetBuildArgsInput = z.infer<typeof SetBuildArgsSchema>;

export const RenameSchema = z.object({
  name: z.string().min(1).max(100),
});
export type RenameInput = z.infer<typeof RenameSchema>;

export const SetDockerOptionsSchema = z.object({
  dockerOptions: z.string().max(2000).nullable(),
});
export type SetDockerOptionsInput = z.infer<typeof SetDockerOptionsSchema>;

export const SetLimitsSchema = z.object({
  healthCmd: z.string().min(1).nullable().optional(),
  memoryMb: z.number().int().min(16).max(1024 * 1024).nullable().optional(),
  cpus: z.number().min(0.1).max(64).nullable().optional(),
  deployTimeoutSec: z.number().int().min(30).max(3600).nullable().optional(),
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
    forwardAuth: z.string().url().nullable().optional(),
  })
  .refine(
    (d) =>
      d.domainRedirect !== undefined ||
      d.securityHeaders !== undefined ||
      d.forwardAuth !== undefined,
    { message: "provide domainRedirect, securityHeaders and/or forwardAuth" },
  );
export type SetDomainOptionsInput = z.infer<typeof SetDomainOptionsSchema>;

// Lenient hostname: labels split by dots, at least one dot, no scheme/port/path.
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
export const SetDomainSchema = z.object({
  domain: z.string().trim().min(1).max(253).regex(DOMAIN_RE, "invalid domain").nullable(),
});
export type SetDomainInput = z.infer<typeof SetDomainSchema>;

export const PreviewConfigSchema = z.object({
  enabled: z.boolean(),
});
export type PreviewConfigInput = z.infer<typeof PreviewConfigSchema>;

export const DeploySchema = z.object({
  noCache: z.boolean().optional(),
});
export type DeployInput = z.infer<typeof DeploySchema>;

export const FromTemplateSchema = z.object({
  name: z.string().min(1),
  serverId: z.string().min(1),
  environmentId: z.string().min(1).optional(),
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
