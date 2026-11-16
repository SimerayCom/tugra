/**
 * The PURE env-remap engine (S4d-1). Given one app's env map and a deterministic remap context (the old
 * Coolify internal hostnames paired with the new Tugra connection facts), it proposes which env values to
 * rewrite so a migrated app points at its new Tugra database instead of the old Coolify container.
 *
 * It is PURE and deterministic — no I/O, no clock, no network — so every rule is unit-testable, and the
 * endpoints (a later slice) decrypt the env, call this, and gate the apply behind an operator confirmation.
 * The safety contract:
 *
 *   - Secrets NEVER appear raw in the output. Passwords in the userinfo AND in secret-looking query
 *     parameters are masked; hostnames / usernames / db-names (non-secret) are shown in full so the
 *     operator can review the diff.
 *   - A value is rewritten ONLY when it contains a KNOWN old token (a DB/app uuid the import mapped) that
 *     maps to a KNOWN new value. Nothing is guessed. Anything ambiguous, encoded, substring, or whose
 *     credential we cannot confirm goes to `needsManual` UNCHANGED — never a half-rewritten app (host new
 *     but credentials old, or one of several referenced DBs rewritten to the wrong one).
 *   - Hybrid per-DB: a `preserve` target (the Tugra DB was provisioned with the SAME credentials via
 *     createForImport) only has its HOST (and port) swapped. A `rotate` target gets the whole connection
 *     rewritten to the fresh Tugra credentials; any split credential var it cannot confirm is reported.
 *   - Idempotent + deterministic: the new host is a `tugra_db_*` name, never an old token, so a re-run over
 *     already-rewritten env proposes nothing.
 */

export type RemapMode = "preserve" | "rotate";

export interface DbRemapTarget {
  itemRef: string; // database:<server>:<uuid>
  name: string; // Tugra DB display name
  engine: string; // POSTGRES | MYSQL | ... (uppercase)
  mode: RemapMode;
  oldHost: string; // the Coolify DB container uuid the app env points at
  newHost: string; // tugra_db_<id>
  newPort: number;
  newUser: string; // "tugra"
  newPassword: string;
  newDatabase: string; // slug(name)
  oldUser?: string; // from coolify-map (non-secret); for split-var value matching
  oldDatabase?: string; // from coolify-map (non-secret)
  oldPort?: number;
  oldPassword?: string; // only if known (e.g. derived from this app's own URL); never required
  /** The Tugra server the database runs on (multi-host). With {@link RemapContext.appServerId} it decides whether the
   *  container name `newHost` is reachable at all: `tugra_db_<id>` resolves on its own server only. Absent = unknown. */
  serverId?: string;
  /** PostgreSQL: the Tugra database already serves TLS. A rewritten URL that says sslmode=require needs it (see {@link RemapResult.tlsNeeded}). */
  ssl?: boolean;
}

/**
 * One imported source service (a stopped compose app on Tugra) an app's env may point at. Everything beyond the identity is
 * optional: a caller that supplies only `{itemRef, name, oldHost}` keeps the report-only behaviour.
 */
export interface ServiceRemapTarget {
  itemRef: string;
  name: string;
  /** The source service uuid; a member container is named `<member>-<oldHost>`. */
  oldHost: string;
  /** The Tugra server the service app runs on. */
  serverId?: string;
  /** The private network the import attached a single-member service to, and the DNS alias it answers to there. */
  privateAlias?: { network: string; alias: string };
  /** The service's public hostnames on Tugra. A reference to one follows the DNS flip (no rewrite) unless it carries a `rename`. */
  publicHosts?: Array<{ host: string; rename?: string }>;
}

export interface AppRemapTarget {
  itemRef: string; // app:<server>:<uuid>
  name: string;
  oldHost: string; // source app uuid
  newHost: string; // tugra_<appId>
  /** The Tugra server the app runs on (multi-host). */
  serverId?: string;
  /** Extra network aliases the source gave the app (`api.internal`) and the single DNS label Tugra answers to (`api-internal`). A
   *  dependent's reference to the source name is rewritten to the label when it can reach it. */
  aliases?: Array<{ from: string; to: string }>;
}

