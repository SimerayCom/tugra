import type {
  ForeignApp,
  ForeignDb,
  ForeignDomain,
  ForeignEnv,
  ForeignFleet,
  ForeignGitProvider,
  ForeignLimits,
  ForeignLink,
  ForeignVolume,
  TugraDbEngine,
} from "../foreign-fleet";
import { versionFromImage } from "./coolify-map";

/**
 * Pure mappers: Dokploy REST JSON → the neutral {@link ForeignFleet}. Field names are taken from Dokploy's
 * Drizzle schema (verified at v0.31.0 / canary). The exact JSON SHAPES are source-derived, not live-captured
 * yet (see DOKPLOY-GOC.md S6), so every mapper tolerates missing/null fields.
 *
 * SECRET-FREE CONTRACT — CRITICAL: unlike Coolify's read token, the Dokploy API returns env VALUES, DB
 * passwords, basic-auth passwords, registry passwords and file-mount CONTENT in plaintext in the same detail
 * response as the config. These mappers therefore carry env KEYS only, DB credentials {username, database}
 * only, and never a password / env value / file-mount body. Secret values are parsed server-side at apply
 * time in DokploySource.fetchSecrets(), keyed by `secretRef` (the appName). A unit test asserts no seeded
 * secret sentinel ever appears in the serialized fleet.
 */

// ── Raw Dokploy shapes (only the fields we read) ────────────────────────────────────────────────────────

export interface DokployServer {
  serverId: string;
  name?: string | null;
  ipAddress?: string | null;
  serverType?: string | null; // "deploy" | "build" — a build server is not a workload host
}

export interface DokployDomain {
  host?: string | null;
  https?: boolean | null;
  port?: number | null; // the container port Traefik routes to
  path?: string | null;
  certificateType?: string | null; // "letsencrypt" | "none" | "custom"
  serviceName?: string | null; // compose: the member service this domain targets
  enabled?: boolean | null;
  domainType?: string | null; // "application" | "compose" | "preview"
}

export interface DokployMount {
  type?: string | null; // "volume" | "bind" | "file"
  volumeName?: string | null;
  hostPath?: string | null;
  filePath?: string | null;
  mountPath?: string | null; // container path (required by Tugra apply-map)
  // `content` (file-mount body) is deliberately NOT declared — it is a plaintext secret and must never be read here.
}

export interface DokployPort {
  publishedPort?: number | null;
  targetPort?: number | null; // the container port
  protocol?: string | null;
}

export interface DokployApplication {
  applicationId: string;
  name?: string | null;
  appName: string; // swarm service name + internal DNS host (unique); read, never parsed
  sourceType?: string | null; // docker | git | github | gitlab | bitbucket | gitea | drop
  buildType?: string | null; // dockerfile | heroku_buildpacks | paketo_buildpacks | nixpacks | static | railpack
  dockerImage?: string | null; // docker source
  registryUrl?: string | null;
  dockerfile?: string | null; // Dockerfile path
  publishDirectory?: string | null;
  command?: string | null;
  args?: string[] | null;
  replicas?: number | null;
  autoDeploy?: boolean | null; // push-to-deploy switch
  watchPaths?: string[] | null; // glob patterns gating a push deploy
  triggerType?: string | null; // "push" | "tag"
  dockerBuildStage?: string | null; // dockerfile multi-stage target
  dockerContextPath?: string | null; // dockerfile build context dir (relative to buildPath)
  isStaticSpa?: boolean | null; // static builds: SPA fallback
  // Swarm resource limits/reservations. Dokploy stores raw Swarm units as text: memory in BYTES, cpu in
  // NanoCPUs (1 CPU = 1e9). A number is tolerated too.
  cpuLimit?: string | number | null;
  cpuReservation?: string | number | null;
  memoryLimit?: string | number | null;
  memoryReservation?: string | number | null;
  // Git provider link (identity ids only — never the App credentials). `githubId` is the application column;
  // `github`/`gitProviderId` appear when the API eager-loads the provider relation.
  githubId?: string | null;
  gitProviderId?: string | null;
  github?: { githubId?: string | null; gitProviderId?: string | null } | null;
  env?: string | null; // dotenv blob
  buildArgs?: string | null; // dotenv blob (build-time)
  buildSecrets?: string | null; // dotenv blob (build-time secrets)
  // git source, per provider
  repository?: string | null;
  owner?: string | null;
  branch?: string | null;
  buildPath?: string | null;
  gitlabRepository?: string | null;
  gitlabOwner?: string | null;
  gitlabBranch?: string | null;
  gitlabBuildPath?: string | null;
  gitlabPathNamespace?: string | null;
  giteaRepository?: string | null;
  giteaOwner?: string | null;
  giteaBranch?: string | null;
  giteaBuildPath?: string | null;
  bitbucketRepository?: string | null;
  bitbucketRepositorySlug?: string | null;
  bitbucketOwner?: string | null;
  bitbucketBranch?: string | null;
  bitbucketBuildPath?: string | null;
  customGitUrl?: string | null;
  customGitBranch?: string | null;
  customGitBuildPath?: string | null;
  registryId?: string | null;
  serverId?: string | null;
  domains?: DokployDomain[] | null;
  mounts?: DokployMount[] | null;
  ports?: DokployPort[] | null;
}

