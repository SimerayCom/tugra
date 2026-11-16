import type { CreateAppInput, SetBuildInput, SetContainerCommandInput, SetCustomLabelsInput, SetLimitsInput } from "../applications/dto";
import { INLINE_DOCKERFILE_MAX, SetBuildSchema, SetContainerCommandSchema, SetCustomLabelsSchema, SetDomainOptionsSchema, SetExtraDomainsSchema, SetLimitsSchema, SetNetworkAliasesSchema, SetRedirectsSchema, SetVolumesSchema, SetWatchPathsSchema, inlineDockerfileProblem } from "../applications/dto";
import type { AppVolume } from "../deploy/deploy-script";
import { CUSTOM_LABEL_KEY_RE, CUSTOM_LABEL_LIMITS, reservedLabelNamespace } from "../deploy/label-namespaces";
import type { ImportReasonCode } from "@tugra/shared";
import type { ForeignApp, ForeignDomain } from "./foreign-fleet";
import type { SourceAppExtras } from "./import-source";
import { REASON_EN, why, type Reasoned, type Unmapped } from "./reason";
import { mapBuildPack } from "./buildpack-map";
import { mapSourceEnvFlags, type SourceEnvFlags } from "./env-auto-flags";

/** Options for turning a discovered foreign app into a Tugra app to create. */
export interface AppCreateOptions {
  serverId: string; // the target Tugra server/cluster the app is created on
  environmentId?: string;
  sourceTag?: string; // e.g. "coolify" — added alongside "imported" for traceability
  gitSourceId?: string; // a connected GitHub App (GitSource) to link a private-repo import to; create() re-checks the team
  /** A Coolify SERVICE imported as a stopped compose app: no primary domain at create (its domains are per-service rows
   *  applied afterwards) and never a magic domain: `domain` stays unset and `exposeMode` is "none". */
  serviceImport?: boolean;
  /** Link the created app to an app-store template (logo + search only); set by the service importer when safe. */
  templateSlug?: string;
  name?: string; // an editable-mapping display name; unset => the source app's name (byte-identical)
}

/**
 * Pure: map a resolved {@link ForeignApp} (+ its already-fetched env values) to the exact
 * {@link CreateAppInput} the ApplicationsService expects. Source-agnostic — every source adapter's apps go
 * through this, so the executor stays one path. `deploy:false`: an import creates the record, then deploys as
 * a separate, observable step. A real domain maps to exposeMode "custom"; no domain → "none" (never mint a
 * magic domain on import — the operator cuts over DNS explicitly later).
 */
/** Coolify (and others) can store empty strings for optional fields, but CreateAppSchema requires min(1) —
 *  coerce "" to undefined so an otherwise-valid app isn't rejected. */
const opt = (v: string | undefined): string | undefined => (v ? v : undefined);

/** Coolify stores in-repo paths absolute (`/apps/api`, `/Dockerfile`, `/` for the repo root), but Tugra's
 *  REPO_PATH/BASE_DIR are repo-RELATIVE (no leading `/`). The importer calls service.create() directly, so it
 *  skips the DTO that would otherwise reject these — normalize here: strip leading slashes, collapse the
 *  root (`/`, "", `.`) to undefined, and drop a trailing slash. Returns undefined for a value that isn't a
 *  usable relative path. */
const relPath = (v: string | undefined): string | undefined => {
  if (!v) return undefined;
  const s = v.replace(/^\/+/, "").replace(/\/+$/, "");
  return s && s !== "." ? s : undefined;
};