export interface RemapContext {
  dbs: DbRemapTarget[];
  apps: AppRemapTarget[];
  /** OPTIONAL gate on which bare values may even be CONSIDERED a host (R2 exact host / host:port). Defaults to
   *  {@link UUID_RE}, so every caller that omits it (Coolify, whose internal hosts are uuid-shaped) behaves
   *  byte-identically. It is ONLY a shape gate: a value is still rewritten solely when it EQUALS a known
   *  `oldHost` from `dbs`/`apps` (exact string equality) — a looser shape never turns an arbitrary word into a
   *  host. The substring guard ({@link RM_CONTAINS_TOKEN}) is shape-independent.
   *  The {@link RM_UNRESOLVED_HOST} detection is NOT driven by it (see {@link flagUnresolvedHosts}). */
  hostShape?: RegExp;
  /** OPTIONAL (Coolify, R21): report a value whose host is a uuid-shaped container name that no plan item owns
   *  ({@link RM_UNRESOLVED_HOST}) instead of leaving a dead host in place. Off by default: a caller that omits it is byte-identical. */
  flagUnresolvedHosts?: boolean;
  /** OPTIONAL: hosts a plan item DOES own but that this pass cannot rewrite (a database that could not be loaded, the app's own
   *  name). They are never reported as unresolved: the caller has its own, more precise handling of them. */
  ownedHosts?: readonly string[];
  /** OPTIONAL: names of plan items that are NOT uuid-shaped (a carried database container is named by its operator: `redis-legacy`).
   *  Such a name is a host as well, but a short readable word may sit in any variable, so a bare value or `host:port` equal to it is
   *  rewritten only under a host-like KEY (anything else is reported as {@link RM_CONTAINS_TOKEN}) and it is found inside a longer value
   *  only as a whole word. A uuid-shaped name needs none of this and is handled as before. */
  readableHosts?: readonly string[];
  /** OPTIONAL (Dokploy): when true, a BARE value that equals a known `oldHost` is rewritten as a host ONLY if its
   *  KEY looks host-like (`DB_HOST`, `*_HOST`, `*_ADDR`, `ENDPOINT`, `SERVER`…). Dokploy internal hosts are
   *  readable slugs, so a non-host var (`APP_NAME`, `COMPOSE_PROJECT_NAME`) could legitimately HOLD that slug and
   *  rewriting it would corrupt the value; when the key is not host-like the value is reported
   *  ({@link RM_CONTAINS_TOKEN}), never edited. Off by default so Coolify (uuid hosts, unambiguous) is unchanged. */
  bareHostKeyGate?: boolean;
  /** OPTIONAL (Coolify): the source's multi-container SERVICES (e.g. MinIO). An env value that points at one of them
   *  (URL host, bare host or host:port equal to the service uuid, or ending `-<uuid>` as a member container's name)
   *  is reported {@link RM_SERVICE_LINK_REVIEW} instead of staying silently `unchanged`. NEVER auto-edited: a service
   *  is not imported as an app, so there is no new host to rewrite to. Callers that omit it are byte-identical. */
  services?: ServiceRemapTarget[];
  /** OPTIONAL (multi-host): the Tugra server THIS app runs on. A database or service on another server cannot be reached by its
   *  container name / private alias, so such a reference is reported {@link RM_CROSS_SERVER} instead of rewritten. */
  appServerId?: string;
  /** OPTIONAL: this app can join a private service network (a classic docker-run app on a plain network). When false (or absent),
   *  a reference to a private-alias service is reported {@link RM_SERVICE_NET} instead of rewritten. */
  appCanJoinNetwork?: boolean;
}

export type RemapRule = "url" | "host" | "host-port" | "user" | "database" | "password" | "port" | "service-host" | "service-public-host" | "app-alias";

export interface RemapChange {
  key: string;
  rule: RemapRule;
  target: { itemRef: string; kind: "database" | "app" | "service"; name: string };
  oldMasked: string;
  newMasked: string;
  /** The RAW new value the apply writer sets. The MASKED pair above is for display; this is secret and MUST
   *  NOT be surfaced in a preview response — the hub projects only the masked fields (see remapEnvPlan). */
  newValue: string;
  confidence: "exact" | "derived";
  /** A `service-host` rewrite: the private network the app must join for the alias to resolve. */
  joinNetwork?: string;
  /** A database URL that says sslmode=require (or prefer-style TLS): the target must serve TLS. */
  tls?: "require";
}

export interface RemapNeedsManual {
  key: string;
  reason: string; // stable enum (below)
  target?: string; // itemRef if a token/DB was recognised
}

export interface RemapResult {
  changes: RemapChange[];
  unchanged: string[];
  needsManual: RemapNeedsManual[];
  /** Key to imported service this app depends on, however the reference was handled. Omitted when the app references no service. */
  serviceLinks?: Array<{ key: string; target: string; via: "internal" | "public" }>;
  /** PostgreSQL databases (itemRefs, sorted) a rewritten URL needs TLS on and that do not serve it yet. Omitted when none. */
  tlsNeeded?: string[];
}

// needsManual reasons (stable):
export const RM_PASSWORD_UNKNOWN = "password-unknown"; // a rotate split *_PASSWORD whose old value we can't confirm
export const RM_UNCONFIRMED_CRED = "unconfirmed-credential"; // a rotate split *_USER/*_DATABASE we can't confirm
export const RM_AMBIGUOUS = "ambiguous-target"; // a split var could belong to >1 referenced DB with differing outcomes
export const RM_APP_LINK_REVIEW = "app-link-review"; // an inter-app URL — correct but network-dependent, review first
export const RM_CONTAINS_TOKEN = "contains-old-token"; // a known uuid appears as a non-boundary substring; too risky to edit
export const RM_SERVICE_LINK_REVIEW = "service-link-review"; // points at an old source service (e.g. MinIO) that is not imported as an app
export const RM_UNSUPPORTED_ENGINE = "unsupported-engine"; // the matched DB's engine has no connection form we rewrite
export const RM_QUERY_CREDS = "credentials-in-query"; // a connection URL carries credentials in the query (rotate would half-rewrite)
export const RM_CROSS_SERVER = "cross-server-target"; // the database/service runs on another Tugra server than this app: its container name / alias does not resolve here
export const RM_TLS_VERIFY = "tls-verify-unsupported"; // sslmode=verify-ca/verify-full: the copy serves a self-signed certificate the client cannot verify
export const RM_SERVICE_NET = "service-network-unsupported"; // a private-alias service this app cannot join (compose, swarm, raw --network)
export const RM_UNRESOLVED_HOST = "unresolved-uuid-host"; // R21: the host is a Coolify uuid-shaped name that no plan item (database, app, service) owns: after the move it resolves to nothing

