import { z } from "zod";
// Cross-module dto import: reuse the label charset from the clusters domain so app placement rules and node
// labels validate identically (dto files don't usually import each other — kept intentional + documented).
import { LABEL_KEY_RE, LABEL_VALUE_RE } from "../clusters/dto";

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
    deploy: z.boolean().optional(), // kick off a best-effort first deploy after create
    hostPort: z.number().int().min(1).max(65535).optional(),
    containerPort: z.number().int().min(1).max(65535).optional(),
    domain: z.string().min(1).optional(),
    https: z.boolean().optional(),
    exposeMode: z.enum(["magic", "port", "none", "custom"]).optional(),
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

export const SetBuildConfigSchema = z
  .object({
    registryId: z.string().min(1).nullable().optional(),
    pushToRegistry: z.boolean().optional(),
    buildServerId: z.string().min(1).nullable().optional(),
  })
  .strict();
export type SetBuildConfigInput = z.infer<typeof SetBuildConfigSchema>;

/** Deploy as a Docker Swarm service across a cluster, or clear it (clusterId: null) back to
 *  classic single-server deploy. replicas is clamped to >= 1 server-side. */
export const SetClusterConfigSchema = z
  .object({
    clusterId: z.string().min(1).nullable().optional(),
    replicas: z.number().int().min(1).max(100).nullable().optional(),
  })
  .strict();
export type SetClusterConfigInput = z.infer<typeof SetClusterConfigSchema>;

export const SetDeploySettingsSchema = z
  .object({
    deployStrategy: z.enum(["ROLLING", "RECREATE"]).optional(),
    rollbackOnFailure: z.boolean().optional(),
  })
  .strict();
export type SetDeploySettingsInput = z.infer<typeof SetDeploySettingsSchema>;

// docker --gpus value: "all", a positive count, or "device=<ids>" (indices or GPU-UUIDs). "" clears it.
// Conservative charset (validated here, shell-quoted at deploy) so it can never inject into `docker run`.
const GPU_RE = /^(all|[1-9][0-9]*|device=[A-Za-z0-9,_.:-]+)$/;

export const SetLimitsSchema = z
  .object({
    memoryMb: z.number().int().min(16).max(1024 * 1024).nullable().optional(),
    cpus: z.number().min(0.1).max(64).nullable().optional(),
    // Soft swarm scheduling hints (advisory placement, not runtime ceilings). Swarm-only.
    reserveMemoryMb: z.number().int().min(16).max(1024 * 1024).nullable().optional(),
    reserveCpus: z.number().min(0.1).max(64).nullable().optional(),
    gpus: z.union([z.string().regex(GPU_RE), z.literal("")]).nullable().optional(),
    deployTimeoutSec: z.number().int().min(30).max(3600).nullable().optional(),
  })
  // healthCmd moved to PUT /health-check; reject (not silently drop) a stale client still
  // sending it so a lost edit surfaces as an error instead of vanishing.
  .strict()
  // A reservation above the hard limit can never be scheduled. Only checkable when BOTH are sent in the same
  // call (the web form always does); a partial PATCH that omits the limit is left to Docker to reject at deploy.
  .refine((v) => v.reserveMemoryMb == null || v.memoryMb == null || v.reserveMemoryMb <= v.memoryMb, {
    message: "reserveMemoryMb must not exceed memoryMb",
    path: ["reserveMemoryMb"],
  })
  .refine((v) => v.reserveCpus == null || v.cpus == null || v.reserveCpus <= v.cpus, {
    message: "reserveCpus must not exceed cpus",
    path: ["reserveCpus"],
  });
export type SetLimitsInput = z.infer<typeof SetLimitsSchema>;

// placement: structured rules, never a raw docker expression from the client. The picker never emits
// type "nodeId" (it offers hostname/role/label — hostname is the human-legible, live-list-sourced id); nodeId
// is accepted for advanced API/PAT callers only.
export const PlacementConstraintSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hostname"), op: z.enum(["eq", "ne"]).default("eq"), value: z.string().min(1).max(253).regex(/^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/) }),
  z.object({ type: z.literal("nodeId"), op: z.enum(["eq", "ne"]).default("eq"), value: z.string().regex(/^[a-z0-9]{5,50}$/i) }),
  z.object({ type: z.literal("role"), op: z.enum(["eq", "ne"]).default("eq"), value: z.enum(["manager", "worker"]) }),
  z.object({ type: z.literal("label"), op: z.enum(["eq", "ne"]).default("eq"), key: z.string().regex(LABEL_KEY_RE), value: z.string().regex(LABEL_VALUE_RE) }),
]);
export const SetPlacementSchema = z
  .object({
    constraints: z.array(PlacementConstraintSchema).max(10),
    spreadLabelKey: z.string().regex(LABEL_KEY_RE).nullable(),
  })
  .strict();