export function foreignAppToCreateInput(
  app: ForeignApp,
  env: Record<string, string>,
  opts: AppCreateOptions,
  flags?: Record<string, SourceEnvFlags>,
  /** The result of `mapSourceEnvFlags` when the caller already computed it (it also needs the warnings): not recomputed. */
  mappedFlags?: ReturnType<typeof mapSourceEnvFlags>,
): CreateAppInput {
  const build = mapBuildPack(app); // { source: IMAGE|GIT|COMPOSE, buildType? }
  const domain = (app.domains ?? []).find((d) => d.primary) ?? (app.domains ?? [])[0];

  const input: CreateAppInput = {
    name: opts.name ?? app.name,
    serverId: opts.serverId,
    environmentId: opts.environmentId,
    source: build.source,
    env,
    deploy: false,
    tags: ["imported", ...(opts.sourceTag ? [opts.sourceTag] : [])],
    containerPort: app.ports?.[0],
    domain: opts.serviceImport ? undefined : domain?.host,
    https: opts.serviceImport ? undefined : domain?.https,
    exposeMode: opts.serviceImport ? "none" : domain ? "custom" : "none",
  };
  if (opts.templateSlug) input.templateSlug = opts.templateSlug;

  if (build.source === "IMAGE") {
    input.image = opt(app.image);
  } else if (build.source === "COMPOSE") {
    // A compose is EITHER pasted (composeFile) OR cloned from git (gitUrl + composePath) — the DTO forbids both.
    // A stored composeFile wins (raw Dokploy / Coolify compose); only a compose with NO stored YAML but a git
    // source (YAML lives in the repo) becomes a git-compose. No baseDirectory: that is GIT-build-only.
    const composeFile = opt(app.composeFile);
    const gitUrl = opt(app.git?.url);
    if (composeFile || !gitUrl) {
      input.composeFile = composeFile; // may be absent without a read:sensitive token → create validates
    } else {
      input.gitUrl = gitUrl;
      input.gitBranch = opt(app.git?.branch);
      input.composePath = relPath(app.git?.composePath?.trim().replace(/^(?:\.?\/+)+/, ""));
      if (opts.gitSourceId) input.gitSourceId = opts.gitSourceId; // link a private GitHub-App repo to a connected GitSource
    }
  } else {
    input.gitUrl = opt(app.git?.url);
    input.gitBranch = opt(app.git?.branch);
    input.buildType = build.buildType;
    // In-repo paths are normalized to Tugra's relative form (Coolify stores them absolute). baseDirectory was
    // previously dropped entirely → an imported monorepo app built from the repo root; wire it through now.
    input.dockerfilePath = relPath(app.git?.dockerfilePath);
    input.baseDirectory = relPath(app.git?.baseDirectory);
    input.buildCommand = opt(app.buildCommand);
    input.outputDir = relPath(app.publishDirectory);
    if (opts.gitSourceId) input.gitSourceId = opts.gitSourceId; // link a private GitHub-App repo to a connected GitSource
  }
  // Per-variable flags: the source's own (Coolify) mapped onto this app, plus Multiline auto-marked on any value with a
  // line break (a line break on an unflaggable name throws: that used to silently corrupt the env file). Only set when
  // non-empty so an unflagged import keeps its exact input shape.
  const mapped = mappedFlags ?? mapSourceEnvFlags(env, flags, build.source);
  if (Object.keys(mapped.flags).length) input.envFlags = mapped.flags;
  return input;
}

/** The reserved label namespace -> its reason code (the per-namespace "why" text lives in the translated string). */
const RESERVED_NS_REASON: Record<string, ImportReasonCode> = {
  "traefik.": "label_reserved_traefik",
  "tugra.": "label_reserved_tugra",
  "com.docker.compose.": "label_reserved_compose",
  "com.docker.swarm.": "label_reserved_swarm",
  "com.docker.stack.": "label_reserved_stack",
};

/** `inlineDockerfileProblem` returns one of a few fixed texts: each gets a code (anything else is `dockerfile_invalid`). */
const DOCKERFILE_PROBLEM_REASON: Record<string, ImportReasonCode> = {
  [REASON_EN.dockerfile_nul]: "dockerfile_nul",
  [REASON_EN.dockerfile_not_from]: "dockerfile_not_from",
  [REASON_EN.dockerfile_no_from]: "dockerfile_no_from",
};

/** Fixed reason for replicas: they convert the app to a swarm service, so an import never applies them silently.
 *  Shared by the executor and the plan-time coverage report so the two can never drift. */
export const REPLICAS_UNMAPPED_REASON = REASON_EN.replicas;

export interface MappedLabels {
  labels: Record<string, string>;
  dropped: Unmapped[];
  /** A DROPPED label looked like an access-control middleware (basic auth / IP allow-list / forward auth / digest). */
  accessControlDropped: boolean;
}

const ACCESS_CONTROL_LABEL_RE = /\.(basicauth|ipallowlist|ipwhitelist|forwardauth|digestauth)\b/i;
// eslint-disable-next-line no-control-regex
const LABEL_CONTROL_RE = /[\x00-\x1f\x7f]/;
const MAX_DROPPED_LABELS = 20;