/** A Coolify resource uuid: ~16-40 chars of [a-z0-9]. Required before matching a bare token as a host. */
const UUID_RE = /^[a-z0-9]{16,40}$/i;
/**
 * R21: a Coolify container host: exactly 24 lower-case letters and digits (a resource uuid), or a service member's name, `<service>-<uuid>`.
 * The member form must carry both letters and digits in its uuid part so an ordinary `name-word` host is never taken for one.
 */
const COOLIFY_HOST_RE = /^[a-z0-9]{24}$/;
const COOLIFY_MEMBER_HOST_RE = /^[a-z][a-z0-9-]*-([a-z0-9]{24})$/;
export function isCoolifyUuidHost(host: string): boolean {
  if (COOLIFY_HOST_RE.test(host)) return true;
  const m = COOLIFY_MEMBER_HOST_RE.exec(host);
  return !!m && /[a-z]/.test(m[1]) && /[0-9]/.test(m[1]);
}
/**
 * A BARE value is judged a host only under a key that names one (a 24-character generated password is common and must be left alone):
 * the key ends in a host word (`DBHOST`, `REDIS_ADDR`) or carries one as a whole `_`-separated word (`DB_HOST_PRIMARY`, `MASTER_NODE`), and no
 * word of it says the value is a secret (`MASTER_KEY`, `NODE_AUTH_TOKEN`, `APP_SERVER_SECRET` hold generated strings, not hosts).
 */
const BARE_HOST_KEY_END = /(?:HOST|HOSTNAME|ADDR|ADDRESS|ENDPOINT)$/i;
const BARE_SECRET_KEY = /(?:^|_)(SECRET|KEY|TOKEN|PASSWORD|PASSWD|PASS|SALT|SIGNATURE|CREDENTIALS?)(?:_|$)/i;
const bareHostKey = (key: string): boolean => !BARE_SECRET_KEY.test(key) && (BARE_HOST_KEY_END.test(key) || HOST_LIKE_KEY.test(key));

/**
 * R21, a bare value: a key whose last word says the value is an identifier, not a host (`NODE_ID`, `MASTER_UUID`), and a value that is 24
 * hexadecimal digits (a database object id, a Mongo ObjectId: a Coolify uuid is base-36 and is all hex only with a chance of about one in a billion)
 * are never an unresolved host, whatever host word the key also carries.
 */
const IDENTIFIER_KEY_END = /(?:^|_)(ID|IDS|UUID|GUID|HASH|SHA|COMMIT|REV|REVISION|VERSION|NUMBER|COUNT|PORT)$/i;
const unresolvedBareKeyOk = (key: string, value: string): boolean => bareHostKey(key) && !IDENTIFIER_KEY_END.test(key) && !/^[0-9a-f]{24}$/.test(value);

/**
 * R21, a value that is not one host: every host an embedded connection string carries whose name is a Coolify uuid. Looked for in the
 * authority of every `//` (a JDBC url `jdbc:postgresql://<uuid>:5432/db`, a multi-host list `mongodb://u:p@<uuid>:27017,<uuid>:27017`), after an `@`
 * (`user:pw@<uuid>:5432`) and as a `host=` / `hostaddr=` pair (a libpq or ADO string), never inside a longer word or a dotted name.
 */
