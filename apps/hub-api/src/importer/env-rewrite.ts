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
}

export interface AppRemapTarget {
  itemRef: string; // app:<server>:<uuid>
  name: string;
  oldHost: string; // source app uuid
  newHost: string; // tugra_<appId>
}

export interface RemapContext {
  dbs: DbRemapTarget[];
  apps: AppRemapTarget[];
}

export type RemapRule = "url" | "host" | "host-port" | "user" | "database" | "password" | "port";

export interface RemapChange {
  key: string;
  rule: RemapRule;
  target: { itemRef: string; kind: "database" | "app"; name: string };
  oldMasked: string;
  newMasked: string;
  confidence: "exact" | "derived";
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
}

// needsManual reasons (stable):
export const RM_PASSWORD_UNKNOWN = "password-unknown"; // a rotate split *_PASSWORD whose old value we can't confirm
export const RM_UNCONFIRMED_CRED = "unconfirmed-credential"; // a rotate split *_USER/*_DATABASE we can't confirm
export const RM_AMBIGUOUS = "ambiguous-target"; // a split var could belong to >1 referenced DB with differing outcomes
export const RM_APP_LINK_REVIEW = "app-link-review"; // an inter-app URL — correct but network-dependent, review first
export const RM_CONTAINS_TOKEN = "contains-old-token"; // a known uuid appears as a non-boundary substring; too risky to edit
export const RM_UNSUPPORTED_ENGINE = "unsupported-engine"; // the matched DB's engine has no connection form we rewrite
export const RM_QUERY_CREDS = "credentials-in-query"; // a connection URL carries credentials in the query (rotate would half-rewrite)

/** A Coolify resource uuid: ~16-40 chars of [a-z0-9]. Required before matching a bare token as a host. */
const UUID_RE = /^[a-z0-9]{16,40}$/i;

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

/** The pure remapper. See the module comment for the safety contract. */
export function remapEnv(env: Record<string, string>, ctx: RemapContext): RemapResult {
  const changes: RemapChange[] = [];
  const unchanged: string[] = [];
  const needsManual: RemapNeedsManual[] = [];
  const dbByHost = new Map(ctx.dbs.map((d) => [d.oldHost, d]));
  const appByHost = new Map(ctx.apps.map((a) => [a.oldHost, a]));
  const referencedDbs = new Set<DbRemapTarget>(); // DBs an R1/R2 match in THIS env pointed at (gates R3)
  const companionKeys: string[] = [];
  const dbRef = (d: DbRemapTarget) => ({ itemRef: d.itemRef, kind: "database" as const, name: d.name });

  const embeddedTarget = (value: string): string | undefined => {
    for (const [tok, d] of dbByHost) if (value.includes(tok)) return d.itemRef;
    for (const [tok, a] of appByHost) if (value.includes(tok)) return a.itemRef;
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
        if (!KNOWN_ENGINE(db.engine)) {
          needsManual.push({ key, reason: RM_UNSUPPORTED_ENGINE, target: db.itemRef });
        } else if (db.mode === "rotate" && hasQueryCred(auth.rest)) {
          // rotating the userinfo but leaving an old password/user in the query is a half-rewrite → report.
          needsManual.push({ key, reason: RM_QUERY_CREDS, target: db.itemRef });
        } else {
          changes.push({
            key,
            rule: "url",
            target: dbRef(db),
            oldMasked: maskConnString(value),
            newMasked: maskConnString(rebuildDbUrl(auth, db)),
            confidence: "exact",
          });
          referencedDbs.add(db);
        }
        continue;
      }
      const app = appByHost.get(auth.host);
      if (app) {
        needsManual.push({ key, reason: RM_APP_LINK_REVIEW, target: app.itemRef });
        continue;
      }
      // a URL to something we don't manage: fall through to the embedded-token scan (host may be <uuid>.suffix).
    } else {
      // R2 — the value is exactly an old host token, or <host>:<port>.
      const hostOnly = dbByHost.get(value) ?? appByHost.get(value);
      if (hostOnly && UUID_RE.test(value)) {
        const isDb = "engine" in hostOnly;
        changes.push({
          key,
          rule: "host",
          target: isDb ? dbRef(hostOnly as DbRemapTarget) : { itemRef: hostOnly.itemRef, kind: "app", name: hostOnly.name },
          oldMasked: value,
          newMasked: hostOnly.newHost,
          confidence: "exact",
        });
        if (isDb) referencedDbs.add(hostOnly as DbRemapTarget);
        continue;
      }
      const hp = /^([a-z0-9]{16,40})(?::(\d+))?$/i.exec(value);
      if (hp && hp[2] && dbByHost.has(hp[1])) {
        const db = dbByHost.get(hp[1])!;
        changes.push({ key, rule: "host-port", target: dbRef(db), oldMasked: value, newMasked: `${db.newHost}:${db.newPort}`, confidence: "exact" });
        referencedDbs.add(db);
        continue;
      }
    }

    // Any value (incl. an unmatched URL) that embeds a known token elsewhere → too risky to edit blindly.
    const embedded = embeddedTarget(value);
    if (embedded) {
      needsManual.push({ key, reason: RM_CONTAINS_TOKEN, target: embedded });
      continue;
    }
    companionKeys.push(key);
  }

  // ---- Pass 2: split credential companions (R3) — only for DBs this env actually references ----
  const refDbs = [...referencedDbs];
  for (const key of companionKeys) {
    const value = env[key];
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
      if (d.mode === "rotate") changes.push({ key, rule: kind, target: dbRef(d), oldMasked: value, newMasked: d[newField]!, confidence: "derived" });
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
        changes.push({ key, rule: "password", target: dbRef(confirmed[0]), oldMasked: "***", newMasked: "***", confidence: "derived" });
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
      changes.push({ key, rule: "port", target: dbRef(portMatched[0]), oldMasked: value, newMasked: String(portMatched[0].newPort), confidence: "derived" });
    } else {
      unchanged.push(key);
    }
  }

  return { changes, unchanged, needsManual };
}