/**
 * Pure, non-throwing, source-order-deterministic: filter a source's custom container labels down to the set
 * Tugra will accept, per label, using the hub gate's own constants (`deploy/label-namespaces`) so the importer
 * and the gate cannot drift. Everything dropped is reported by KEY name only (a key that fails the key regex is
 * JSON-quoted and truncated, never echoed raw) with a FIXED reason: a label VALUE never appears in the output.
 */
export function mapCustomLabels(entries: ReadonlyArray<{ key: string; value: string }>): MappedLabels {
  const L = CUSTOM_LABEL_LIMITS;
  const labels: Record<string, string> = {};
  const dropped: Unmapped[] = [];
  let droppedCount = 0;
  let accessControlDropped = false;
  const seen = new Set<string>();
  let bytes = 0;
  let count = 0;
  const drop = (key: string, field: string, reason: Reasoned) => {
    droppedCount++;
    if (ACCESS_CONTROL_LABEL_RE.test(key)) accessControlDropped = true;
    if (dropped.length < MAX_DROPPED_LABELS) dropped.push({ field, ...reason });
  };
  for (const { key, value } of entries) {
    if (key.length === 0 || key.length > L.keyMax || !CUSTOM_LABEL_KEY_RE.test(key)) {
      drop(key, `customLabel:${JSON.stringify(key.slice(0, 40))}`, why("label_invalid_key"));
      continue;
    }
    const field = `customLabel:${key}`;
    const ns = reservedLabelNamespace(key);
    if (ns) {
      drop(key, field, why(RESERVED_NS_REASON[ns] ?? "label_reserved_tugra"));
      continue;
    }
    const lower = key.toLowerCase();
    if (seen.has(lower)) {
      drop(key, field, why("label_duplicate"));
      continue;
    }
    if (value.length > L.valueMax) {
      drop(key, field, why("label_value_too_long", { max: L.valueMax }));
      continue;
    }
    if (LABEL_CONTROL_RE.test(value)) {
      drop(key, field, why("label_value_control"));
      continue;
    }
    const size = Buffer.byteLength(key, "utf8") + Buffer.byteLength(value, "utf8");
    if (count + 1 > L.maxCount || bytes + size > L.totalBytes) {
      drop(key, field, why("label_over_limit"));
      continue;
    }
    seen.add(lower);
    labels[key] = value;
    count++;
    bytes += size;
  }
  if (droppedCount > dropped.length) dropped.push({ field: "customLabel:…", ...why("labels_more", { n: droppedCount - dropped.length }) });
  if (!SetCustomLabelsSchema.safeParse({ labels }).success) {
    return { labels: {}, dropped: [{ field: "customLabels", ...why("labels_rejected") }], accessControlDropped };
  }
  return { labels, dropped, accessControlDropped };
}

/** The post-create configuration an imported app needs beyond what `CreateAppSchema` can carry — each part is
 *  the exact input of an existing ApplicationsService setter, already schema-validated. */
export interface PostCreateConfig {
  /** `setBuild` — only emitted for a Dockerfile app with a multi-stage target and/or inline Dockerfile text (the build
   *  fields create can't carry). setBuild is a FULL replace, so both live in this ONE input (never two calls). */
  build?: SetBuildInput;
  /** `setCustomLabels` — the filtered, Tugra-safe subset of the source's container labels. */
  customLabels?: SetCustomLabelsInput;
  /** `setWatchPaths` */
  watchPaths?: string[];
  /** `setAutoDeploy` */
  autoDeploy?: boolean;
  /** `setLimits` */
  limits?: SetLimitsInput;
  /** `setContainerCommand` */
  containerCommand?: SetContainerCommandInput;
  /** `setClusterConfig.replicas` — only meaningful when the import targets a swarm cluster. */
  replicas?: number;
  /** `setNetworkAliases` — each source alias (`from`) and the single DNS label Tugra answers to (`to`). */
  networkAliases?: Array<{ from: string; to: string }>;
  /** Source fields that were present but could NOT be carried (no Tugra target, or invalid for Tugra's schema). */
  unmapped: Unmapped[];
}

/** The single DNS label Tugra answers to for a source network alias: dots become hyphens (`api.internal` is `api-internal`). */
export const aliasLabelOf = (alias: string): string => alias.toLowerCase().replace(/\./g, "-");