export type SetPlacementInput = z.infer<typeof SetPlacementSchema>;

export const SetHealthCheckSchema = z
  .object({
    type: z.enum(["NONE", "HTTP", "CMD"]).nullable().optional(), // null = auto-derive
    // A URL path — the probe interpolates it into the deploy script's curl URL. Restrict to
    // safe path characters with NO shell/URL-control metacharacters (no whitespace, quotes,
    // and crucially no '&'/'?'/'#' which would either background a command or split the URL).
    // A probe path never needs a query/fragment. Combined with single-quoting at the call
    // site this is defence-in-depth against shell injection.
    path: z
      .string()
      .max(200)
      .regex(/^\/[A-Za-z0-9\-._~/%=]*$/, "path must start with / and use URL-safe characters")
      .nullable()
      .optional(),
    port: z.number().int().min(1).max(65535).nullable().optional(),
    command: z.string().min(1).max(1000).nullable().optional(),
  })
  .refine((v) => v.type !== "CMD" || (v.command != null && v.command.trim().length > 0), {
    message: "a CMD health check requires a command",
    path: ["command"],
  });
export type SetHealthCheckInput = z.infer<typeof SetHealthCheckSchema>;

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
  environmentId: z.string().min(1), // required: every app belongs to an environment
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
export const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
export const SetDomainSchema = z.object({
  domain: z.string().trim().min(1).max(253).regex(DOMAIN_RE, "invalid domain").nullable(),
});
export type SetDomainInput = z.infer<typeof SetDomainSchema>;

// One-click custom-domain DNS auto-setup (Cloudflare). `dryRun` returns the plan without writing. `overwrite`
// is required before any pre-existing record pointing elsewhere is touched. Records are always DNS-only
// (proxied=false) — proxying is not exposed in v1 because a proxied record + Flexible SSL causes a redirect loop.
export const AutoSetupDomainSchema = z.object({
  domain: z.string().trim().min(1).max(253).regex(DOMAIN_RE, "invalid domain"),
  credentialId: z.string().min(1).optional(),
  includeWww: z.boolean().optional(),
  overwrite: z.boolean().optional(),
  dryRun: z.boolean().optional(),
});
export type AutoSetupDomainInput = z.infer<typeof AutoSetupDomainSchema>;

// (Re)expose an existing app. A custom mode requires a domain; the other modes ignore it.
export const ExposeSchema = z
  .object({
    mode: z.enum(["magic", "port", "none", "custom"]),
    domain: z.string().trim().min(1).max(253).regex(DOMAIN_RE, "invalid domain").optional(),
  })
  .refine((d) => d.mode !== "custom" || !!d.domain, {
    message: "domain is required for custom mode",
    path: ["domain"],
  });
export type ExposeInput = z.infer<typeof ExposeSchema>;

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
  deploy: z.boolean().optional(), // one-call install: create + best-effort deploy
  fields: z.record(z.string()).optional(), // user-entered install values (override generated defaults)
  composeOverride: z.string().min(1).optional(), // fork-free compose edit (validated for host-escape)
  envOverride: z.record(z.string()).optional(), // extra/override env entries (encrypted, layered last)
});
export type FromTemplateInput = z.infer<typeof FromTemplateSchema>;

export const SetVolumesSchema = z.object({
  volumes: z
    .array(
      z.object({
        name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,40}$/, "lowercase name, [a-z0-9_-]"),
        // Absolute path, safe charset ONLY — no ','/'=' so it can never break docker `--mount`'s
        // comma/equals-delimited grammar (e.g. turn a named-volume mount into a `type=bind,source=/` host mount).
        path: z.string().regex(/^\/[A-Za-z0-9._/-]+$/, "absolute container path ([A-Za-z0-9._/-])"),
      }),
    )
    .max(20)
    .refine((vs) => new Set(vs.map((v) => v.name)).size === vs.length, {
      message: "volume names must be unique",
    }),
});
export type SetVolumesInput = z.infer<typeof SetVolumesSchema>;
