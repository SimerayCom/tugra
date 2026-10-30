import { z } from "zod";
// Cross-module dto import: reuse the label charset from the clusters domain so app placement rules and node
// labels validate identically (dto files don't usually import each other — kept intentional + documented).
import { LABEL_KEY_RE, LABEL_VALUE_RE } from "../clusters/dto";
import { isValidUserEnvKey, isSafeEnvValue } from "../common/env-key";

// Every ingress for user-supplied env goes through this: it closes the `--env-file` line-injection
// boundary (a key with '=', whitespace or a newline, or a value with a newline, would define an extra
// variable) WITHOUT imposing the strict POSIX name regex, which would reject legitimate dotted/dashed
// keys that migrated apps already use (see common/env-key).
export const EnvRecordSchema = z
  .record(z.string())
  .refine((env) => Object.keys(env).every(isValidUserEnvKey), { message: "invalid environment variable name" })
  .refine((env) => Object.values(env).every(isSafeEnvValue), { message: "environment value must not contain a newline" });

// A relative path inside the repo (dockerfile location / static output dir / monorepo build root): no
// absolute path, no ".." traversal, no shell metacharacters (the charset bars spaces/quotes/$/;/|/&).
// Declared above the schemas that use it so there is no temporal-dead-zone ReferenceError at module load.
const REPO_PATH = z.string().min(1).max(512).regex(/^(?!\/)(?!.*\.\.)[A-Za-z0-9._][A-Za-z0-9._/-]*$/, "must be a relative path without ..");
// Monorepo build root: REPO_PATH plus canonical form — rejects ".", "./x", a trailing "/", empty ("//")
// or ".git" segments — so `${bd}/${baseDirectory}` is always a plain subdirectory, never bd itself.
export const BASE_DIR = REPO_PATH.refine(
  (s) => s !== "." && !s.endsWith("/") && !s.split("/").some((seg) => seg === "" || seg === "." || seg.toLowerCase() === ".git"),
  "must be a clean relative subdirectory (no ./, trailing /, or .git)",
);

export const CreateAppSchema = z
  .object({
    name: z.string().min(1),
    serverId: z.string().min(1),
    templateSlug: z.string().min(1).optional(),
    source: z.enum(["IMAGE", "GIT", "COMPOSE"]).optional(),
    image: z.string().min(1).optional(),
    // https/ssh only (never a local path or a value starting with `-`, which git would read as an option)
    gitUrl: z
      .string()
      .min(1)
      .regex(/^(https:\/\/|git@|ssh:\/\/)/, "git URL must be https:// or ssh")
      .optional(),
    gitBranch: z.string().min(1).optional(),
    gitSourceId: z.string().min(1).optional(),
    // Personal access token for a private https repo (GitLab/Gitea/self-hosted/GitHub). Stored encrypted.
    gitToken: z.string().min(1).optional(),
    buildType: z.enum(["NIXPACKS", "DOCKERFILE", "STATIC", "RAILPACK", "HEROKU"]).optional(),
    // relative path inside the repo, no `..` traversal and no shell metacharacters (it is spliced into
    // the `docker build -f` command; the deploy script also shell-quotes it as defense-in-depth)
    dockerfilePath: z
      .string()
      .min(1)
      .regex(/^(?!\/)(?!.*\.\.)[A-Za-z0-9._][A-Za-z0-9._/-]*$/, "invalid dockerfile path")
      .optional(),
    // Monorepo: build a subdirectory of the repo. GIT apps only (ignored server-side for IMAGE/COMPOSE).
    baseDirectory: BASE_DIR.optional(),
    buildCommand: z.string().min(1).optional(),
    outputDir: z.string().min(1).optional(),
    composeFile: z.string().min(1).optional(),
    env: EnvRecordSchema.optional(),
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
  // Reject only what actually corrupts the env file (key with '=', whitespace or newline; value with a
  // newline) — not the strict POSIX name regex, which would lock a user out of editing env on any app that
  // already holds a dotted/dashed key (common/env-key explains why that must not be retrofit).
  env: EnvRecordSchema,
});
export type SetEnvInput = z.infer<typeof SetEnvSchema>;

// Attach a managed database to this app (auto-inject its connection URI into the app's env at deploy).
export const LinkDatabaseSchema = z
  .object({
    databaseId: z.string().min(1),
    // Optional override; defaults to the engine's conventional name (DATABASE_URL / REDIS_URL / …).
    envVar: z.string().min(1).max(128).optional(),
    // When the chosen key already exists as a literal in the app env, remove it so the link isn't shadowed.
    adoptEnv: z.boolean().optional(),
  })
  .strict();
export type LinkDatabaseInput = z.infer<typeof LinkDatabaseSchema>;

export const SetBuildArgsSchema = z.object({
  buildArgs: z.record(z.string()),
});
export type SetBuildArgsInput = z.infer<typeof SetBuildArgsSchema>;