/**
 * Pure: derive the setter inputs for the fields `foreignAppToCreateInput` cannot carry (autoDeploy, watch
 * paths, limits, exec-form command, Dockerfile build target). Every value is re-validated against the same Zod
 * schema the controller enforces, and a field that fails (or has no Tugra target) is reported in `unmapped`
 * rather than silently dropped. The executor calls the setters with these (a later slice wires that).
 */
export function foreignAppToPostCreateConfig(app: ForeignApp, extras?: SourceAppExtras): PostCreateConfig {
  const out: PostCreateConfig = { unmapped: [] };
  const skip = (field: string, reason: Reasoned) => out.unmapped.push({ field, ...reason });
  const build = mapBuildPack(app);
  const isGit = build.source === "GIT";

  // autoDeploy — a tag-triggered source must NOT become push-to-deploy, so it is turned off (and reported).
  if (app.triggerType === "tag") {
    out.autoDeploy = false;
    skip("triggerType", why("trigger_tag"));
  } else if (app.autoDeploy !== undefined) {
    out.autoDeploy = app.autoDeploy;
  }
  if (app.triggerType && app.triggerType !== "tag" && app.triggerType !== "push") skip("triggerType", why("trigger_unknown", { trigger: app.triggerType }));

  if (app.watchPaths?.length) {
    const parsed = SetWatchPathsSchema.safeParse({ watchPaths: app.watchPaths });
    if (parsed.success) out.watchPaths = parsed.data.watchPaths;
    else skip("watchPaths", why("watch_paths_invalid"));
  }

  if (app.limits) {
    const parsed = SetLimitsSchema.safeParse(app.limits);
    if (parsed.success) out.limits = parsed.data;
    else skip("limits", why("limits_invalid"));
  }

  if (app.containerEntrypoint?.length || app.containerCommand?.length) {
    if (build.source === "COMPOSE") {
      skip("containerCommand", why("command_compose"));
    } else {
      const parsed = SetContainerCommandSchema.safeParse({
        containerEntrypoint: app.containerEntrypoint?.length ? app.containerEntrypoint : null,
        containerCommand: app.containerCommand?.length ? app.containerCommand : null,
      });
      if (parsed.success) out.containerCommand = parsed.data;
      else skip("containerCommand", why("command_invalid"));
    }
  }

  // Inline Dockerfile text (secret-capable: in-memory only, never in `unmapped`). Pre-validated so a rejected text is
  // dropped with a FIXED reason (the validator messages carry no source text) while the target-only build survives.
  const isDockerfileBuild = isGit && build.buildType === "DOCKERFILE";
  let inline: string | undefined;
  if (extras?.dockerfile !== undefined) {
    if (!isDockerfileBuild) {
      skip("inlineDockerfile", why("dockerfile_not_build"));
    } else if (Buffer.byteLength(extras.dockerfile, "utf8") > INLINE_DOCKERFILE_MAX) {
      skip("inlineDockerfile", why("dockerfile_too_large"));
    } else {
      const problem = inlineDockerfileProblem(extras.dockerfile);
      if (problem) skip("inlineDockerfile", why(DOCKERFILE_PROBLEM_REASON[problem] ?? "dockerfile_invalid"));
      else inline = extras.dockerfile;
    }
  }

  if (app.dockerBuildTarget || inline) {
    if (isDockerfileBuild) {
      const base: Record<string, unknown> = {
        buildType: "DOCKERFILE",
        dockerfilePath: relPath(app.git?.dockerfilePath) ?? null,
        dockerBuildTarget: app.dockerBuildTarget,
        baseDirectory: relPath(app.git?.baseDirectory) ?? null,
      };
      if (!app.dockerBuildTarget) delete base.dockerBuildTarget;
      let parsed = SetBuildSchema.safeParse(inline ? { ...base, inlineDockerfile: inline } : base);
      if (!parsed.success && inline) {
        skip("inlineDockerfile", why("dockerfile_rejected"));
        inline = undefined;
        parsed = app.dockerBuildTarget ? SetBuildSchema.safeParse(base) : parsed;
      }
      if (parsed.success) out.build = parsed.data;
      else if (app.dockerBuildTarget) skip("dockerBuildTarget", why("build_target_invalid"));
    } else {
      skip("dockerBuildTarget", why("build_target_not_dockerfile"));
    }
  }

  // Custom container labels. Skipped for a compose app (its labels live in its compose file).
  if (extras?.labels?.length) {
    if (build.source === "COMPOSE") {
      skip("customLabels", why("labels_compose"));
    } else {
      const mapped = mapCustomLabels(extras.labels);
      if (Object.keys(mapped.labels).length) out.customLabels = { labels: mapped.labels };
      out.unmapped.push(...mapped.dropped);
      if (mapped.accessControlDropped) {
        skip("accessControl", why("access_control_dropped"));
      }
    }
  }
  if (extras?.unmapped.length) out.unmapped.push(...extras.unmapped);

  if (app.replicas !== undefined && app.replicas > 1) out.replicas = app.replicas;

  // Extra network aliases (C17: the fleet's `*.internal` names). Tugra aliases are single DNS labels, so a dotted source name is
  // carried as its label form (`api.internal` becomes `api-internal`); dependents are rewritten by the env remap. A compose app
  // manages its own networks, so it carries none. An alias Tugra would refuse (reserved prefix, too long) is reported.
  if (app.networkAliases?.length) {
    if (build.source === "COMPOSE") {
      skip("networkAliases", why("setting_rejected"));
    } else {
      const pairs = app.networkAliases.map((from) => ({ from, to: aliasLabelOf(from) }));
      const ok = SetNetworkAliasesSchema.safeParse({ aliases: pairs.map((p) => p.to) });
      if (ok.success) out.networkAliases = pairs;
      else skip("networkAliases", why("setting_rejected"));
    }
  }

  // Present on the source, but Tugra has no target — surfaced, never silently dropped.
  if (app.dockerContextPath && !/^\.?\/?$/.test(app.dockerContextPath)) skip("dockerContextPath", why("context_path"));
  if (app.staticSpa === false) skip("staticSpa", why("static_spa"));
  return out;
}

