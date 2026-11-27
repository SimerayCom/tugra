import { why } from "../reason";
import type { ForeignApp, ForeignDb, ForeignDomain, ForeignEnv, ForeignFleet, ForeignLink, ForeignVolume, TugraDbEngine } from "../foreign-fleet";
import type { FetchedDbCredentials } from "../import-source";
import { versionFromImage } from "./coolify-map";
import { stripUrlCredentials } from "./dokploy-map";

/**
 * Pure mappers: CapRover `appDefinitions` JSON → the neutral {@link ForeignFleet}. Written from the behaviour of
 * CapRover's public API (`GET /api/v2/user/apps/appDefinitions`); every field is optional and tolerated missing.
 *
 * SECRET-FREE CONTRACT: CapRover returns env values, git credentials and the app's basic-auth password in
 * plaintext in the same list as the config. The fleet carries env KEYS and non-secret identity only. The git
 * `user`/`password`/`sshKey` and the `httpAuth` password are deliberately not declared here, so no mapper can read
 * them. Secret values are read server-side at apply time by CaproverSource.
 */

// ── Raw CapRover shapes (only the fields we read) ───────────────────────────────────────────────────────

export interface CaproverEnvVar {
  key?: string | null;
  value?: unknown;
}

export interface CaproverVolume {
  containerPath?: string | null;
  volumeName?: string | null;
  hostPath?: string | null;
}

export interface CaproverPort {
  containerPort?: number | null;
  hostPort?: number | null;
  protocol?: string | null;
}

export interface CaproverDomain {
  publicDomain?: string | null;
  hasSsl?: boolean | null;
}

export interface CaproverVersion {
  version?: number | null;
  deployedImageName?: string | null;
}

export interface CaproverAppDefinition {
  appName: string;
  description?: string | null;
  instanceCount?: number | null;
  hasPersistentData?: boolean | null;
  notExposeAsWebApp?: boolean | null;
  containerHttpPort?: number | null;
  forceSsl?: boolean | null;
  websocketSupport?: boolean | null;
  hasDefaultSubDomainSsl?: boolean | null;
  deployedVersion?: number | null;
  versions?: CaproverVersion[] | null;
  envVars?: CaproverEnvVar[] | null;
  volumes?: CaproverVolume[] | null;
  ports?: CaproverPort[] | null;
  customDomain?: CaproverDomain[] | null;
  redirectDomain?: string | null;
  captainDefinitionRelativeFilePath?: string | null;
  preDeployFunction?: string | null;
  customNginxConfig?: string | null;
  serviceUpdateOverride?: string | null;
  /** Only the repo + branch: the git user, password and ssh key are never declared. */
  appPushWebhook?: { repoInfo?: { repo?: string | null; branch?: string | null } | null } | null;
  /** Only the user name: the password is read by CaproverSource.fetchBasicAuthCredentials alone. */
  httpAuth?: { user?: string | null } | null;
}

export interface CaproverFleetInput {
  definitions: CaproverAppDefinition[];
  rootDomain?: string | null;
  warnings?: string[];
}

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────────────────

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const validPort = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 65535;
const SECRET_KEY_RE = /KEY|SECRET|TOKEN|PASS|PRIVATE|CREDENTIAL/i;

/** The swarm service name other apps reach an app by (`http://srv-captain--<app>`). */
export const caproverHost = (appName: string): string => `srv-captain--${appName}`;

/** The image of the version CapRover has deployed (the one recorded as `deployedVersion`; the newest when absent). */
export function deployedImage(app: CaproverAppDefinition): string | undefined {
  const versions = (app.versions ?? []).filter((v) => v && str(v.deployedImageName));
  if (!versions.length) return undefined;
  const hit = typeof app.deployedVersion === "number" ? versions.find((v) => v.version === app.deployedVersion) : undefined;
  const pick = hit ?? versions.reduce((a, b) => ((b.version ?? 0) >= (a.version ?? 0) ? b : a));
  return str(pick.deployedImageName);
}