function embeddedUuidHosts(value: string): string[] {
  const found: string[] = [];
  const consider = (hostPort: string): void => {
    const h = /^([^:/?#\s,;'"@]+)(?::\d{1,5})?$/.exec(hostPort);
    if (h && isCoolifyUuidHost(h[1])) found.push(h[1]);
  };
  for (const m of value.matchAll(/:\/\/([^/?#\s'"]*)/g)) {
    const authority = m[1];
    for (const part of authority.slice(authority.lastIndexOf("@") + 1).split(",")) consider(part);
  }
  for (const m of value.matchAll(/@([^:/?#\s,;'"@]+)(?::\d{1,5})?(?=[/?#\s,;'"]|$)/g)) if (isCoolifyUuidHost(m[1])) found.push(m[1]);
  for (const m of value.matchAll(/(?:^|[\s;,])host(?:addr)?=([^\s;,'"]+)/gi)) consider(m[1]);
  return found;
}

/** A var KEY that plausibly holds a host (used only when ctx.bareHostKeyGate is on — i.e. a readable-slug source
 *  like Dokploy — so a name-shaped value in a non-host var is not mistaken for a host). */
const HOST_LIKE_KEY = /(?:^|_)(HOST|HOSTNAME|ADDR|ADDRESS|ENDPOINT|SERVER|NODE|MASTER|PRIMARY|REPLICA|LEADER)(?:_|$)/i;
/** Test a regex without `g`/`y` lastIndex state leaking between calls. */
const shapeTest = (re: RegExp, v: string): boolean => {
  re.lastIndex = 0;
  return re.test(v);
};

/** `word` inside `value` as a whole name: not part of a longer host name or word (`redis` is not in `redis-cache` nor in `myredis`). */
function wholeWord(value: string, word: string): boolean {
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_.-])${esc}(?![A-Za-z0-9_-])`).test(value);
}

const enc = encodeURIComponent;
const REDIS_FAMILY = new Set(["REDIS", "KEYDB", "DRAGONFLY"]);
/** Engines whose connection URL carries a /<database> path we may rewrite (pg/mysql/mariadb). */
const HAS_DB_PATH = (engine: string) => !REDIS_FAMILY.has(engine) && engine !== "MONGO" && engine !== "LIBSQL";
/** Engines we have a connection form for at all (excludes LIBSQL/unknown — reported, never rewritten). */
const KNOWN_ENGINE = (engine: string) => REDIS_FAMILY.has(engine) || engine === "MONGO" || HAS_DB_PATH(engine);

const SECRET_QUERY_KEY = /^(password|passwd|pwd|sslpassword|secret|token|auth|apikey|api_key)$/i;

interface Authority {
  scheme: string;
  userinfo: string; // may be "" (no "@")
  hasUserinfo: boolean;
  host: string;
  port?: string;
  rest: string; // path + query + fragment, verbatim (starts with / ? or # — or "")
}

/** Parse scheme://[userinfo@]host[:port][rest] without the WHATWG URL quirks for non-special schemes.
 *  userinfo is split on the LAST '@' (a host can't contain '@'), so a raw '@' in a password is tolerated.
 *  Returns null when it is not a single-host authority URL (incl. IPv6 / multi-host / empty host). */
function parseAuthorityUrl(value: string): Authority | null {
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)([/?#].*)?$/.exec(value);
  if (!m) return null;
  const scheme = m[1];
  const authority = m[2];
  const rest = m[3] ?? "";
  const at = authority.lastIndexOf("@");
  const hasUserinfo = at >= 0;
  const userinfo = hasUserinfo ? authority.slice(0, at) : "";
  const hostport = hasUserinfo ? authority.slice(at + 1) : authority;
  if (hostport === "" || hostport.includes(",") || hostport.startsWith("[")) return null;
  const hp = /^([^:]+)(?::(\d+))?$/.exec(hostport);
  if (!hp) return null;
  return { scheme, userinfo, hasUserinfo, host: hp[1], port: hp[2], rest };
}

/** Does the query/fragment carry a credential parameter (so a rotate would leave the OLD cred behind)? */
function hasQueryCred(rest: string): boolean {
  const q = rest.indexOf("?") >= 0 ? rest.slice(rest.indexOf("?") + 1) : "";
  for (const pair of q.split(/[&;]/)) {
    const k = pair.split("=")[0];
    if (k && SECRET_QUERY_KEY.test(k)) return true;
  }
  return false;
}

/** Mask a connection URL for display: userinfo password + secret-looking query values -> ***. A colon-less
 *  userinfo is masked whole (it may be a token used as the sole credential). Hostnames stay in full. */
function maskConnString(value: string): string {
  const a = parseAuthorityUrl(value);
  if (!a) return "***"; // defensive: never display a value we can't structurally mask
  let ui = "";
  if (a.hasUserinfo) {
    const c = a.userinfo.indexOf(":");
    ui = (c >= 0 ? a.userinfo.slice(0, c) + ":***" : "***") + "@";
  }
  const restMasked = a.rest.replace(/([?&;])([^=&;#]+)=([^&;#]*)/g, (m0, sep, k) => (SECRET_QUERY_KEY.test(k) ? `${sep}${k}=***` : m0));
  return `${a.scheme}://${ui}${a.host}${a.port ? ":" + a.port : ""}${restMasked}`;
}

/** Rebuild a DB connection URL. preserve -> keep userinfo + path, swap host:port. rotate -> fresh userinfo;
 *  pg/mysql get /<newDatabase> + preserved query; redis/mongo keep the original path (db-index / auth params). */
function rebuildDbUrl(a: Authority, t: DbRemapTarget): string {
  if (t.mode === "preserve") {
    const ui = a.hasUserinfo ? a.userinfo + "@" : "";
    return `${a.scheme}://${ui}${t.newHost}:${t.newPort}${a.rest}`;
  }
  const auth = REDIS_FAMILY.has(t.engine) ? `:${enc(t.newPassword)}@` : `${enc(t.newUser)}:${enc(t.newPassword)}@`;
  if (REDIS_FAMILY.has(t.engine) || t.engine === "MONGO") {
    return `${a.scheme}://${auth}${t.newHost}:${t.newPort}${a.rest}`; // keep path (redis db index / mongo params)
  }
  const query = a.rest.replace(/^[^?#]*/, ""); // keep ?query / #fragment, drop the old db-name path
  return `${a.scheme}://${auth}${t.newHost}:${t.newPort}/${enc(t.newDatabase)}${query}`;
}

type CredKind = "user" | "password" | "database" | "port";
/** Classify a split credential env key. Conservative: a bare `*_NAME` is NOT a database var. */
function credKind(key: string): CredKind | null {
  const k = key.toUpperCase();
  if (/(?:^|_)(?:PASSWORD|PASSWD|PASS|PWD)$/.test(k) || /^(?:PG|MYSQL|MARIADB|MONGO|REDIS)(?:PASSWORD|PASS|PWD)$/.test(k)) return "password";
  if (/(?:^|_)(?:USER|USERNAME)$/.test(k) || /^(?:PG|MYSQL|MARIADB|MONGO|REDIS)(?:USER|USERNAME)$/.test(k)) return "user";
  if (/(?:^|_)(?:DATABASE|DBNAME|DB_NAME)$/.test(k) || /^(?:PG|MYSQL|MARIADB|MONGO)(?:DATABASE|DB)$/.test(k) || /(?:^|_)DB$/.test(k)) return "database";
  if (/(?:^|_)PORT$/.test(k) || /^(?:PG|MYSQL|MARIADB|MONGO|REDIS)PORT$/.test(k)) return "port";
  return null;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Recover the (user, password, database) a connection URL carries FOR a given host. Used by the preview to
 *  decide whether a Tugra DB's current credentials already match the app's old ones (→ preserve, host-swap
 *  only) or differ (→ rotate). Returns null when the value is not a single-host URL pointing at `host`. */
export function credsFromUrlForHost(value: string, host: string): { user?: string; password?: string; database?: string } | null {
  const a = parseAuthorityUrl(value);
  if (!a || a.host !== host) return null;
  let user: string | undefined;
  let password: string | undefined;
  if (a.hasUserinfo) {
    const c = a.userinfo.indexOf(":");
    user = safeDecode(c >= 0 ? a.userinfo.slice(0, c) : a.userinfo);
    if (c >= 0) password = safeDecode(a.userinfo.slice(c + 1));
  }
  const pathDb = /^\/([^/?#]+)/.exec(a.rest);
  const database = pathDb ? safeDecode(pathDb[1]) : undefined;
  return { user, password, database };
}

const TLS_VERIFY_MODES = new Set(["verify-ca", "verify-full"]);

/** The libpq `sslmode` a connection URL's query carries (lower-cased), or undefined. */
export function sslmodeOf(rest: string): string | undefined {
  const q = rest.indexOf("?") >= 0 ? rest.slice(rest.indexOf("?") + 1).split("#")[0] : "";
  for (const pair of q.split(/[&;]/)) {
    const eq = pair.indexOf("=");
    if (eq > 0 && pair.slice(0, eq).toLowerCase() === "sslmode") return safeDecode(pair.slice(eq + 1)).trim().toLowerCase();
  }
  return undefined;
}

const crossServer = (a?: string, b?: string): boolean => !!a && !!b && a !== b;

/** The pure remapper. See the module comment for the safety contract. */
export function remapEnv(env: Record<string, string>, ctx: RemapContext): RemapResult {
  const changes: RemapChange[] = [];
  const unchanged: string[] = [];
  const needsManual: RemapNeedsManual[] = [];
  const hostShape = ctx.hostShape ?? UUID_RE;
  const flagUnresolved = ctx.flagUnresolvedHosts === true;
  const owned = new Set(ctx.ownedHosts ?? []);
  // a readable (non-uuid) plan-item name: it passes the shape gate by name, but only under a host-like key
  const readable = new Set((ctx.readableHosts ?? []).filter((h) => !shapeTest(hostShape, h)));
  const isHostShaped = (h: string): boolean => shapeTest(hostShape, h) || readable.has(h);
  const bareKeyOk = (h: string, key: string): boolean => (ctx.bareHostKeyGate ? HOST_LIKE_KEY.test(key) : readable.has(h) ? bareHostKey(key) : true);
  const portKeyOk = (h: string, key: string): boolean => !readable.has(h) || bareHostKey(key);
  const dbByHost = new Map(ctx.dbs.map((d) => [d.oldHost, d]));
  const appByHost = new Map(ctx.apps.map((a) => [a.oldHost, a]));
  const referencedDbs = new Set<DbRemapTarget>(); // DBs an R1/R2 match in THIS env pointed at (gates R3)
  const companionKeys: string[] = [];
  const dbRef = (d: DbRemapTarget) => ({ itemRef: d.itemRef, kind: "database" as const, name: d.name });

  // Service lookup: a member container is named `<member>-<serviceUuid>`, so a host equal to the uuid or ending
  // `-<uuid>` is the service (and the prefix names the member). The uuid itself must be uuid-shaped (the existing gate) before
  // it is ever matched.
  const services = (ctx.services ?? []).filter((sv) => shapeTest(hostShape, sv.oldHost));
  const serviceHit = (host: string): { sv: ServiceRemapTarget; member: string | undefined } | undefined => {
    for (const sv of services) {
      if (host === sv.oldHost) return { sv, member: undefined };
      if (host.endsWith(`-${sv.oldHost}`)) return { sv, member: host.slice(0, host.length - sv.oldHost.length - 1) };
    }
    return undefined;
  };
  const serviceFor = (host: string): string | undefined => serviceHit(host)?.sv.itemRef;
  const publicHit = (host: string): { sv: ServiceRemapTarget; rename?: string } | undefined => {
    const h = host.toLowerCase();
    for (const sv of ctx.services ?? []) for (const p of sv.publicHosts ?? []) if (p.host.toLowerCase() === h) return { sv, rename: p.rename };
    return undefined;
  };
  const serviceLinks: NonNullable<RemapResult["serviceLinks"]> = [];
  const tlsNeeded = new Set<string>();

  /**
   * A reference to an old source service by its internal host. It is rewritten ONLY to the private alias the import gave the
   * service, and only when this app is on the same server, can join the service's network and the member the host names is the
   * aliased one. Anything else is reported with the reason, never guessed.
   */
  const internalService = (key: string, hit: NonNullable<ReturnType<typeof serviceHit>>, rebuild: (host: string) => string, mask: (v: string) => string, oldValue: string): void => {
    const { sv, member } = hit;
    serviceLinks.push({ key, target: sv.itemRef, via: "internal" });
    const alias = sv.privateAlias;
    if (crossServer(ctx.appServerId, sv.serverId)) needsManual.push({ key, reason: RM_CROSS_SERVER, target: sv.itemRef });
    else if (!alias || member !== alias.alias) needsManual.push({ key, reason: RM_SERVICE_LINK_REVIEW, target: sv.itemRef });
    else if (ctx.appCanJoinNetwork !== true) needsManual.push({ key, reason: RM_SERVICE_NET, target: sv.itemRef });
    else {
      const next = rebuild(alias.alias);
      changes.push({ key, rule: "service-host", target: { itemRef: sv.itemRef, kind: "service", name: sv.name }, oldMasked: mask(oldValue), newMasked: mask(next), newValue: next, confidence: "exact", joinNetwork: alias.network });
    }
  };

  /** A reference to one of an imported service's PUBLIC hostnames: renamed when the operator renamed it, else it follows the DNS flip. */
  const publicService = (key: string, hit: NonNullable<ReturnType<typeof publicHit>>, rebuild: (host: string) => string, mask: (v: string) => string, oldValue: string): void => {
    serviceLinks.push({ key, target: hit.sv.itemRef, via: "public" });
    if (!hit.rename) {
      unchanged.push(key);
      return;
    }
    const next = rebuild(hit.rename);
    changes.push({ key, rule: "service-public-host", target: { itemRef: hit.sv.itemRef, kind: "service", name: hit.sv.name }, oldMasked: mask(oldValue), newMasked: mask(next), newValue: next, confidence: "exact" });
  };

  // Source network aliases of the migrated apps: host (lower-case) to the app and the Tugra label.
  const aliasByHost = new Map<string, { app: AppRemapTarget; to: string }>();
  for (const a of ctx.apps) for (const al of a.aliases ?? []) aliasByHost.set(al.from.toLowerCase(), { app: a, to: al.to });
  /** A reference to a source network alias: rewritten to the Tugra label only for a dependent that shares the alias owner's server
   *  and is a classic app (the label lives on the per-server apps network); otherwise reported with the reason. */
  const aliasRef = (key: string, hit: { app: AppRemapTarget; to: string }, rebuild: (host: string) => string, mask: (v: string) => string, oldValue: string): void => {
    if (crossServer(ctx.appServerId, hit.app.serverId)) needsManual.push({ key, reason: RM_CROSS_SERVER, target: hit.app.itemRef });
    else if (ctx.appCanJoinNetwork !== true) needsManual.push({ key, reason: RM_APP_LINK_REVIEW, target: hit.app.itemRef });
    else {
      const next = rebuild(hit.to);
      changes.push({ key, rule: "app-alias", target: { itemRef: hit.app.itemRef, kind: "app", name: hit.app.name }, oldMasked: mask(oldValue), newMasked: mask(next), newValue: next, confidence: "exact" });
    }
  };

  const embeddedTarget = (value: string): string | undefined => {
    const has = (tok: string): boolean => (readable.has(tok) ? wholeWord(value, tok) : value.includes(tok));
    for (const [tok, d] of dbByHost) if (has(tok)) return d.itemRef;
    for (const [tok, a] of appByHost) if (has(tok)) return a.itemRef;
    return undefined;
  };

  // ---- Pass 1: connection URLs (R1) + exact host tokens (R2) + app links (R4) ----
  for (const [key, value] of Object.entries(env)) {
    if (value === "") {
      unchanged.push(key);
      continue;
    }

    const auth = parseAuthorityUrl(value);
    if (auth) {
      const db = dbByHost.get(auth.host);
      if (db) {
        const sslmode = db.engine === "POSTGRES" ? sslmodeOf(auth.rest) : undefined;
        if (!KNOWN_ENGINE(db.engine)) {
          needsManual.push({ key, reason: RM_UNSUPPORTED_ENGINE, target: db.itemRef });
        } else if (crossServer(ctx.appServerId, db.serverId)) {
          // `tugra_db_<id>` only resolves on the database's own server: a rewrite would point the app at a name it can never reach
          needsManual.push({ key, reason: RM_CROSS_SERVER, target: db.itemRef });
        } else if (sslmode && TLS_VERIFY_MODES.has(sslmode)) {
          // the copy serves a self-signed certificate: a client that verifies the chain would refuse it
          needsManual.push({ key, reason: RM_TLS_VERIFY, target: db.itemRef });
        } else if (db.mode === "rotate" && hasQueryCred(auth.rest)) {
          // rotating the userinfo but leaving an old password/user in the query is a half-rewrite → report.
          needsManual.push({ key, reason: RM_QUERY_CREDS, target: db.itemRef });
        } else {
          const rebuilt = rebuildDbUrl(auth, db);
          const needsTls = sslmode === "require";
          changes.push({
            key,
            rule: "url",
            target: dbRef(db),
            oldMasked: maskConnString(value),
            newMasked: maskConnString(rebuilt),
            newValue: rebuilt,
            confidence: "exact",
            ...(needsTls ? { tls: "require" as const } : {}),
          });
          if (needsTls && db.ssl !== true) tlsNeeded.add(db.itemRef);
          referencedDbs.add(db);
        }
        continue;
      }
      const app = appByHost.get(auth.host);
      if (app) {
        needsManual.push({ key, reason: RM_APP_LINK_REVIEW, target: app.itemRef });
        continue;
      }
      const aliasHit = aliasByHost.get(auth.host.toLowerCase());
      if (aliasHit) {
        aliasRef(key, aliasHit, (h) => `${auth.scheme}://${auth.hasUserinfo ? `${auth.userinfo}@` : ""}${h}${auth.port ? `:${auth.port}` : ""}${auth.rest}`, maskConnString, value);
        continue;
      }
      const hit = serviceHit(auth.host);
      if (hit) {
        internalService(key, hit, (h) => `${auth.scheme}://${auth.hasUserinfo ? `${auth.userinfo}@` : ""}${h}${auth.port ? `:${auth.port}` : ""}${auth.rest}`, maskConnString, value);
        continue;
      }
      const pub = publicHit(auth.host);
      if (pub) {
        publicService(key, pub, (h) => `${auth.scheme}://${auth.hasUserinfo ? `${auth.userinfo}@` : ""}${h}${auth.port ? `:${auth.port}` : ""}${auth.rest}`, maskConnString, value);
        continue;
      }
      if (flagUnresolved && isCoolifyUuidHost(auth.host) && !owned.has(auth.host)) {
        needsManual.push({ key, reason: RM_UNRESOLVED_HOST });
        continue;
      }
      // a URL to something we don't manage: fall through to the embedded-token scan (host may be <uuid>.suffix).
    } else {
      // R2 — the value is exactly an old host token, or <host>:<port>.
      const hostOnly = dbByHost.get(value) ?? appByHost.get(value);
      // bareHostKeyGate (Dokploy): a readable slug could be a non-host var's value — only treat a bare host-equal
      // value as a host when the KEY looks host-like; otherwise fall through to the RM_CONTAINS_TOKEN report.
      if (hostOnly && isHostShaped(value) && bareKeyOk(value, key)) {
        const isDb = "engine" in hostOnly;
        if (isDb && crossServer(ctx.appServerId, (hostOnly as DbRemapTarget).serverId)) {
          needsManual.push({ key, reason: RM_CROSS_SERVER, target: hostOnly.itemRef });
          continue;
        }
        changes.push({
          key,
          rule: "host",
          target: isDb ? dbRef(hostOnly as DbRemapTarget) : { itemRef: hostOnly.itemRef, kind: "app", name: hostOnly.name },
          oldMasked: value,
          newMasked: hostOnly.newHost,
          newValue: hostOnly.newHost,
          confidence: "exact",
        });
        if (isDb) referencedDbs.add(hostOnly as DbRemapTarget);
        continue;
      }
      const hp = /^([^:]+):(\d+)$/.exec(value); // <host>:<port>; the host must pass the shape gate AND equal a known oldHost
      if (hp && isHostShaped(hp[1]) && dbByHost.has(hp[1]) && portKeyOk(hp[1], key)) {
        const db = dbByHost.get(hp[1])!;
        if (crossServer(ctx.appServerId, db.serverId)) {
          needsManual.push({ key, reason: RM_CROSS_SERVER, target: db.itemRef });
          continue;
        }
        changes.push({ key, rule: "host-port", target: dbRef(db), oldMasked: value, newMasked: `${db.newHost}:${db.newPort}`, newValue: `${db.newHost}:${db.newPort}`, confidence: "exact" });
        referencedDbs.add(db);
        continue;
      }
      const bareAlias = aliasByHost.get((hp ? hp[1] : value).toLowerCase());
      if (bareAlias) {
        const port = hp ? `:${hp[2]}` : "";
        aliasRef(key, bareAlias, (h) => `${h}${port}`, (v) => v, value);
        continue;
      }
      const bareHit = services.length ? serviceHit(hp ? hp[1] : value) : undefined; // bare host or host:port of an old service
      if (bareHit) {
        const port = hp ? `:${hp[2]}` : "";
        internalService(key, bareHit, (h) => `${h}${port}`, (v) => v, value);
        continue;
      }
      const barePub = publicHit(hp ? hp[1] : value);
      if (barePub) {
        const port = hp ? `:${hp[2]}` : "";
        publicService(key, barePub, (h) => `${h}${port}`, (v) => v, value);
        continue;
      }
      // R21: `<uuid>` under a host-like key, or `<uuid>:<port>` under any key, that nothing above recognised
      if (flagUnresolved && (hp ? isCoolifyUuidHost(hp[1]) && !owned.has(hp[1]) : isCoolifyUuidHost(value) && !owned.has(value) && unresolvedBareKeyOk(key, value))) {
        needsManual.push({ key, reason: RM_UNRESOLVED_HOST });
        continue;
      }
    }

    // Any value (incl. an unmatched URL) that embeds a known token elsewhere → too risky to edit blindly.
    const embedded = embeddedTarget(value);
    if (embedded) {
      needsManual.push({ key, reason: RM_CONTAINS_TOKEN, target: embedded });
      continue;
    }
    // R21: a connection string with more than one host, a JDBC url or a key=value string that carries a dead uuid host
    if (flagUnresolved && embeddedUuidHosts(value).some((h) => !owned.has(h))) {
      needsManual.push({ key, reason: RM_UNRESOLVED_HOST });
      continue;
    }
    companionKeys.push(key);
  }

  // ---- Pass 2: split credential companions (R3) — only for DBs this env actually references ----
  const refDbs = [...referencedDbs];
  for (const key of companionKeys) {
    const value = env[key];
    // PGSSLMODE is libpq's own switch: it governs every PostgreSQL URL of this app that has no sslmode of its own.
    if (key.toUpperCase() === "PGSSLMODE" && refDbs.some((d) => d.engine === "POSTGRES")) {
      const mode = value.trim().toLowerCase();
      const pgs = refDbs.filter((d) => d.engine === "POSTGRES");
      if (TLS_VERIFY_MODES.has(mode)) needsManual.push({ key, reason: RM_TLS_VERIFY, target: pgs[0].itemRef });
      else {
        if (mode === "require") for (const d of pgs) if (d.ssl !== true) tlsNeeded.add(d.itemRef);
        unchanged.push(key);
      }
      continue;
    }
    const kind = credKind(key);
    if (!kind || refDbs.length === 0) {
      unchanged.push(key);
      continue;
    }

    if (kind === "user" || kind === "database") {
      const field = kind === "user" ? "oldUser" : "oldDatabase";
      const newField = kind === "user" ? "newUser" : "newDatabase";
      const matched = refDbs.filter((d) => d[field] !== undefined && value === d[field]);
      if (matched.length === 0) {
        // Unrelated — unless there is exactly one rotate DB whose old value is UNKNOWN AND the engine actually
        // HAS this field (so a stale split var would really break it). Redis-family has no user/db-name, and
        // only pg/mysql/mariadb carry a db-NAME, so a REDIS_DB / REDIS_USER is left unchanged, not flagged.
        const only = refDbs.length === 1 ? refDbs[0] : undefined;
        const engineHasField = only ? (kind === "user" ? !REDIS_FAMILY.has(only.engine) : HAS_DB_PATH(only.engine)) : false;
        if (only && only.mode === "rotate" && only[field] === undefined && engineHasField) {
          needsManual.push({ key, reason: RM_UNCONFIRMED_CRED, target: only.itemRef });
        } else {
          unchanged.push(key);
        }
        continue;
      }
      const outcomes = new Set(matched.map((d) => (d.mode === "rotate" ? d[newField] : "\x00keep")));
      if (matched.length > 1 && outcomes.size > 1) {
        needsManual.push({ key, reason: RM_AMBIGUOUS, target: matched[0].itemRef });
        continue;
      }
      const d = matched[0];
      if (d.mode === "rotate") changes.push({ key, rule: kind, target: dbRef(d), oldMasked: value, newMasked: d[newField]!, newValue: d[newField]!, confidence: "derived" });
      else unchanged.push(key);
      continue;
    }

    if (kind === "password") {
      if (refDbs.every((d) => d.mode === "preserve")) {
        unchanged.push(key); // all preserve → the password stays, whichever DB it belongs to
        continue;
      }
      const confirmed = refDbs.filter((d) => d.mode === "rotate" && d.oldPassword !== undefined && value === d.oldPassword);
      if (confirmed.length === 1) {
        changes.push({ key, rule: "password", target: dbRef(confirmed[0]), oldMasked: "***", newMasked: "***", newValue: confirmed[0].newPassword, confidence: "derived" });
      } else {
        // a rotate DB is referenced but we can't confirm which password this is → never guess.
        const rotate = refDbs.find((d) => d.mode === "rotate")!;
        needsManual.push({ key, reason: refDbs.length > 1 ? RM_AMBIGUOUS : RM_PASSWORD_UNKNOWN, target: rotate.itemRef });
      }
      continue;
    }

    // kind === "port": rewrite only when the value is a known old port AND the new port differs.
    const portMatched = refDbs.filter((d) => d.oldPort !== undefined && value === String(d.oldPort) && d.newPort !== d.oldPort);
    if (portMatched.length === 1) {
      changes.push({ key, rule: "port", target: dbRef(portMatched[0]), oldMasked: value, newMasked: String(portMatched[0].newPort), newValue: String(portMatched[0].newPort), confidence: "derived" });
    } else {
      unchanged.push(key);
    }
  }

  return {
    changes,
    unchanged,
    needsManual,
    ...(serviceLinks.length ? { serviceLinks } : {}),
    ...(tlsNeeded.size ? { tlsNeeded: [...tlsNeeded].sort() } : {}),
  };
}