/** The ingress configuration an imported app needs beyond the ONE primary domain + guessed port that
 *  `foreignAppToCreateInput` carries — each part is the exact input of an existing ApplicationsService setter. */
export interface IngressPlan {
  /** `setExtraDomains` — classic non-primary hostnames (replace-set; the primary is excluded). */
  extraDomains: string[];
  /** `setServiceDomains` — COMPOSE per-service hostnames. */
  serviceDomains: Array<{ service: string; hostname: string; port: number }>;
  /** `setDomainOptions` — the primary domain's path routing. */
  domainOptions?: { pathPrefix: string; stripPrefix: boolean };
  /** `setContainerPort` — only when the primary domain's routing port differs from the create-time guess. */
  containerPort?: number;
  /** `setExtraPorts` — raw host-published ports (classic only), minus the HTTP ingress port. */
  extraPorts: Array<{ hostPort: number; containerPort: number; protocol: "tcp" | "udp" }>;
  /** `setRedirects` — custom redirect rules (replace-set; classic + compose). */
  redirects?: Array<{ regex: string; replacement: string; permanent: boolean }>;
  /** Source ingress that could NOT be carried — reported, never silently dropped. Field names are
   *  `domain:<host> <aspect>` / `port:<host>/<proto>`; hosts and port numbers are not secret. */
  unmapped: Unmapped[];
}

const MAX_EXTRA_DOMAINS = 10;
const MAX_SERVICE_DOMAINS = 20;
const MAX_EXTRA_PORTS = 20;
const MAX_REDIRECTS = 20;

/**
 * Pure: derive the setter inputs for a foreign app's ingress beyond create (extra domains, path routing,
 * compose per-service domains, raw published ports). Hostnames/paths are re-validated against the same Zod
 * schemas the controller enforces; anything that cannot be carried faithfully is listed in `unmapped` (a
 * domain Tugra cannot route correctly is NOT applied — a mis-routed host is worse than a reported one).
 * Out of scope here (reported): DNS-01 / custom-cert bindings and https-off domains.
 */