export interface DokployCompose {
  composeId: string;
  name?: string | null;
  appName: string;
  composeFile?: string | null; // authoritative only for sourceType "raw"
  composePath?: string | null;
  sourceType?: string | null; // git | github | gitlab | bitbucket | gitea | raw
  composeType?: string | null; // "docker-compose" | "stack"
  env?: string | null;
  repository?: string | null;
  owner?: string | null;
  branch?: string | null;
  customGitUrl?: string | null;
  customGitBranch?: string | null;
  randomize?: boolean | null;
  isolatedDeployment?: boolean | null;
  autoDeploy?: boolean | null;
  watchPaths?: string[] | null;
  triggerType?: string | null;
  githubId?: string | null;
  gitProviderId?: string | null;
  github?: { githubId?: string | null; gitProviderId?: string | null } | null;
  serverId?: string | null;
  domains?: DokployDomain[] | null;
  mounts?: DokployMount[] | null;
}

export interface DokployDatabase {
  // id column name differs per engine (postgresId/mysqlId/…) — the source tracks it; the mapper uses appName.
  name?: string | null;
  appName: string;
  databaseName?: string | null;
  databaseUser?: string | null;
  dockerImage?: string | null;
  externalPort?: number | null;
  env?: string | null;
  serverId?: string | null;
  mounts?: DokployMount[] | null;
  // Swarm resource limits (raw Swarm units as text: memory bytes, cpu NanoCPUs). Tugra's Database has
  // memoryMb/cpus only, so the two reservations are read for an honest warning but have no target.
  cpuLimit?: string | number | null;
  cpuReservation?: string | number | null;
  memoryLimit?: string | number | null;
  memoryReservation?: string | number | null;
  // Container command/args override (e.g. mysql ["--mysql-native-password=ON"]). Read ONLY to warn that it has
  // no Tugra target — it is never carried (an arg can embed a credential, e.g. --requirepass).
  command?: string | null;
  args?: string[] | null;
  // databasePassword / databaseRootPassword are plaintext in the API — NOT declared here (never carried).
}

export type DokployEngineTable = "postgres" | "mysql" | "mariadb" | "mongo" | "redis" | "libsql";

export interface DokployFleetInput {
  servers: DokployServer[];
  apps: Array<{ detail: DokployApplication; serverRef?: string }>;
  composes: Array<{ detail: DokployCompose; serverRef?: string }>;
  databases: Array<{ detail: DokployDatabase; engineTable: DokployEngineTable; serverRef?: string }>;
  /** project/environment dotenv blobs → sharedEnv (keys only). */
  sharedEnvBlobs: Array<{ scope: "project" | "environment"; blob?: string | null }>;
  /** Secret-free git-provider identity from discover (see DokploySource). Passed through to the fleet. */
  gitProviders?: ForeignGitProvider[];
  warnings?: string[];
}

// ── Pure helpers ────────────────────────────────────────────────────────────────────────────────────────

const TABLE_ENGINE: Record<DokployEngineTable, TugraDbEngine> = {
  postgres: "POSTGRES",
  mysql: "MYSQL",
  mariadb: "MARIADB",
  mongo: "MONGO",
  redis: "REDIS",
  libsql: "LIBSQL",
};

/** Engine is the table; a `redis` row may run a KeyDB/Dragonfly image, so sniff those two from the image. */
export function dokployEngine(table: DokployEngineTable, image?: string | null): TugraDbEngine {
  if (table === "redis") {
    const img = (image ?? "").toLowerCase();
    if (/keydb/.test(img)) return "KEYDB";
    if (/dragonfly/.test(img)) return "DRAGONFLY";
  }
  return TABLE_ENGINE[table];
}