/** CapRover names the images it builds itself `img-captain--<app>:<n>`; without a registry prefix they exist on the source host only. */
const LOCAL_IMAGE_RE = /^img-captain--/;
const isLocalImage = (image: string): boolean => LOCAL_IMAGE_RE.test(image);
const isCaproverRegistryImage = (image: string): boolean => !isLocalImage(image) && /(^|\/)img-captain--/.test(image);

/** Repository path of an image without registry host, tag or digest: `docker.io/library/postgres:16` -> `library/postgres`. */
function imagePath(image: string): string {
  let r = image.trim().toLowerCase().replace(/@.*$/, "");
  const segs = r.split("/");
  if (segs.length > 1 && (segs[0].includes(".") || segs[0].includes(":") || segs[0] === "localhost")) segs.shift();
  r = segs.join("/");
  return r.replace(/:[^/:]*$/, "").replace(/^library\//, "");
}

const DB_IMAGE_ENGINE: Record<string, TugraDbEngine> = {
  postgres: "POSTGRES",
  "postgis/postgis": "POSTGRES",
  "bitnami/postgresql": "POSTGRES",
  mysql: "MYSQL",
  "mysql/mysql-server": "MYSQL",
  "bitnami/mysql": "MYSQL",
  mariadb: "MARIADB",
  "bitnami/mariadb": "MARIADB",
  mongo: "MONGO",
  "mongodb/mongodb-community-server": "MONGO",
  "bitnami/mongodb": "MONGO",
  redis: "REDIS",
  "bitnami/redis": "REDIS",
  "eqalpha/keydb": "KEYDB",
  "dragonflydb/dragonfly": "DRAGONFLY",
  "clickhouse/clickhouse-server": "CLICKHOUSE",
};

/** The database engine a CapRover app's image runs, or undefined when the image is not a known database image. */
export function caproverEngine(image: string | undefined): TugraDbEngine | undefined {
  return image && !isLocalImage(image) ? DB_IMAGE_ENGINE[imagePath(image)] : undefined;
}

/** An app is carried as a Tugra database when it runs a known database image as a single instance. */
export function isDatabaseApp(app: CaproverAppDefinition): boolean {
  return !!caproverEngine(deployedImage(app)) && (app.instanceCount ?? 1) <= 1;
}

/** Env entries as `[key, value]` (values kept only so the caller can classify or hand them to the secret path). */
export function envPairs(app: Pick<CaproverAppDefinition, "envVars">): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const e of app.envVars ?? []) {
    const key = str(e?.key);
    if (!key) continue;
    const v = e.value;
    out.push([key, typeof v === "string" ? v : v === null || v === undefined ? "" : String(v)]);
  }
  return out;
}

/** Env KEYS only (the value is never carried). `secret` is a name heuristic: CapRover has no per-variable secret flag. */
export function mapEnvKeys(app: Pick<CaproverAppDefinition, "envVars">): ForeignEnv[] {
  const seen = new Set<string>();
  const out: ForeignEnv[] = [];
  for (const [key] of envPairs(app)) {
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(SECRET_KEY_RE.test(key) ? { key, secret: true } : { key });
  }
  return out;
}

export function mapVolumes(app: Pick<CaproverAppDefinition, "volumes">, ownerRef: string): ForeignVolume[] {
  const out: ForeignVolume[] = [];
  for (const v of app.volumes ?? []) {
    const mountPath = str(v?.containerPath);
    if (!mountPath) continue;
    const name = str(v.volumeName);
    const hostPath = str(v.hostPath);
    if (name) out.push({ name, mountPath, type: "named", ownerRef });
    else if (hostPath) out.push({ hostPath, mountPath, type: "bind", ownerRef });
  }
  return out;
}