export function foreignAppToIngressPlan(app: ForeignApp, opts?: { noPrimary?: boolean }): IngressPlan {
  const out: IngressPlan = { extraDomains: [], serviceDomains: [], extraPorts: [], unmapped: [] };
  const skip = (field: string, reason: Reasoned) => out.unmapped.push({ field, ...reason });
  /** Bound a source-supplied string interpolated into a persisted field/reason. */
  const cl = (v: string): string => v.slice(0, 200);
  const isCompose = mapBuildPack(app).source === "COMPOSE";
  const domains = app.domains ?? [];
  // `noPrimary` (a service import): there is no create-time primary, so EVERY domain with a service binding and a port
  // becomes a service-domain row (otherwise the first would be picked as an unrouted primary and silently dropped).
  const primary = opts?.noPrimary ? undefined : domains.find((d) => d.primary) ?? domains[0]; // same pick as foreignAppToCreateInput
  const lc = (h: string) => h.trim().replace(/\.+$/, "").toLowerCase();
  const primaryHost = primary ? lc(primary.host) : undefined;
  const primaryBase = primaryHost?.replace(/^www\./, "");
  /** "/api/" → "/api"; "" / "/" / undefined → undefined (host root). */
  const normPath = (p?: string): string | undefined => {
    const t = p?.trim().replace(/^\/+/, "").replace(/\/+$/, "");
    return t ? `/${t}` : undefined;
  };

  // ── Per-domain honesty notes (every domain, primary included).
  for (const d of domains) {
    if (d.certType === "le-dns") skip(`domain:${cl(d.host)} dns-01`, why("domain_dns01"));
    else if (d.certType === "custom") skip(`domain:${cl(d.host)} custom-cert`, why("domain_custom_cert"));
    if (d.https === false || d.certType === "none") skip(`domain:${cl(d.host)} https`, why("domain_no_https"));
    if (d.redirectTo) skip(`domain:${cl(d.host)} redirect`, why("domain_redirect", { to: cl(d.redirectTo) }));
    if (d.serviceRef && !isCompose) skip(`domain:${cl(d.host)} serviceRef`, why("domain_service_not_compose"));
  }

  // ── Primary path routing (Tugra's pathPrefix is app-wide, so it mirrors the primary domain's path only).
  let primaryPath: string | undefined;
  const rawPrimaryPath = normPath(primary?.path);
  if (primary && rawPrimaryPath) {
    const stripPrefix = primary.stripPath ?? false; // Dokploy strips the matched prefix only when stripPath is set
    if (SetDomainOptionsSchema.safeParse({ pathPrefix: rawPrimaryPath, stripPrefix }).success) {
      primaryPath = rawPrimaryPath;
      out.domainOptions = { pathPrefix: rawPrimaryPath, stripPrefix };
    } else {
      skip(`domain:${cl(primary.host)} path`, why("domain_path_invalid"));
    }
  }

  // ── Hostnames beyond the primary.
  // First-seen routing tuple per host: only a TRUE duplicate (same host + path + port + serviceRef) is dropped
  // silently; a repeat with a different path/port/service is reported (Tugra serves one route per host).
  const tuple = (d: ForeignDomain): string => `${normPath(d.path) ?? ""}|${d.port ?? ""}|${d.serviceRef?.trim() ?? ""}`;
  const seen = new Map<string, string>();
  if (primary && primaryHost) seen.set(primaryHost, tuple(primary));
  const primaryPort = primary?.port;
  for (const d of domains) {
    if (d === primary) continue;
    const key = lc(d.host);
    const first = seen.get(key);
    if (first !== undefined) {
      if (first !== tuple(d)) skip(`domain:${cl(d.host)} dup`, why("domain_dup_route"));
      continue;
    }
    seen.set(key, tuple(d));
    const hostParsed = SetExtraDomainsSchema.safeParse({ domains: [d.host] });
    if (!hostParsed.success) {
      skip(`domain:${cl(d.host)} host`, why("domain_host_invalid"));
      continue;
    }
    const host = hostParsed.data.domains[0];
    // Tugra already serves the primary's www/bare counterpart, and rejects it as an extra/service domain.
    if (host === primaryBase || host === `www.${primaryBase}`) {
      skip(`domain:${cl(d.host)} alias`, why("domain_alias"));
      continue;
    }
    if (isCompose && d.serviceRef) {
      const svc = d.serviceRef.trim();
      if (!d.port || !Number.isInteger(d.port) || d.port < 1 || d.port > 65535) {
        skip(`domain:${cl(d.host)} port`, why("domain_service_no_port"));
      } else if (d.path) {
        skip(`domain:${cl(d.host)} path`, why("domain_service_path"));
      } else if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(svc)) {
        skip(`domain:${cl(d.host)} serviceRef`, why("domain_service_name_invalid"));
      } else if (out.serviceDomains.length >= MAX_SERVICE_DOMAINS) {
        skip(`domain:${cl(d.host)} limit`, why("domain_service_limit", { max: MAX_SERVICE_DOMAINS }));
      } else {
        out.serviceDomains.push({ service: svc, hostname: host, port: d.port });
      }
      continue;
    }
    // Plain alias host (classic app, or a compose domain with no service binding).
    if (!isCompose && primaryPort !== undefined && d.port !== undefined && d.port !== primaryPort) {
      skip(`domain:${cl(d.host)} port`, why("domain_port_differs", { port: d.port, primaryPort }));
      continue;
    }
    if (normPath(d.path) !== primaryPath) {
      skip(`domain:${cl(d.host)} path`, why("domain_path_differs"));
      continue;
    }
    if (out.extraDomains.length >= MAX_EXTRA_DOMAINS) {
      skip(`domain:${cl(d.host)} limit`, why("domain_extra_limit", { max: MAX_EXTRA_DOMAINS }));
      continue;
    }
    out.extraDomains.push(host);
  }
  // ── Compose primary bound to a named service: create-time routing uses the compose-inferred web service.
  if (isCompose && primary?.serviceRef) {
    skip(`domain:${cl(primary.host)} serviceRef`, why("domain_primary_service", { service: cl(primary.serviceRef) }));
  }

  // ── Corrected ingress container port (IMAGE/GIT only; COMPOSE infers it from its YAML).
  if (!isCompose && primary?.port && Number.isInteger(primary.port) && primary.port >= 1 && primary.port <= 65535 && primary.port !== app.ports?.[0]) {
    out.containerPort = primary.port;
  }

  // ── Raw host-published ports.
  const published = app.publishedPorts ?? [];
  if (isCompose) {
    if (published.length) skip("ports", why("ports_compose"));
  } else {
    // The HTTP ingress port is already published by the proxy; re-publishing it on the host is skipped (a
    // domain-less app has no ingress, so its first published port is kept).
    const httpPort = primary ? out.containerPort ?? app.ports?.[0] : undefined;
    const taken = new Set<string>();
    for (const p of published) {
      const field = `port:${p.hostPort}/${p.protocol}`;
      if (httpPort !== undefined && p.protocol === "tcp" && p.containerPort === httpPort) {
        skip(field, why("port_is_ingress", { port: p.containerPort }));
      } else if (taken.has(`${p.hostPort}/${p.protocol}`)) {
        skip(field, why("port_duplicate"));
      } else if (out.extraPorts.length >= MAX_EXTRA_PORTS) {
        skip(field, why("ports_limit", { max: MAX_EXTRA_PORTS }));
      } else {
        taken.add(`${p.hostPort}/${p.protocol}`);
        out.extraPorts.push({ hostPort: p.hostPort, containerPort: p.containerPort, protocol: p.protocol });
      }
    }
  }
  // ── Custom redirect rules (not secret) — validated against the real Tugra schema; carried losslessly.
  if (app.redirects?.length) {
    const parsed = SetRedirectsSchema.safeParse({ redirects: app.redirects.slice(0, MAX_REDIRECTS) });
    if (parsed.success) {
      out.redirects = parsed.data.redirects;
    } else {
      // One invalid rule must not cost the rest: keep each rule that validates on its own.
      const good = app.redirects.slice(0, MAX_REDIRECTS).filter((r) => SetRedirectsSchema.safeParse({ redirects: [r] }).success);
      if (good.length) out.redirects = good;
      skip("redirects", why("redirects_invalid"));
    }
    if (app.redirects.length > MAX_REDIRECTS) skip("redirects limit", why("redirects_limit", { max: MAX_REDIRECTS }));
  }
  return out;
}