export const RenameSchema = z.object({
  name: z.string().min(1).max(100),
});
export type RenameInput = z.infer<typeof RenameSchema>;

// A custom app icon: a base64-encoded PNG. The string cap (~96k chars ≈ 70KB decoded) keeps the JSON body
// under Express's 100KB limit; the real PNG/square/size validation is server-side in ApplicationsService.
export const SetIconSchema = z.object({
  data: z.string().min(1).max(96_000),
});
export type SetIconInput = z.infer<typeof SetIconSchema>;

export const SetDockerOptionsSchema = z.object({
  dockerOptions: z.string().max(2000).nullable(),
});
export type SetDockerOptionsInput = z.infer<typeof SetDockerOptionsSchema>;

// Pre/post-deploy hook commands. Arbitrary shell run inside a container of the app's image (pre: a
// one-shot container before the swap, e.g. DB migrations; post: inside the live container after the
// health gate). NUL bytes are rejected (they would break the shell `-c` arg); length is capped. null
// clears the hook. Execution is shell-quoted + container-scoped in the deploy script, never on the host.
export const SetDeployHooksSchema = z
  .object({
    preDeployCommand: z
      .string()
      .max(4000)
      .nullable()
      .refine((s) => s === null || !s.includes("\0"), "command must not contain a NUL byte"),
    postDeployCommand: z
      .string()
      .max(4000)
      .nullable()
      .refine((s) => s === null || !s.includes("\0"), "command must not contain a NUL byte"),
  })
  .strict();
export type SetDeployHooksInput = z.infer<typeof SetDeployHooksSchema>;

// Edit a COMPOSE app's docker-compose.yml after creation. Validated server-side (valid YAML + no
// privileged / host-escaping / host-bind compose) before it can reach a deploy.
export const SetComposeFileSchema = z.object({
  composeFile: z.string().min(1).max(256 * 1024),
});
export type SetComposeFileInput = z.infer<typeof SetComposeFileSchema>;

// Edit ONLY the content of one existing config mount on a COMPOSE app. The mount is addressed by its
// exact `target`; serviceName/target/mode stay server-controlled and are never accepted here (.strict()
// rejects them), so the YAML service key and index-derived host path can't be steered. Applies on the
// next deploy. Content holds `${KEY}` placeholders resolved at deploy; a NUL byte would break the jsonb
// write, so it is rejected up front.
export const SetConfigMountContentSchema = z
  .object({
    target: z.string().min(1).max(4096),
    content: z.string().max(64 * 1024).refine((s) => !s.includes("\0"), "content must not contain a NUL byte"),
  })
  .strict();
export type SetConfigMountContentInput = z.infer<typeof SetConfigMountContentSchema>;

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

// Upload a custom TLS cert (certType "custom"). The 64 KiB cap mirrors parseCustomCert's; the real
// validation (PEM shape, key-to-cert match, domains/expiry) happens server-side in the service.
export const SetCustomCertSchema = z.object({
  cert: z.string().min(1).max(65536),
  key: z.string().min(1).max(65536),
});
export type SetCustomCertInput = z.infer<typeof SetCustomCertSchema>;

// Clone an app into a new one (same server + environment). Only the new name is operator-settable; the
// domain/cert/webhook/host-ports are reset server-side, not carried over.
export const CloneAppSchema = z
  .object({ name: z.string().trim().min(1).max(100).optional() })
  .strict();
export type CloneAppInput = z.infer<typeof CloneAppSchema>;