/** Dokploy buildType/sourceType → Tugra source kind + build pack. */
export function dokployBuildPack(app: DokployApplication): { kind: ForeignApp["kind"]; buildPack: ForeignApp["buildPack"] } {
  if (app.sourceType === "docker") return { kind: "image", buildPack: "image" };
  switch (app.buildType) {
    case "dockerfile":
      return { kind: "git", buildPack: "dockerfile" };
    case "static":
      return { kind: "git", buildPack: "static" };
    case "railpack":
      return { kind: "git", buildPack: "railpack" };
    case "nixpacks":
      return { kind: "git", buildPack: "nixpacks" };
    case "heroku_buildpacks":
      return { kind: "git", buildPack: "herokuish" };
    case "paketo_buildpacks":
      return { kind: "git", buildPack: "paketo" };
    default:
      return { kind: "git", buildPack: "unknown" };
  }
}

/** Derive a clone URL + branch + subdir + provider from the per-provider git columns. `undefined` when the
 *  source carries no repo (a `drop`/uploaded source, or a git source with missing columns). Self-hosted
 *  GitLab/Gitea base URLs are not stored on the app row (they need gitProvider.one), so the public host is a
 *  best-effort default — these providers need re-auth in Tugra anyway, so the URL is advisory. */
export function dokployGit(app: DokployApplication): ForeignApp["git"] | undefined {
  const dockerfilePath = app.dockerfile ?? undefined;
  switch (app.sourceType) {
    case "github":
      if (!app.owner || !app.repository) return undefined;
      return { url: `https://github.com/${app.owner}/${app.repository}.git`, branch: app.branch ?? undefined, baseDirectory: app.buildPath ?? undefined, dockerfilePath, provider: "github" };
    case "gitlab":
      if (!app.gitlabPathNamespace) return undefined;
      return { url: `https://gitlab.com/${app.gitlabPathNamespace}.git`, branch: app.gitlabBranch ?? undefined, baseDirectory: app.gitlabBuildPath ?? undefined, dockerfilePath, provider: "gitlab" };
    case "gitea":
      if (!app.giteaOwner || !app.giteaRepository) return undefined;
      return { url: `https://gitea.com/${app.giteaOwner}/${app.giteaRepository}.git`, branch: app.giteaBranch ?? undefined, baseDirectory: app.giteaBuildPath ?? undefined, dockerfilePath, provider: "gitea" };
    case "bitbucket": {
      if (!app.bitbucketOwner) return undefined;
      const slug = app.bitbucketRepositorySlug || app.bitbucketRepository;
      if (!slug) return undefined;
      return { url: `https://bitbucket.org/${app.bitbucketOwner}/${slug}.git`, branch: app.bitbucketBranch ?? undefined, baseDirectory: app.bitbucketBuildPath ?? undefined, dockerfilePath, provider: "bitbucket" };
    }
    case "git":
      if (!app.customGitUrl) return undefined;
      return { url: stripUrlCredentials(app.customGitUrl), branch: app.customGitBranch ?? undefined, baseDirectory: app.customGitBuildPath ?? undefined, dockerfilePath, provider: "git" };
    default:
      return undefined;
  }
}

/** Parse a dotenv-format blob into [{ key, value }]. Skips blanks, comments and malformed lines, and
 *  SWALLOWS the continuation lines of a multi-line quoted value (a PEM key, JSON, YAML) into the single
 *  entry — otherwise those lines would be mis-read as their own env keys and a FRAGMENT of the secret would
 *  leak into the fleet as a key name. Values are returned ONLY so the caller can classify a reference and
 *  then drop them — never put into the fleet. */
export function parseDotenv(blob?: string | null): Array<{ key: string; value: string }> {
  if (!blob) return [];
  const out: Array<{ key: string; value: string }> = [];
  const lines = blob.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    let key = line.slice(0, eq).trim();
    if (key.startsWith("export ")) key = key.slice("export ".length).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(key)) continue;
    const rhs = line.slice(eq + 1).replace(/^[ \t]+/, "");
    const quote = rhs[0] === '"' || rhs[0] === "'" ? rhs[0] : undefined;
    let value: string;
    if (quote) {
      const afterOpen = rhs.slice(1);
      const close = afterOpen.indexOf(quote);
      if (close >= 0) {
        value = afterOpen.slice(0, close); // closed on the same line
      } else {
        // Multi-line value: consume following RAW lines until the closing quote (so they are not keys).
        const parts = [afterOpen];
        while (++i < lines.length) {
          const l = lines[i];
          const c = l.indexOf(quote);
          if (c >= 0) {
            parts.push(l.slice(0, c));
            break;
          }
          parts.push(l);
        }
        value = parts.join("\n");
      }
    } else {
      value = rhs.trim();
    }
    out.push({ key, value });
  }
  return out;
}