/** Why a declared mount was NOT turned into a Tugra volume. */
export type VolumeSkipReason = "file-mount" | "no-mount-path" | "invalid-path" | "duplicate-path" | "over-limit" | "compose-managed";
export interface VolumeSkip {
  mountPath: string;
  reason: VolumeSkipReason;
}
export interface MappedVolumes {
  volumes: AppVolume[];
  skipped: VolumeSkip[];
}

const MAX_APP_VOLUMES = 20; // mirrors SetVolumesSchema.max(20)
const VOLUME_PATH_RE = /^\/[A-Za-z0-9._/-]+$/; // mirrors SetVolumesSchema path rule
const VOLUME_NAME_MAX = 41; // mirrors SetVolumesSchema name rule /^[a-z0-9][a-z0-9_-]{0,40}$/

/** Canonicalize a container mount path: trim, collapse repeated slashes, strip a trailing slash. */
const canonMountPath = (raw: string | undefined): string =>
  (raw ?? "").trim().replace(/\/{2,}/g, "/").replace(/(.)\/+$/, "$1");

/** Deterministic, schema-valid volume name derived from a container path (collisions resolved by the caller). */
const slugForPath = (path: string): string => {
  const s = path
    .replace(/^\/+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, VOLUME_NAME_MAX);
  return s || "data";
};