// --- Edit source/build settings after create (day-2 config) ---
const GIT_URL_RE = /^(https:\/\/|git@|ssh:\/\/)/;
const BUILD_TYPES = ["NIXPACKS", "DOCKERFILE", "STATIC", "RAILPACK", "HEROKU"] as const;
// A git branch: safe chars, no "..", no leading "-", capped.
const BRANCH = z.string().min(1).max(255).regex(/^[A-Za-z0-9._#/-]+$/).refine((b) => !b.includes("..") && !b.startsWith("-"), "invalid branch");
// A docker image ref: no whitespace, no leading "-" (option injection), capped.
const IMAGE = z.string().min(1).max(512).refine((s) => !/\s/.test(s) && !s.startsWith("-"), "invalid image reference");
// (REPO_PATH + BASE_DIR are declared above CreateAppSchema — shared with the create path.)
// A build command injected into a generated Dockerfile — reject newlines/NUL (which would add instructions).
const BUILD_CMD = z.string().min(1).max(1000).refine((s) => !/[\r\n\0]/.test(s), "must be a single line");

// Change where the app's code/image comes from (same source TYPE only — the service enforces by app.source).
export const SetSourceSchema = z
  .object({
    gitUrl: z.string().min(1).regex(GIT_URL_RE, "git URL must be https:// or ssh").optional(),
    gitBranch: BRANCH.optional(),
    gitSourceId: z.string().min(1).nullable().optional(), // null = unlink the GitHub App
    image: IMAGE.optional(),
  })
  .strict()
  .refine((d) => Object.keys(d).length > 0, { message: "provide at least one field to change" });
export type SetSourceInput = z.infer<typeof SetSourceSchema>;

// Change the build strategy (GIT apps only). Fields not valid for the chosen type must be absent.
export const SetBuildSchema = z
  .object({
    buildType: z.enum(BUILD_TYPES),
    dockerfilePath: REPO_PATH.nullable().optional(),
    buildCommand: BUILD_CMD.nullable().optional(),
    outputDir: REPO_PATH.nullable().optional(),
    // Monorepo build root — valid for every build type, so no type-gated refine (unlike the fields above).
    baseDirectory: BASE_DIR.nullable().optional(),
  })
  .strict()
  .refine((d) => d.buildType === "DOCKERFILE" || d.dockerfilePath == null, { message: "dockerfilePath applies only to the DOCKERFILE build type" })
  .refine((d) => d.buildType === "STATIC" || (d.buildCommand == null && d.outputDir == null), { message: "buildCommand/outputDir apply only to the STATIC build type" });
export type SetBuildInput = z.infer<typeof SetBuildSchema>;

// Lenient hostname: labels split by dots, at least one dot, no scheme/port/path.
export const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
export const SetDomainSchema = z.object({
  domain: z.string().trim().min(1).max(253).regex(DOMAIN_RE, "invalid domain").nullable(),
});
export type SetDomainInput = z.infer<typeof SetDomainSchema>;

// Multi-domain alias hostnames. Same charset as the primary (DOMAIN_RE bars backticks/spaces/wildcards →
// no Traefik-rule injection) but additionally: lowercased + trailing-dot stripped (so the panel-domain /
// dedup checks are exact), each DNS label <= 63 chars, and the last label not all-digits (rejects IP
// literals, which DOMAIN_RE accepts but Let's Encrypt can't issue for). Capped at 10 per app, no duplicates.
const ALIAS_HOST = z
  .string()
  .trim()
  .transform((h) => h.replace(/\.+$/, "").toLowerCase())
  .refine((h) => h.length >= 1 && h.length <= 253 && DOMAIN_RE.test(h), "invalid domain")
  .refine((h) => h.split(".").every((l) => l.length <= 63), "a DNS label exceeds 63 characters")
  .refine((h) => !/^\d+$/.test(h.split(".").pop() ?? ""), "the top-level label can't be all digits (not a hostname)");
export const SetExtraDomainsSchema = z
  .object({ domains: z.array(ALIAS_HOST).max(10, "at most 10 extra domains") })
  .strict()
  .refine((d) => new Set(d.domains).size === d.domains.length, { message: "duplicate domains" });
export type SetExtraDomainsInput = z.infer<typeof SetExtraDomainsSchema>;

// Per-service domains for a COMPOSE app: route a named service (on a container port) to its own hostname.
// `service` is written as a raw YAML key + hashed into a router name, so the charset is load-bearing (no
// spaces/colons/quotes/newlines). Hostnames reuse the alias rules; no duplicate hostnames; capped at 20.
const COMPOSE_SERVICE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
export const SetServiceDomainsSchema = z
  .object({
    domains: z
      .array(
        z.object({
          service: z.string().trim().regex(COMPOSE_SERVICE_RE, "invalid compose service name"),
          hostname: ALIAS_HOST,
          port: z.number().int().min(1).max(65535),
        }).strict(),
      )
      .max(20, "at most 20 service domains"),
  })
  .strict()
  .refine((d) => new Set(d.domains.map((x) => x.hostname)).size === d.domains.length, { message: "duplicate hostnames" });
export type SetServiceDomainsInput = z.infer<typeof SetServiceDomainsSchema>;

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
  envOverride: EnvRecordSchema.optional(), // extra/override env entries (encrypted, layered last)
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

export const SetHostMountsSchema = z.object({
  hostMounts: z
    .array(
      z.object({
        // Absolute paths, safe charset only — no ':' (breaks docker's `-v host:ctr` grammar) and no ','/'='.
        // The service additionally rejects the docker socket + sensitive system paths (validateHostMounts).
        hostPath: z.string().regex(/^\/[A-Za-z0-9._/-]+$/, "absolute host path ([A-Za-z0-9._/-])"),
        containerPath: z.string().regex(/^\/[A-Za-z0-9._/-]+$/, "absolute container path ([A-Za-z0-9._/-])"),
        readOnly: z.boolean().optional(),
      }),
    )
    .max(20),
});
export type SetHostMountsInput = z.infer<typeof SetHostMountsSchema>;