/** Remove any embedded userinfo (`user:token@`) from a free-form git URL so a credential cannot ride into the
 *  secret-free fleet. Leaves an scp-style `git@host:path` SSH URL untouched (that `git@` is the SSH user, not
 *  a secret). Mirrors the guard the Coolify mapper documents at coolify-map.ts (it avoids git_full_url). */
export function stripUrlCredentials(url: string): string {
  const u = url.trim();
  try {
    const parsed = new URL(u);
    if (parsed.username || parsed.password) {
      parsed.username = "";
      parsed.password = "";
      return parsed.toString();
    }
    return u;
  } catch {
    // Unparsable (e.g. scp-like git@host:path) — strip only a scheme://userinfo@ segment if present.
    return u.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1");
  }
}

const SECRET_KEY_RE = /KEY|SECRET|TOKEN|PASS|PRIVATE|CREDENTIAL/i;
const VAULT_REF_RE = /\$\{\{\s*vault\./i;
const REF_RE = /\$\{\{/; // any ${{project.X}} / ${{environment.X}} / ${{SELF}} reference

/** Map a dotenv blob → secret-free ForeignEnv[] (KEYS only). Dokploy has no per-var secret flag, so `secret`
 *  is a name heuristic. A value with a `${{…}}` reference is marked for resolution; a vault ref or an
 *  undecryptable `enc:v1:` value is marked unresolvable so the planner blocks loudly rather than deploying a
 *  broken value. The VALUE is never carried. */
export function mapEnvBlob(blob: string | null | undefined, opts: { buildTime?: boolean; forceSecret?: boolean; scope?: ForeignEnv["scope"] } = {}): ForeignEnv[] {
  return parseDotenv(blob).map(({ key, value }) => {
    const ref: ForeignEnv["ref"] = VAULT_REF_RE.test(value)
      ? { type: "vault" }
      : value.startsWith("enc:v1:")
        ? { type: "encrypted" }
        : REF_RE.test(value)
          ? { type: "shared" }
          : undefined;
    const e: ForeignEnv = { key };
    if (opts.buildTime) e.buildTime = true;
    if (opts.forceSecret || SECRET_KEY_RE.test(key)) e.secret = true;
    if (opts.scope) e.scope = opts.scope;
    if (ref) e.ref = ref;
    return e;
  });
}

const CERT: Record<string, ForeignDomain["certType"]> = { letsencrypt: "le-http", custom: "custom", none: "none" };

export function mapDomain(d: DokployDomain): ForeignDomain | undefined {
  if (!d.host) return undefined;
  if (d.domainType === "preview") return undefined; // preview-deployment domain — not imported
  if (d.enabled === false) return undefined; // explicitly disabled (absent → enabled)
  return {
    host: d.host,
    https: d.https ?? undefined,
    port: d.port ?? undefined,
    path: d.path && d.path !== "/" ? d.path : undefined,
    certType: d.certificateType ? CERT[d.certificateType] : undefined,
    serviceRef: d.serviceName ?? undefined,
    primary: false,
  };
}

export function mapMount(m: DokployMount, ownerRef: string): ForeignVolume | undefined {
  if (!m.mountPath) return undefined;
  switch (m.type) {
    case "volume":
      return { name: m.volumeName ?? undefined, mountPath: m.mountPath, type: "named", ownerRef };
    case "bind":
      return { hostPath: m.hostPath ?? undefined, mountPath: m.mountPath, type: "bind", ownerRef };
    case "file":
      return { name: m.filePath ?? undefined, mountPath: m.mountPath, type: "file", ownerRef }; // content NEVER carried
    default:
      return undefined;
  }
}

/** A command/args override can embed a credential (`--requirepass X`, `--token=…`, `postgres://u:pw@h`). The
 *  fleet is secret-free, so we withhold the whole override when a token carries a secret VALUE. We match the
 *  value, not a benign flag NAME: `--mysql-native-password=ON` (boolean) and `node auth-server.js` are carried;
 *  only a real secret (a credential flag's value, or URL userinfo) is withheld. Best-effort, fail-safe. */
const CRED_FLAG = String.raw`(?:pass(?:word|wd)?|secret|token|api[-_]?key|private[-_]?key|credentials?|bearer|requirepass|auth[-_]?(?:token|pass(?:word)?))`;
const COMMAND_URL_CRED_RE = /:\/\/[^/\s:@]+:[^/\s@]+@/; // scheme://user:pass@host
const CRED_ASSIGN_RE = new RegExp(String.raw`^--?${CRED_FLAG}=(?!(?:on|off|true|false|yes|no|enabled?|disabled?|\d+)$).+`, "i"); // --token=<secret>
const CRED_FLAG_RE = new RegExp(String.raw`^--?${CRED_FLAG}$`, "i"); // bare --password (secret is the NEXT token)
export function commandLooksSecret(tokens: string[]): boolean {
  return tokens.some((t, i) => {
    if (COMMAND_URL_CRED_RE.test(t) || CRED_ASSIGN_RE.test(t)) return true;
    // a bare credential flag whose value follows as the next, non-flag token
    return CRED_FLAG_RE.test(t) && i + 1 < tokens.length && !tokens[i + 1].startsWith("-");
  });
}

/** Dokploy's runtime Command/Args override → Tugra's exec-form argv. Swarm ContainerSpec semantics:
 *  `command` (split on whitespace) is the ENTRYPOINT, `args` is the CMD. Also yields the legacy single-string
 *  `startCommand`. `withheld` = a credential-looking token was found, so NOTHING is carried (never a leak). */
export function mapCommand(command?: string | null, args?: string[] | null): { startCommand?: string; containerEntrypoint?: string[]; containerCommand?: string[]; withheld: boolean } {
  const entry = (command ?? "").split(/\s+/).filter((p) => p.length > 0);
  const rest = (args ?? []).filter((p): p is string => typeof p === "string" && p.length > 0);
  if (!entry.length && !rest.length) return { withheld: false };
  if (commandLooksSecret([...entry, ...rest])) return { withheld: true };
  return {
    startCommand: [...entry, ...rest].join(" "),
    containerEntrypoint: entry.length ? entry : undefined,
    containerCommand: rest.length ? rest : undefined,
    withheld: false,
  };
}

/** Parse a Swarm numeric limit (text or number) → a positive finite number, else undefined. */
function swarmNumber(v: string | number | null | undefined): number | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const n = typeof v === "number" ? v : /^\s*\d+(\.\d+)?\s*$/.test(v) ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
const bytesToMb = (v: string | number | null | undefined): number | undefined => {
  const n = swarmNumber(v);
  return n === undefined ? undefined : Math.max(1, Math.round(n / (1024 * 1024)));
};
const nanoToCpus = (v: string | number | null | undefined): number | undefined => {
  const n = swarmNumber(v);
  return n === undefined ? undefined : Math.round((n / 1e9) * 1000) / 1000;
};

type RawLimits = Pick<DokployApplication, "cpuLimit" | "cpuReservation" | "memoryLimit" | "memoryReservation">;
/** Dokploy raw Swarm limits (bytes / NanoCPUs) → Tugra units (MB / CPUs). Undefined when none is set/parsable. */
export function mapLimits(r: RawLimits): ForeignLimits | undefined {
  const limits: ForeignLimits = {
    memoryMb: bytesToMb(r.memoryLimit),
    cpus: nanoToCpus(r.cpuLimit),
    reserveMemoryMb: bytesToMb(r.memoryReservation),
    reserveCpus: nanoToCpus(r.cpuReservation),
  };
  for (const k of Object.keys(limits) as Array<keyof ForeignLimits>) if (limits[k] === undefined) delete limits[k];
  return Object.keys(limits).length ? limits : undefined;
}
/** True when a raw limit field is set (non-empty, non-zero) but could not be parsed → the fleet warns instead of dropping silently. */
function hasUnparsableLimit(r: RawLimits): boolean {
  const raws = [r.memoryLimit, r.cpuLimit, r.memoryReservation, r.cpuReservation];
  return raws.some((raw) => raw !== null && raw !== undefined && raw !== "" && Number(raw) !== 0 && swarmNumber(raw) === undefined);
}

/** The connected git provider id an app/compose clones through (github only in this slice). */
function gitProviderRefOf(c: { sourceType?: string | null; githubId?: string | null; github?: { githubId?: string | null } | null }): string | undefined {
  if (c.sourceType !== "github") return undefined;
  return c.githubId || c.github?.githubId || undefined;
}

const cleanStrings = (a?: string[] | null): string[] | undefined => {
  const out = (a ?? []).filter((x): x is string => typeof x === "string" && x.trim().length > 0);
  return out.length ? out : undefined;
};

/** Container ports the app listens on: the HTTP domains' ports plus any raw publish targetPorts (apply-map
 *  uses ports[0] as the container port). */
function appPorts(app: DokployApplication): number[] {
  const set = new Set<number>();
  for (const d of app.domains ?? []) if (typeof d.port === "number" && d.port > 0) set.add(d.port);
  for (const p of app.ports ?? []) if (typeof p.targetPort === "number" && p.targetPort > 0) set.add(p.targetPort);
  return [...set];
}

function withPrimary(domains: ForeignDomain[]): ForeignDomain[] {
  if (domains.length) domains[0] = { ...domains[0], primary: true };
  return domains;
}

export function mapApplication(app: DokployApplication, serverRef?: string): ForeignApp {
  const { kind, buildPack } = dokployBuildPack(app);
  const image = kind === "image" ? app.dockerImage ?? undefined : undefined;
  const domains = withPrimary((app.domains ?? []).map(mapDomain).filter((d): d is ForeignDomain => !!d));
  const cmd = mapCommand(app.command, app.args);
  return {
    sourceRef: app.appName,
    name: app.name ?? app.appName,
    kind,
    buildPack,
    image,
    imageOrigin: kind === "image" ? "registry" : kind === "git" ? "built-from-git" : undefined,
    registry: kind === "image" && app.registryUrl ? { host: app.registryUrl, secretRef: app.appName } : undefined,
    git: kind === "git" ? dokployGit(app) : undefined,
    startCommand: cmd.startCommand,
    containerEntrypoint: cmd.containerEntrypoint,
    containerCommand: cmd.containerCommand,
    publishDirectory: app.publishDirectory ?? undefined,
    ports: appPorts(app),
    domains,
    env: [
      ...mapEnvBlob(app.env),
      ...mapEnvBlob(app.buildArgs, { buildTime: true }),
      ...mapEnvBlob(app.buildSecrets, { buildTime: true, forceSecret: true }),
    ],
    volumes: (app.mounts ?? []).map((m) => mapMount(m, app.appName)).filter((v): v is ForeignVolume => !!v),
    internalHost: app.appName,
    replicas: app.replicas ?? undefined,
    autoDeploy: app.autoDeploy ?? undefined,
    watchPaths: cleanStrings(app.watchPaths),
    limits: mapLimits(app),
    dockerBuildTarget: kind === "git" && buildPack === "dockerfile" ? app.dockerBuildStage || undefined : undefined,
    gitProviderRef: kind === "git" ? gitProviderRefOf(app) : undefined,
    triggerType: app.triggerType || undefined,
    dockerContextPath: app.dockerContextPath || undefined,
    staticSpa: buildPack === "static" ? app.isStaticSpa ?? undefined : undefined,
    serverRef,
  };
}

/** Repo-relative form of an in-repo file path: strip surrounding whitespace, leading "./" and "/" (Dokploy stores
 *  "./docker-compose.prod.yml"); empty / "." → undefined. */
function normalizeRepoFilePath(v?: string | null): string | undefined {
  if (!v) return undefined;
  const s = v.trim().replace(/^(?:\.?\/+)+/, "");
  return s && s !== "." ? s : undefined;
}

export function mapCompose(c: DokployCompose, serverRef?: string): ForeignApp {
  const raw = c.sourceType === "raw";
  const domains = withPrimary((c.domains ?? []).map(mapDomain).filter((d): d is ForeignDomain => !!d));
  // For a git-backed compose the YAML lives in the repo (composeFile is "" in the DB) → carry the git source
  // and let Tugra clone. (Full compose handling — stack vs docker-compose, isolated/randomize — is slice S5.)
  const git =
    !raw && (c.owner || c.customGitUrl)
      ? {
          url: c.customGitUrl ? stripUrlCredentials(c.customGitUrl) : c.owner && c.repository ? `https://github.com/${c.owner}/${c.repository}.git` : "",
          branch: c.customGitBranch ?? c.branch ?? undefined,
          // The compose FILE's path in the repo (Dokploy default "./docker-compose.yml"). Not a build-context dir —
          // Dokploy compose has none — so baseDirectory is deliberately left unset.
          composePath: normalizeRepoFilePath(c.composePath),
          provider: c.sourceType ?? undefined,
        }
      : undefined;
  return {
    sourceRef: c.appName,
    name: c.name ?? c.appName,
    kind: "compose",
    buildPack: "dockercompose",
    composeFile: raw ? c.composeFile ?? undefined : undefined,
    git: git && git.url ? git : undefined,
    domains,
    env: mapEnvBlob(c.env),
    volumes: (c.mounts ?? []).map((m) => mapMount(m, c.appName)).filter((v): v is ForeignVolume => !!v),
    internalHost: c.appName,
    autoDeploy: c.autoDeploy ?? undefined,
    watchPaths: cleanStrings(c.watchPaths),
    gitProviderRef: git ? gitProviderRefOf(c) : undefined,
    triggerType: c.triggerType || undefined,
    serverRef,
  };
}

/** Tugra's Database has hard limits only (memoryMb/cpus) — the Swarm reservations have no target. */
function dbLimits(db: DokployDatabase): ForeignDb["limits"] {
  const l = mapLimits({ memoryLimit: db.memoryLimit, cpuLimit: db.cpuLimit });
  return l;
}

export function mapDatabase(db: DokployDatabase, engine: TugraDbEngine, serverRef?: string): ForeignDb {
  return {
    sourceRef: db.appName,
    name: db.name ?? db.appName,
    engine,
    version: versionFromImage(db.dockerImage),
    image: db.dockerImage ?? undefined,
    credentials: {
      username: db.databaseUser ?? (engine === "REDIS" || engine === "KEYDB" || engine === "DRAGONFLY" ? "default" : undefined),
      database: db.databaseName ?? undefined,
      secretRef: db.appName, // re-fetched via <engine>.one at apply time
    },
    hostInternal: db.appName,
    externalPort: db.externalPort ?? undefined,
    limits: dbLimits(db),
    volumes: (db.mounts ?? []).map((m) => mapMount(m, db.appName)).filter((v): v is ForeignVolume => !!v),
    serverRef,
  };
}

/** Boundary-safe check: does `value` contain `token` as a standalone host token (not a substring of a longer
 *  slug)? Dokploy appNames are short and share prefixes, so a naive includes() would over-link. */
function containsHostToken(value: string, token: string): boolean {
  const re = new RegExp(`(^|[^a-z0-9_-])${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9_-])`, "i");
  return re.test(value);
}

/** Scan an app's raw env VALUES for the appName of any discovered DB and emit a dependency link (DB before
 *  app in the plan). Values are only read here, never carried. Links are emitted in sorted order so the
 *  derived `dependsOn` is deterministic for the planHash. */
function scanLinks(appEnv: Array<{ key: string; value: string }>, dbHosts: Map<string, string>): ForeignLink[] {
  const links = new Map<string, ForeignLink>();
  for (const { key, value } of appEnv) {
    for (const [host, ref] of dbHosts) {
      if (containsHostToken(value, host)) {
        const existing = links.get(ref);
        if (!existing) links.set(ref, { kind: "database", ref, envKey: key, internalHost: host });
      }
    }
  }
  return [...links.values()].sort((a, b) => a.ref.localeCompare(b.ref));
}

/** Assemble a full {@link ForeignFleet} from the Dokploy resources discover already fetched. */
export function buildDokployFleet(input: DokployFleetInput): ForeignFleet {
  const warnings: string[] = [...(input.warnings ?? [])];

  const databases = input.databases.map((d) => mapDatabase(d.detail, dokployEngine(d.engineTable, d.detail.dockerImage), d.serverRef));
  const dbHostToRef = new Map<string, string>(databases.map((d) => [d.hostInternal ?? d.sourceRef, d.sourceRef]));

  const apps = input.apps.map((a) => {
    const fa = mapApplication(a.detail, a.serverRef);
    const links = scanLinks(parseDotenv(a.detail.env), dbHostToRef);
    if (links.length) fa.links = links;
    return fa;
  });
  const composeApps = input.composes.map((c) => mapCompose(c.detail, c.serverRef));

  // Honest warnings for what S1 does not fully carry.
  const dropApps = input.apps.filter((a) => a.detail.sourceType === "drop").length;
  if (dropApps > 0) warnings.push(`${dropApps} app(s) use a 'drop' (uploaded) source that lives only on the Dokploy host — re-add the source in Tugra after import`);
  const stackComposes = input.composes.filter((c) => c.detail.composeType === "stack").length;
  if (stackComposes > 0) warnings.push(`${stackComposes} compose stack(s) use Docker Swarm 'stack' mode — review service/volume names after import`);
  const dynamicComposes = input.composes.filter((c) => c.detail.randomize || c.detail.isolatedDeployment).length;
  if (dynamicComposes > 0) warnings.push(`${dynamicComposes} compose project(s) use randomize/isolated deployment — deployed names differ from the stored file`);

  // Honest warnings for the L1 fields that have NO Tugra target / were withheld / could not be parsed — never a silent drop.
  const warnApps = (pred: (a: DokployApplication) => boolean): number => input.apps.filter((a) => pred(a.detail)).length;
  const withheld = warnApps((a) => mapCommand(a.command, a.args).withheld);
  if (withheld > 0) warnings.push(`${withheld} app(s) have a start command/args that looks credential-bearing — it was NOT carried (set it in Tugra manually)`);
  const badLimits = warnApps(hasUnparsableLimit) + input.databases.filter((d) => hasUnparsableLimit(d.detail)).length;
  if (badLimits > 0) warnings.push(`${badLimits} resource(s) have a CPU/memory limit that could not be parsed — not carried`);
  const tagTriggers = warnApps((a) => a.triggerType === "tag") + input.composes.filter((c) => c.detail.triggerType === "tag").length;
  if (tagTriggers > 0) warnings.push(`${tagTriggers} resource(s) deploy on git TAGS in Dokploy — Tugra deploys on push only, so auto-deploy is turned off for them`);
  const ctxApps = warnApps((a) => !!a.dockerContextPath && !/^\.?\/?$/.test(a.dockerContextPath));
  if (ctxApps > 0) warnings.push(`${ctxApps} app(s) set a docker build context path — Tugra has no separate context (only the base directory); verify the build`);
  const nonSpa = warnApps((a) => a.buildType === "static" && a.isStaticSpa === false);
  if (nonSpa > 0) warnings.push(`${nonSpa} static app(s) disable SPA fallback — Tugra's static builds always fall back to index.html`);
  const paketoApps = warnApps((a) => a.buildType === "paketo_buildpacks");
  if (paketoApps > 0) warnings.push(`${paketoApps} app(s) build with Paketo buildpacks — Tugra builds these with the Heroku builder, which can produce a different image; verify the build or switch to Nixpacks/Dockerfile`);
  const dbArgsNames = input.databases.filter((d) => !!d.detail.command || (d.detail.args ?? []).length > 0).map((d) => d.detail.appName);
  if (dbArgsNames.length > 0) warnings.push(`${dbArgsNames.length} database(s) override the container command/args — Tugra has no target for that yet (NOT carried): ${dbArgsNames.join(", ")}. A flag like mysql's --mysql-native-password=ON changes auth behaviour, so set it on the Tugra database before clients connect.`);
  const dbReserve = input.databases.filter((d) => swarmNumber(d.detail.memoryReservation) !== undefined || swarmNumber(d.detail.cpuReservation) !== undefined).length;
  if (dbReserve > 0) warnings.push(`${dbReserve} database(s) set a CPU/memory RESERVATION — Tugra databases support hard limits only (reservation not carried)`);
  const knownProviders = new Set((input.gitProviders ?? []).map((p) => p.ref));
  const unlinked = [...apps, ...composeApps].filter((a) => a.gitProviderRef && !knownProviders.has(a.gitProviderRef)).length;
  if (unlinked > 0) warnings.push(`${unlinked} app(s) clone through a GitHub App that could not be read — they will need a GitHub connection in Tugra`);

  // appName collision across all resources (unique per table in Dokploy, but editable → cross-table clashes possible).
  const seen = new Map<string, number>();
  for (const r of [...apps, ...composeApps, ...databases]) seen.set(r.sourceRef, (seen.get(r.sourceRef) ?? 0) + 1);
  for (const [ref, n] of seen) if (n > 1) warnings.push(`service name "${ref}" is used by ${n} resources — their internal-host rewrite may be ambiguous`);

  // sharedEnv: project/environment dotenv blobs (keys only), deduped by key+scope (first scope wins per key).
  const sharedSeen = new Set<string>();
  const sharedEnv: ForeignEnv[] = [];
  for (const b of input.sharedEnvBlobs) {
    for (const e of mapEnvBlob(b.blob, { scope: b.scope })) {
      const k = `${b.scope}:${e.key}`;
      if (sharedSeen.has(k)) continue;
      sharedSeen.add(k);
      sharedEnv.push(e);
    }
  }

  return {
    servers: input.servers
      .filter((s) => s.serverType !== "build")
      .map((s) => ({ ref: s.serverId, name: s.name ?? undefined, ip: s.ipAddress ?? undefined })),
    apps: [...apps, ...composeApps],
    databases,
    services: [], // Dokploy compose is mapped as a compose app (not a ForeignService); full stacks are slice S5
    volumes: [],
    sharedEnv,
    gitProviders: input.gitProviders ?? [],
    warnings,
  };
}