/**
 * Pure: map a discovered foreign app's declared mounts to the EMPTY per-app named volumes Tugra will declare on
 * the created app (docker name `tugra_appv_<appId>_<slug>`), plus a report of mounts we deliberately did NOT
 * declare. This slice declares the MOUNTS only — it never copies their DATA (that is a later slice).
 *
 * Both named volumes AND host bind-mounts become EMPTY named volumes at the same container path: a source
 * bind `hostPath` is a path on the SOURCE host, so re-mounting it on the target would let an untrusted source
 * pick an arbitrary writable target path (the local-docker migrator refuses binds for the same reason).
 * `ForeignVolume.name`/`hostPath` are therefore IGNORED; the destination name is derived deterministically
 * from the container mountPath so a later data slice can recompute it from (app, mountPath).
 *
 * The importer calls ApplicationsService.setVolumes directly, bypassing the controller's SetVolumesSchema, and
 * the deploy script interpolates `-v tugra_appv_<id>_<name>:<path>` UNQUOTED into `sh -c`. So this mapper
 * enforces the schema's rules itself (lowercase name, absolute restricted path, ≤20, unique) and re-parses its
 * own output with SetVolumesSchema as a final guard.
 */
export function foreignAppToVolumes(app: ForeignApp): MappedVolumes {
  const declared = app.volumes ?? [];

  // A compose app's volumes live in its compose file; the docker-run volume args are never emitted for it, so
  // declaring them would be dead data.
  if (mapBuildPack(app).source === "COMPOSE") {
    return { volumes: [], skipped: declared.map((v) => ({ mountPath: v.mountPath ?? "", reason: "compose-managed" as const })) };
  }

  const skipped: VolumeSkip[] = [];
  const seen = new Set<string>();
  const valid: string[] = []; // canonical container paths, first-seen order
  for (const v of declared) {
    if (v.type === "file") {
      skipped.push({ mountPath: v.mountPath ?? "", reason: "file-mount" });
      continue;
    }
    const path = canonMountPath(v.mountPath);
    if (!path || path === "/") {
      skipped.push({ mountPath: v.mountPath ?? "", reason: "no-mount-path" });
      continue;
    }
    const bad = path.length > 512 || !VOLUME_PATH_RE.test(path) || path.split("/").some((seg) => seg === "." || seg === "..");
    if (bad) {
      skipped.push({ mountPath: path, reason: "invalid-path" });
      continue;
    }
    if (seen.has(path)) {
      skipped.push({ mountPath: path, reason: "duplicate-path" });
      continue;
    }
    seen.add(path);
    valid.push(path);
  }

  // Deterministic + discovery-order-independent: sort by path, then cap at the schema limit.
  valid.sort();
  const survivors = valid.slice(0, MAX_APP_VOLUMES);
  for (const path of valid.slice(MAX_APP_VOLUMES)) skipped.push({ mountPath: path, reason: "over-limit" });

  const usedNames = new Set<string>();
  const volumes: AppVolume[] = [];
  for (const path of survivors) {
    const base = slugForPath(path);
    let name = base;
    for (let n = 2; usedNames.has(name); n++) {
      const suffix = `-${n}`;
      name = base.slice(0, VOLUME_NAME_MAX - suffix.length) + suffix;
    }
    usedNames.add(name);
    volumes.push({ name, path });
  }

  // Belt-and-braces: the output must satisfy the same schema the controller would have enforced. Unreachable in
  // practice — but if it ever fails, declare nothing rather than feed an unchecked value to the deploy shell.
  if (!SetVolumesSchema.safeParse({ volumes }).success) {
    return { volumes: [], skipped: declared.map((v) => ({ mountPath: v.mountPath ?? "", reason: "invalid-path" as const })) };
  }
  return { volumes, skipped };
}