/** Host-published ports, lossless; rows without a valid host and container port are skipped, a repeated host binding collapses. */
export function mapPublishedPorts(ports?: CaproverPort[] | null): NonNullable<ForeignApp["publishedPorts"]> {
  const out: NonNullable<ForeignApp["publishedPorts"]> = [];
  const seen = new Set<string>();
  for (const p of ports ?? []) {
    if (!validPort(p?.hostPort) || !validPort(p?.containerPort)) continue;
    const protocol = typeof p.protocol === "string" && p.protocol.trim().toLowerCase() === "udp" ? "udp" : "tcp";
    const key = `${p.hostPort}/${protocol}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ hostPort: p.hostPort, containerPort: p.containerPort, protocol });
  }
  return out;
}

/** The clone URL of the repository an app deploys from (host/path form gets https://); credentials are stripped. */
export function repoUrl(repo: string | null | undefined): string | undefined {
  const r = str(repo);
  if (!r) return undefined;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(r) || /^[\w.-]+@[\w.-]+:/.test(r);
  return stripUrlCredentials(hasScheme ? r : `https://${r}`);
}

function mapDomains(app: CaproverAppDefinition): ForeignDomain[] {
  if (app.notExposeAsWebApp === true) return [];
  const port = validPort(app.containerHttpPort) ? app.containerHttpPort : 80;
  const out: ForeignDomain[] = [];
  for (const d of app.customDomain ?? []) {
    const host = str(d?.publicDomain)?.toLowerCase();
    if (!host || out.some((x) => x.host === host)) continue;
    out.push({ host, https: d.hasSsl === true, port, certType: d.hasSsl === true ? "le-http" : "none", primary: out.length === 0 });
  }
  return out;
}

const nonEmpty = (v: unknown): boolean => typeof v === "string" && v.trim().length > 0;

function appNotCarried(app: CaproverAppDefinition, ctx: { git: boolean; image?: string; hasDomains: boolean }): NonNullable<ForeignApp["notCarried"]> {
  const out: NonNullable<ForeignApp["notCarried"]> = [];
  if (nonEmpty(app.customNginxConfig)) out.push({ field: "customNginxConfig", level: "warn", ...why("caprover_nginx_config") });
  if (nonEmpty(app.preDeployFunction)) out.push({ field: "preDeployFunction", level: "warn", ...why("caprover_pre_deploy") });
  if (nonEmpty(app.serviceUpdateOverride)) out.push({ field: "serviceUpdateOverride", level: "info", ...why("caprover_service_override") });
  if (nonEmpty(app.redirectDomain)) out.push({ field: "redirectDomain", level: "info", ...why("caprover_redirect_domain") });
  if (app.notExposeAsWebApp !== true && !ctx.hasDomains) out.push({ field: "domains", level: "info", ...why("caprover_default_domain") });
  if (ctx.git) out.push({ field: "captainDefinition", level: "info", ...why("caprover_captain_definition") });
  if (ctx.image && isCaproverRegistryImage(ctx.image)) out.push({ field: "registry", level: "info", ...why("caprover_registry") });
  return out;
}

/** Container ports an app listens on: the web port when it is exposed, plus every raw published container port (apply uses ports[0]). */
function appPorts(app: CaproverAppDefinition): number[] {
  const set: number[] = [];
  if (app.notExposeAsWebApp !== true) set.push(validPort(app.containerHttpPort) ? app.containerHttpPort : 80);
  for (const p of app.ports ?? []) if (validPort(p?.containerPort) && !set.includes(p.containerPort)) set.push(p.containerPort);
  return set;
}

export function mapApplication(app: CaproverAppDefinition): ForeignApp {
  const repo = repoUrl(app.appPushWebhook?.repoInfo?.repo);
  const image = deployedImage(app);
  const domains = mapDomains(app);
  const persistent = app.hasPersistentData === true;
  const count = typeof app.instanceCount === "number" && app.instanceCount >= 1 ? app.instanceCount : undefined;
  const pub = mapPublishedPorts(app.ports);
  const users = str(app.httpAuth?.user);
  const base = {
    sourceRef: app.appName,
    name: app.appName,
    ports: appPorts(app),
    publishedPorts: pub.length ? pub : undefined,
    domains,
    basicAuth: users ? { users: [users] } : undefined,
    env: mapEnvKeys(app),
    volumes: mapVolumes(app, app.appName),
    internalHost: caproverHost(app.appName),
    // A persistent app keeps its data on one node: a single replica, like a Tugra stateful app.
    replicas: persistent ? 1 : count,
  };
  if (repo) {
    const branch = str(app.appPushWebhook?.repoInfo?.branch);
    const notCarried = appNotCarried(app, { git: true, image, hasDomains: domains.length > 0 });
    return {
      ...base,
      kind: "git",
      buildPack: "dockerfile",
      imageOrigin: "built-from-git",
      git: { url: repo, ...(branch ? { branch } : {}), provider: "git" },
      ...(notCarried.length ? { notCarried } : {}),
    };
  }
  const local = !!image && isLocalImage(image);
  const notCarried = appNotCarried(app, { git: false, image, hasDomains: domains.length > 0 });
  return {
    ...base,
    kind: "image",
    buildPack: "image",
    ...(image && !local ? { image } : {}),
    imageOrigin: local ? "local" : "registry",
    ...(notCarried.length ? { notCarried } : {}),
  };
}

/** The credential fields a database app carries in its env (names differ per engine and per image family). */
const DB_ENV: Record<TugraDbEngine, { user?: string[]; password?: string[]; root?: string[]; database?: string[]; defaultUser?: string }> = {
  POSTGRES: { user: ["POSTGRES_USER", "POSTGRESQL_USERNAME"], password: ["POSTGRES_PASSWORD", "POSTGRESQL_PASSWORD"], database: ["POSTGRES_DB", "POSTGRESQL_DATABASE"], defaultUser: "postgres" },
  MYSQL: { user: ["MYSQL_USER"], password: ["MYSQL_PASSWORD"], root: ["MYSQL_ROOT_PASSWORD"], database: ["MYSQL_DATABASE"], defaultUser: "root" },
  MARIADB: { user: ["MARIADB_USER", "MYSQL_USER"], password: ["MARIADB_PASSWORD", "MYSQL_PASSWORD"], root: ["MARIADB_ROOT_PASSWORD", "MYSQL_ROOT_PASSWORD"], database: ["MARIADB_DATABASE", "MYSQL_DATABASE"], defaultUser: "root" },
  MONGO: { user: ["MONGO_INITDB_ROOT_USERNAME", "MONGODB_ROOT_USER"], password: ["MONGO_INITDB_ROOT_PASSWORD", "MONGODB_ROOT_PASSWORD"], database: ["MONGO_INITDB_DATABASE"] },
  REDIS: { password: ["REDIS_PASSWORD"], defaultUser: "default" },
  KEYDB: { password: ["KEYDB_PASSWORD"], defaultUser: "default" },
  DRAGONFLY: { password: ["DRAGONFLY_PASSWORD"], defaultUser: "default" },
  CLICKHOUSE: { user: ["CLICKHOUSE_USER"], password: ["CLICKHOUSE_PASSWORD"], database: ["CLICKHOUSE_DB"], defaultUser: "default" },
  LIBSQL: {},
};

const pick = (env: Map<string, string>, keys?: string[]): string | undefined => {
  for (const k of keys ?? []) {
    const v = str(env.get(k));
    if (v) return v;
  }
  return undefined;
};

/** The names (not the passwords) a database app declares: its user and database. */
function dbIdentity(app: CaproverAppDefinition, engine: TugraDbEngine): { username?: string; database?: string } {
  const spec = DB_ENV[engine];
  const env = new Map(envPairs(app));
  const username = pick(env, spec.user) ?? spec.defaultUser;
  const database = pick(env, spec.database) ?? (engine === "POSTGRES" ? username : undefined);
  return { ...(username ? { username } : {}), ...(database ? { database } : {}) };
}

/** A database app's real credentials from its env, for the apply-time secret path only. Undefined when no password is set. */
export function dbCredentialsFromEnv(app: CaproverAppDefinition): FetchedDbCredentials | undefined {
  const engine = caproverEngine(deployedImage(app));
  if (!engine) return undefined;
  const spec = DB_ENV[engine];
  const env = new Map(envPairs(app));
  const password = pick(env, spec.password);
  const rootPassword = pick(env, spec.root);
  if (!password && !rootPassword) return undefined;
  const { username, database } = dbIdentity(app, engine);
  return { user: username, password, rootPassword, database };
}

export function mapDatabase(app: CaproverAppDefinition, engine: TugraDbEngine): ForeignDb {
  const image = deployedImage(app);
  const published = mapPublishedPorts(app.ports);
  const { username, database } = dbIdentity(app, engine);
  return {
    sourceRef: app.appName,
    name: app.appName,
    engine,
    version: versionFromImage(image),
    image,
    credentials: { ...(username ? { username } : {}), ...(database ? { database } : {}), secretRef: app.appName },
    hostInternal: caproverHost(app.appName),
    externalPort: published[0]?.hostPort,
    volumes: mapVolumes(app, app.appName),
  };
}

/** Boundary-safe check that `value` names the host `token` (not a longer slug that starts with it). */
function containsHost(value: string, token: string): boolean {
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9_-])${esc}($|[^a-z0-9_-])`, "i").test(value);
}

/** The databases an app's env points at (`srv-captain--<db>` in any value), sorted so the derived dependsOn is deterministic. */
function dbLinks(app: CaproverAppDefinition, dbHosts: Map<string, string>): ForeignLink[] {
  const links = new Map<string, ForeignLink>();
  for (const [key, value] of envPairs(app)) {
    for (const [host, ref] of dbHosts) {
      if (!links.has(ref) && containsHost(value, host)) links.set(ref, { kind: "database", ref, envKey: key, internalHost: host });
    }
  }
  return [...links.values()].sort((a, b) => a.ref.localeCompare(b.ref));
}

/** Assemble a {@link ForeignFleet} from the app definitions discover already fetched. */
export function buildCaproverFleet(input: CaproverFleetInput): ForeignFleet {
  const warnings: string[] = [...(input.warnings ?? [])];
  const defs = input.definitions.filter((d) => !!d && typeof d.appName === "string" && d.appName.length > 0);

  const dbDefs = defs.filter(isDatabaseApp);
  const databases = dbDefs.map((d) => mapDatabase(d, caproverEngine(deployedImage(d))!));
  const dbHosts = new Map<string, string>(databases.map((d) => [d.hostInternal ?? d.sourceRef, d.sourceRef]));

  // An app with nothing to deploy (no repository and no deployed image) was created but never deployed.
  const appDefs = defs.filter((d) => !isDatabaseApp(d));
  const deployable = appDefs.filter((d) => !!repoUrl(d.appPushWebhook?.repoInfo?.repo) || !!deployedImage(d));
  const neverDeployed = appDefs.length - deployable.length;
  if (neverDeployed > 0) warnings.push(`${neverDeployed} app(s) were never deployed on CapRover (no image and no repository) and are not imported`);

  const apps = deployable.map((d) => {
    const fa = mapApplication(d);
    const links = dbLinks(d, dbHosts);
    if (links.length) fa.links = links;
    return fa;
  });

  const localOnly = apps.filter((a) => a.kind === "image" && a.imageOrigin === "local").length;
  if (localOnly > 0) warnings.push(`${localOnly} app(s) run an image built on the CapRover server (no repository, not in a registry); the image has to be shipped to Tugra or the app rebuilt from its source`);
  const scaledPersistent = deployable.filter((d) => d.hasPersistentData === true && (d.instanceCount ?? 1) > 1).length;
  if (scaledPersistent > 0) warnings.push(`${scaledPersistent} app(s) keep persistent data and run several instances; they are imported with one replica`);
  const exposedDb = dbDefs.filter((d) => (d.customDomain ?? []).some((c) => nonEmpty(c?.publicDomain))).length;
  if (exposedDb > 0) warnings.push(`${exposedDb} database(s) have a public domain on CapRover; domains are not carried for databases`);
  const stopped = deployable.filter((d) => d.instanceCount === 0).length;
  if (stopped > 0) warnings.push(`${stopped} app(s) are scaled to 0 on CapRover; they are imported without a replica count`);

  return { servers: [], apps, databases, services: [], volumes: [], sharedEnv: [], gitProviders: [], warnings };
}
