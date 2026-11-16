import {
  remapEnv,
  RemapContext,
  DbRemapTarget,
  RM_APP_LINK_REVIEW,
  RM_CONTAINS_TOKEN,
  RM_PASSWORD_UNKNOWN,
  RM_QUERY_CREDS,
  RM_AMBIGUOUS,
  RM_UNCONFIRMED_CRED,
  RM_SERVICE_LINK_REVIEW,
  RM_UNRESOLVED_HOST,
  isCoolifyUuidHost,
} from "./env-rewrite";

const UUID = "3f1a9c0b2d4e6f8a1b3c5d7e"; // 24 hex-ish, matches UUID_RE
const APPUUID = "aabbccddeeff00112233aabb";

function pgTarget(mode: "preserve" | "rotate", extra: Partial<DbRemapTarget> = {}): DbRemapTarget {
  return {
    itemRef: `database:_:${UUID}`,
    name: "appdb",
    engine: "POSTGRES",
    mode,
    oldHost: UUID,
    newHost: "tugra_db_abc123",
    newPort: 5432,
    newUser: "tugra",
    newPassword: "NEWpw",
    newDatabase: "appdb",
    oldUser: "appuser",
    oldDatabase: "appdb",
    oldPort: 5432,
    ...extra,
  };
}

const ctx = (dbs: DbRemapTarget[], apps: RemapContext["apps"] = []): RemapContext => ({ dbs, apps });

describe("remapEnv", () => {
  it("R1 rotate: rewrites a DATABASE_URL end-to-end to the fresh Tugra creds", () => {
    const r = remapEnv({ DATABASE_URL: `postgres://appuser:S3cr3t@${UUID}:5432/appdb` }, ctx([pgTarget("rotate")]));
    expect(r.changes).toHaveLength(1);
    const c = r.changes[0];
    expect(c.rule).toBe("url");
    expect(c.newMasked).toBe("postgres://tugra:***@tugra_db_abc123:5432/appdb");
    // the DISPLAY fields never leak a password (old or new) — the preview surfaces only these.
    expect(c.oldMasked).not.toContain("S3cr3t");
    expect(c.newMasked).not.toContain("NEWpw");
    // the RAW write value carries the fresh creds (consumed by the apply; the preview strips newValue).
    expect(c.newValue).toBe("postgres://tugra:NEWpw@tugra_db_abc123:5432/appdb");
  });

  it("R1 preserve: swaps ONLY the host, keeps the original userinfo + db-name", () => {
    const r = remapEnv({ DATABASE_URL: `postgres://appuser:S3cr3t@${UUID}:5432/appdb` }, ctx([pgTarget("preserve")]));
    expect(r.changes[0].newMasked).toBe("postgres://appuser:***@tugra_db_abc123:5432/appdb");
  });

  it("R1 preserve tolerates a raw '@' in the password (splits on the LAST @)", () => {
    const r = remapEnv({ DATABASE_URL: `postgres://appuser:p@ss@${UUID}:5432/appdb` }, ctx([pgTarget("preserve")]));
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0].newMasked).toContain("@tugra_db_abc123:5432/appdb");
  });

  it("R1 redis: password-only URL, rotate", () => {
    const redis = pgTarget("rotate", { engine: "REDIS", newPort: 6379, name: "cache", oldUser: undefined, oldDatabase: undefined });
    const r = remapEnv({ REDIS_URL: `redis://:oldpass@${UUID}:6379` }, ctx([redis]));
    expect(r.changes[0].newMasked).toBe("redis://:***@tugra_db_abc123:6379");
  });

  it("R1 preserves the query string (e.g. sslmode) on rotate", () => {
    const r = remapEnv({ DATABASE_URL: `postgres://u:p@${UUID}:5432/appdb?sslmode=require` }, ctx([pgTarget("rotate")]));
    expect(r.changes[0].newMasked).toContain("?sslmode=require");
  });

  it("R2: an exact host token and a host:port", () => {
    const r = remapEnv({ DB_HOST: UUID, PGHOSTPORT: `${UUID}:5432` }, ctx([pgTarget("rotate")]));
    const byKey = Object.fromEntries(r.changes.map((c) => [c.key, c]));
    expect(byKey.DB_HOST.rule).toBe("host");
    expect(byKey.DB_HOST.newMasked).toBe("tugra_db_abc123");
    expect(byKey.PGHOSTPORT.rule).toBe("host-port");
    expect(byKey.PGHOSTPORT.newMasked).toBe("tugra_db_abc123:5432");
  });

  it("R3 rotate: split companions rewrite only when the value matches the known old value AND the DB is referenced", () => {
    const r = remapEnv(
      { DB_HOST: UUID, DB_USER: "appuser", DB_NAME: "appdb", DB_PASSWORD: "S3cr3t" },
      ctx([pgTarget("rotate", { oldPassword: "S3cr3t" })]),
    );
    const byKey = Object.fromEntries(r.changes.map((c) => [c.key, c]));
    expect(byKey.DB_USER.newMasked).toBe("tugra");
    expect(byKey.DB_NAME.newMasked).toBe("appdb");
    expect(byKey.DB_PASSWORD.rule).toBe("password");
    expect(byKey.DB_PASSWORD.oldMasked).toBe("***");
    expect(JSON.stringify(r)).not.toContain("S3cr3t");
  });

  it("R3 rotate: a *_PASSWORD whose old value we cannot confirm is needsManual, never guessed", () => {
    const r = remapEnv({ DB_HOST: UUID, DB_PASSWORD: "whoknows" }, ctx([pgTarget("rotate")])); // no oldPassword supplied
    expect(r.changes.find((c) => c.key === "DB_PASSWORD")).toBeUndefined();
    expect(r.needsManual).toContainEqual(expect.objectContaining({ key: "DB_PASSWORD", reason: RM_PASSWORD_UNKNOWN }));
  });

  it("R3 preserve: companions are left UNCHANGED (the Tugra DB kept the creds)", () => {
    const r = remapEnv(
      { DB_HOST: UUID, DB_USER: "appuser", DB_PASSWORD: "S3cr3t" },
      ctx([pgTarget("preserve")]),
    );
    expect(r.changes.map((c) => c.key)).toEqual(["DB_HOST"]); // only the host
    expect(r.unchanged).toEqual(expect.arrayContaining(["DB_USER", "DB_PASSWORD"]));
  });

  it("R3 does NOT touch companions when no host in the env references the DB", () => {
    // DB_USER=appuser but nothing points at the DB host → not a confident companion
    const r = remapEnv({ DB_USER: "appuser", DB_PASSWORD: "S3cr3t" }, ctx([pgTarget("rotate", { oldPassword: "S3cr3t" })]));
    expect(r.changes).toHaveLength(0);
    expect(r.unchanged).toEqual(expect.arrayContaining(["DB_USER", "DB_PASSWORD"]));
  });

  it("R4 inter-app URL is reported for review, never auto-rewritten", () => {
    const r = remapEnv(
      { API_URL: `http://${APPUUID}:3000/v1` },
      ctx([], [{ itemRef: `app:_:${APPUUID}`, name: "api", oldHost: APPUUID, newHost: "tugra_app1" }]),
    );
    expect(r.changes).toHaveLength(0);
    expect(r.needsManual).toContainEqual(expect.objectContaining({ key: "API_URL", reason: RM_APP_LINK_REVIEW }));
  });

  it("R5: a known uuid embedded as a substring is reported, never blindly edited", () => {
    const r = remapEnv({ NOTE: `the db is ${UUID}-primary` }, ctx([pgTarget("rotate")]));
    expect(r.changes).toHaveLength(0);
    expect(r.needsManual).toContainEqual(expect.objectContaining({ key: "NOTE", reason: RM_CONTAINS_TOKEN }));
  });

  it("leaves unrelated values untouched", () => {
    const r = remapEnv({ LOG_LEVEL: "info", OTHER_URL: "https://example.com/x" }, ctx([pgTarget("rotate")]));
    expect(r.changes).toHaveLength(0);
    expect(r.unchanged).toEqual(expect.arrayContaining(["LOG_LEVEL", "OTHER_URL"]));
  });

  it("is idempotent: a second pass over the rewritten env proposes nothing", () => {
    const env = { DATABASE_URL: `postgres://appuser:S3cr3t@${UUID}:5432/appdb` };
    const first = remapEnv(env, ctx([pgTarget("rotate")]));
    // apply the one change, then re-run
    const rewritten = { DATABASE_URL: "postgres://tugra:NEWpw@tugra_db_abc123:5432/appdb" };
    const second = remapEnv(rewritten, ctx([pgTarget("rotate")]));
    expect(first.changes).toHaveLength(1);
    expect(second.changes).toHaveLength(0);
    expect(second.needsManual).toHaveLength(0);
  });

  it("multi-host / srv connection strings are not matched (reported via substring if the token shows)", () => {
    const r = remapEnv({ MONGO_URL: `mongodb://u:p@${UUID}:27017,other:27017/db` }, ctx([pgTarget("rotate", { engine: "MONGO", newPort: 27017 })]));
    // authority has a comma → not parsed as a single host; the token still appears → contains-old-token
    expect(r.changes).toHaveLength(0);
    expect(r.needsManual).toContainEqual(expect.objectContaining({ key: "MONGO_URL", reason: RM_CONTAINS_TOKEN }));
  });

  // ---- review-fix regressions ----

  it("masks a password carried in the QUERY string (preserve) — the DISPLAY never leaks it", () => {
    const r = remapEnv({ DATABASE_URL: `postgres://u:p@${UUID}:5432/db?password=S3cr3tQ&sslmode=require` }, ctx([pgTarget("preserve")]));
    const c = r.changes[0];
    expect(c.oldMasked).not.toContain("S3cr3tQ");
    expect(c.newMasked).not.toContain("S3cr3tQ");
    expect(c.newMasked).toContain("password=***");
    expect(c.newMasked).toContain("sslmode=require"); // non-secret query kept
    // preserve keeps the app's OWN query creds verbatim in the RAW write value (that is the point of preserve).
    expect(c.newValue).toContain("password=S3cr3tQ");
  });

  it("masks a userinfo-LESS URL's query password too (DISPLAY only)", () => {
    const r = remapEnv({ DATABASE_URL: `postgres://${UUID}:5432/db?password=S3cr3tQ` }, ctx([pgTarget("preserve")]));
    expect(r.changes[0].oldMasked).not.toContain("S3cr3tQ");
    expect(r.changes[0].newMasked).not.toContain("S3cr3tQ");
  });

  it("rotate + credentials in the query → needsManual, never a half-rewrite", () => {
    const r = remapEnv({ DATABASE_URL: `postgres://u:p@${UUID}:5432/db?password=S3cr3tQ` }, ctx([pgTarget("rotate")]));
    expect(r.changes).toHaveLength(0);
    expect(r.needsManual).toContainEqual(expect.objectContaining({ key: "DATABASE_URL", reason: RM_QUERY_CREDS }));
    expect(JSON.stringify(r)).not.toContain("S3cr3tQ");
  });

  it("matches underscore-less PG*/MYSQL* split keys (PGUSER/PGPASSWORD)", () => {
    const r = remapEnv(
      { DB_HOST: UUID, PGUSER: "appuser", PGPASSWORD: "S3cr3t", MYSQL_DATABASE: "appdb" },
      ctx([pgTarget("rotate", { oldPassword: "S3cr3t" })]),
    );
    const byKey = Object.fromEntries(r.changes.map((c) => [c.key, c]));
    expect(byKey.PGUSER.newMasked).toBe("tugra");
    expect(byKey.PGPASSWORD.rule).toBe("password");
    expect(byKey.MYSQL_DATABASE.newMasked).toBe("appdb");
  });

  it("rotate keeps the Redis db-index path", () => {
    const redis = pgTarget("rotate", { engine: "REDIS", newPort: 6379, oldUser: undefined, oldDatabase: undefined });
    const r = remapEnv({ REDIS_URL: `redis://:old@${UUID}:6379/2` }, ctx([redis]));
    expect(r.changes[0].newMasked).toBe("redis://:***@tugra_db_abc123:6379/2");
  });

  it("ambiguous split var across two referenced DBs with DIFFERING outcomes → needsManual", () => {
    const UUID2 = "aaaa1111bbbb2222cccc3333";
    const db1 = pgTarget("rotate", { oldUser: "shared" });
    const db2 = pgTarget("preserve", { itemRef: `database:_:${UUID2}`, oldHost: UUID2, newHost: "tugra_db_xyz", oldUser: "shared" });
    const r = remapEnv({ DB1_HOST: UUID, DB2_HOST: UUID2, DB_USER: "shared" }, ctx([db1, db2]));
    expect(r.changes.find((c) => c.key === "DB_USER")).toBeUndefined();
    expect(r.needsManual).toContainEqual(expect.objectContaining({ key: "DB_USER", reason: RM_AMBIGUOUS }));
  });

  it("rotate with an UNKNOWN old username → the split USER var is needsManual, not silently left", () => {
    const r = remapEnv({ DB_HOST: UUID, DB_USER: "whoeveritwas" }, ctx([pgTarget("rotate", { oldUser: undefined })]));
    expect(r.changes.find((c) => c.key === "DB_USER")).toBeUndefined();
    expect(r.needsManual).toContainEqual(expect.objectContaining({ key: "DB_USER", reason: RM_UNCONFIRMED_CRED }));
  });

  it("preserve-DB-first + rotate-DB-second: the rotate DB's password is NOT silently left unchanged", () => {
    const UUID2 = "aaaa1111bbbb2222cccc3333";
    const preserveDb = pgTarget("preserve");
    const rotateDb = pgTarget("rotate", { itemRef: `database:_:${UUID2}`, oldHost: UUID2, newHost: "tugra_db_xyz" });
    const r = remapEnv({ A_HOST: UUID, B_HOST: UUID2, DB_PASSWORD: "whoknows" }, ctx([preserveDb, rotateDb]));
    // a rotate DB is referenced → the shared password cannot be safely left; it must be reported
    expect(r.changes.find((c) => c.key === "DB_PASSWORD")).toBeUndefined();
    expect(r.unchanged).not.toContain("DB_PASSWORD");
    expect(r.needsManual).toContainEqual(expect.objectContaining({ key: "DB_PASSWORD" }));
  });

  it("does NOT flag a redis *_DB index as a database companion (redis has no db-name)", () => {
    const redis = pgTarget("rotate", { engine: "REDIS", newPort: 6379, oldUser: undefined, oldDatabase: undefined });
    const r = remapEnv({ REDIS_URL: `redis://:p@${UUID}:6379`, REDIS_DB: "0" }, ctx([redis]));
    expect(r.changes.find((c) => c.key === "REDIS_DB")).toBeUndefined();
    expect(r.needsManual.find((n) => n.key === "REDIS_DB")).toBeUndefined();
    expect(r.unchanged).toContain("REDIS_DB");
  });

  it("rewrites a stale DB_PORT companion only when the new port differs", () => {
    const r = remapEnv({ DB_HOST: UUID, DB_PORT: "5432" }, ctx([pgTarget("rotate", { oldPort: 5432, newPort: 5433 })]));
    const port = r.changes.find((c) => c.key === "DB_PORT");
    expect(port?.rule).toBe("port");
    expect(port?.newMasked).toBe("5433");
    // same-port case: no change
    const r2 = remapEnv({ DB_HOST: UUID, DB_PORT: "5432" }, ctx([pgTarget("rotate", { oldPort: 5432, newPort: 5432 })]));
    expect(r2.changes.find((c) => c.key === "DB_PORT")).toBeUndefined();
  });
});

// ---- L3: the host-shape gate (Dokploy appName hosts) ------------------------------------------------------
const DOKPLOY_SHAPE = /^[a-z0-9][a-z0-9_-]{5,62}$/i; // mirrors DOKPLOY_HOST_SHAPE in import-executor.service
const DK_HOST = "diesdigital-db-58tvyg";
const dkMysql = (mode: "preserve" | "rotate", extra: Partial<DbRemapTarget> = {}): DbRemapTarget => ({
  itemRef: `database:_:${DK_HOST}`,
  name: "diesdb",
  engine: "MYSQL",
  mode,
  oldHost: DK_HOST,
  newHost: "tugra_db_dk1",
  newPort: 3306,
  newUser: "tugra",
  newPassword: "NEWpw",
  newDatabase: "diesdb",
  oldUser: "dies",
  oldDatabase: "dies",
  oldPort: 3306,
  ...extra,
});
const dkCtx = (dbs: DbRemapTarget[], apps: RemapContext["apps"] = []): RemapContext => ({ dbs, apps, hostShape: DOKPLOY_SHAPE, bareHostKeyGate: true });

describe("remapEnv hostShape (L3)", () => {
  it("COOLIFY byte-identical: hostShape unset == explicit uuid shape, for a mixed uuid env", () => {
    const env = {
      DATABASE_URL: `postgres://appuser:S3cr3t@${UUID}:5432/appdb`,
      DB_HOST: UUID,
      PGHOSTPORT: `${UUID}:5432`,
      DB_USER: "appuser",
      DB_NAME: "appdb",
      DB_PASSWORD: "S3cr3t",
      NOTE: `the db is ${UUID}-primary`,
      LOG_LEVEL: "info",
    };
    const dbs = () => [pgTarget("rotate", { oldPassword: "S3cr3t" })];
    const base = remapEnv(env, { dbs: dbs(), apps: [] });
    const explicit = remapEnv(env, { dbs: dbs(), apps: [], hostShape: /^[a-z0-9]{16,40}$/i });
    expect(explicit).toEqual(base);
    expect(base.changes.map((c) => `${c.key}:${c.rule}`).sort()).toEqual(
      ["DATABASE_URL:url", "DB_HOST:host", "DB_NAME:database", "DB_PASSWORD:password", "DB_USER:user", "PGHOSTPORT:host-port"].sort(),
    );
    expect(base.needsManual).toEqual([{ key: "NOTE", reason: RM_CONTAINS_TOKEN, target: `database:_:${UUID}` }]);
  });

  it("with the DEFAULT shape a hyphenated host is NOT a bare-host match (Coolify path never recognises it)", () => {
    const r = remapEnv({ DB_HOST: DK_HOST }, { dbs: [dkMysql("preserve")], apps: [] });
    expect(r.changes).toHaveLength(0);
    // (an exact-equal value still trips the substring guard, so it is REPORTED, never silently dropped)
    expect(r.needsManual).toContainEqual(expect.objectContaining({ key: "DB_HOST", reason: RM_CONTAINS_TOKEN }));
  });

  it("DOKPLOY split vars: DB_HOST=<appName> is rewritten; DB_PORT/DB_USER/DB_NAME/DB_PASSWORD follow the same R3 rules (rotate)", () => {
    const r = remapEnv(
      { DB_HOST: DK_HOST, DB_PORT: "3307", DB_USER: "dies", DB_NAME: "dies", DB_PASSWORD: "S3cr3t" },
      dkCtx([dkMysql("rotate", { oldPassword: "S3cr3t", oldPort: 3307 })]),
    );
    const byKey = Object.fromEntries(r.changes.map((c) => [c.key, c]));
    expect(byKey.DB_HOST).toMatchObject({ rule: "host", newValue: "tugra_db_dk1" });
    expect(byKey.DB_PORT).toMatchObject({ rule: "port", newValue: "3306" });
    expect(byKey.DB_USER).toMatchObject({ rule: "user", newValue: "tugra" });
    expect(byKey.DB_NAME).toMatchObject({ rule: "database", newValue: "diesdb" });
    expect(byKey.DB_PASSWORD).toMatchObject({ rule: "password", newValue: "NEWpw" });
    expect(JSON.stringify(r.changes.map((c) => [c.oldMasked, c.newMasked]))).not.toContain("S3cr3t");
  });

  it("bareHostKeyGate: a non-host var whose value equals an appName is REPORTED (not rewritten); a host-like key IS rewritten", () => {
    const r = remapEnv({ DB_HOST: DK_HOST, APP_NAME: DK_HOST, COMPOSE_PROJECT_NAME: DK_HOST }, dkCtx([dkMysql("preserve")]));
    const byKey = Object.fromEntries(r.changes.map((c) => [c.key, c]));
    expect(byKey.DB_HOST).toMatchObject({ rule: "host", newValue: "tugra_db_dk1" }); // host-like key → rewritten
    expect(r.changes.some((c) => c.key === "APP_NAME" || c.key === "COMPOSE_PROJECT_NAME")).toBe(false); // readable slug in a non-host var → NOT corrupted
    expect(r.needsManual).toContainEqual(expect.objectContaining({ key: "APP_NAME", reason: RM_CONTAINS_TOKEN }));
    expect(r.needsManual).toContainEqual(expect.objectContaining({ key: "COMPOSE_PROJECT_NAME", reason: RM_CONTAINS_TOKEN }));
  });

  it("host:port under the DEFAULT shape rejects a hyphenated host (no host-port rewrite; reported, never silently dropped)", () => {
    const r = remapEnv({ DB_ADDR: `${DK_HOST}:3306` }, { dbs: [dkMysql("preserve")], apps: [] });
    expect(r.changes).toHaveLength(0);
    expect(r.needsManual).toContainEqual(expect.objectContaining({ key: "DB_ADDR", reason: RM_CONTAINS_TOKEN }));
  });

  it("overlapping hyphenated hosts resolve by EXACT equality (longer vs shorter), not substring", () => {
    const A = dkMysql("preserve", { itemRef: "database:_:appdb-aaaaaa", oldHost: "appdb-aaaaaa", newHost: "tugra_db_A" });
    const B = dkMysql("preserve", { itemRef: "database:_:appdb-aaaaaa-replica", oldHost: "appdb-aaaaaa-replica", newHost: "tugra_db_B" });
    const ctx = dkCtx([A, B]);
    expect(remapEnv({ DB_HOST: "appdb-aaaaaa-replica" }, ctx).changes[0]).toMatchObject({ newValue: "tugra_db_B" });
    expect(remapEnv({ DB_HOST: "appdb-aaaaaa" }, ctx).changes[0]).toMatchObject({ newValue: "tugra_db_A" });
  });

  it("DOKPLOY preserve: only the host is swapped, credentials stay untouched", () => {
    const r = remapEnv({ DB_HOST: DK_HOST, DB_USER: "dies", DB_PASSWORD: "S3cr3t", DB_NAME: "dies" }, dkCtx([dkMysql("preserve")]));
    expect(r.changes.map((c) => c.key)).toEqual(["DB_HOST"]);
    expect(r.changes[0].newValue).toBe("tugra_db_dk1");
    expect(r.unchanged).toEqual(expect.arrayContaining(["DB_USER", "DB_PASSWORD", "DB_NAME"]));
  });

  it("DOKPLOY host:port and a DATABASE_URL carrying the hyphenated host are rewritten", () => {
    const r = remapEnv(
      { DB_ADDR: `${DK_HOST}:3306`, DATABASE_URL: `mysql://dies:S3cr3t@${DK_HOST}:3306/dies` },
      dkCtx([dkMysql("rotate")]),
    );
    const byKey = Object.fromEntries(r.changes.map((c) => [c.key, c]));
    expect(byKey.DB_ADDR).toMatchObject({ rule: "host-port", newValue: "tugra_db_dk1:3306" });
    expect(byKey.DATABASE_URL.rule).toBe("url");
    expect(byKey.DATABASE_URL.newValue).toBe("mysql://tugra:NEWpw@tugra_db_dk1:3306/diesdb");
    expect(byKey.DATABASE_URL.newMasked).toBe("mysql://tugra:***@tugra_db_dk1:3306/diesdb");
  });

  it("looser shape does NOT edit ordinary words: only an EXACT oldHost match is ever rewritten", () => {
    const r = remapEnv(
      { APP_NAME: "diesdigital", REGION: "eu-central-1", DB_HOST: `${DK_HOST}-replica`, DB_HOST2: "diesdigital-db", MODE: "production-build" },
      dkCtx([dkMysql("rotate")]),
    );
    expect(r.changes).toHaveLength(0);
  });

  it("boundary safety: a hyphenated host as a NON-boundary substring is flagged contains-token, never edited", () => {
    const r = remapEnv(
      { NOTE: `primary is ${DK_HOST} today`, PREFIXED: `x${DK_HOST}`, SUFFIXED: `${DK_HOST}-replica`, DB_HOST: `${DK_HOST}-replica` },
      dkCtx([dkMysql("rotate")]),
    );
    expect(r.changes).toHaveLength(0);
    for (const key of ["NOTE", "PREFIXED", "SUFFIXED", "DB_HOST"]) {
      expect(r.needsManual).toContainEqual(expect.objectContaining({ key, reason: RM_CONTAINS_TOKEN, target: `database:_:${DK_HOST}` }));
    }
  });

  it("a Dokploy host that fails the shape (too short) is never matched as a bare host", () => {
    const r = remapEnv({ DB_HOST: "db" }, dkCtx([dkMysql("preserve", { oldHost: "db", itemRef: "database:_:db" })]));
    expect(r.changes).toHaveLength(0);
  });

  it("guards intact under the Dokploy shape: RM_AMBIGUOUS, RM_QUERY_CREDS, RM_APP_LINK_REVIEW, RM_PASSWORD_UNKNOWN", () => {
    const H2 = "other-db-9zzzzz";
    const db1 = dkMysql("rotate", { oldUser: "shared" });
    const db2 = dkMysql("preserve", { itemRef: `database:_:${H2}`, oldHost: H2, newHost: "tugra_db_dk2", oldUser: "shared" });
    const amb = remapEnv({ A_HOST: DK_HOST, B_HOST: H2, DB_USER: "shared" }, dkCtx([db1, db2]));
    expect(amb.changes.find((c) => c.key === "DB_USER")).toBeUndefined();
    expect(amb.needsManual).toContainEqual(expect.objectContaining({ key: "DB_USER", reason: RM_AMBIGUOUS }));

    const q = remapEnv({ DATABASE_URL: `mysql://dies:pw@${DK_HOST}:3306/dies?password=old` }, dkCtx([dkMysql("rotate")]));
    expect(q.changes).toHaveLength(0);
    expect(q.needsManual).toContainEqual(expect.objectContaining({ reason: RM_QUERY_CREDS }));

    const app = remapEnv(
      { API_URL: "http://web-app-k3j2h1:3000" },
      dkCtx([], [{ itemRef: "app:_:web-app-k3j2h1", name: "web", oldHost: "web-app-k3j2h1", newHost: "tugra_app1" }]),
    );
    expect(app.changes).toHaveLength(0);
    expect(app.needsManual).toContainEqual(expect.objectContaining({ key: "API_URL", reason: RM_APP_LINK_REVIEW }));

    const pw = remapEnv({ DB_HOST: DK_HOST, DB_PASSWORD: "whatever" }, dkCtx([dkMysql("rotate")]));
    expect(pw.needsManual).toContainEqual(expect.objectContaining({ key: "DB_PASSWORD", reason: RM_PASSWORD_UNKNOWN }));
  });

  it("is idempotent under the Dokploy shape", () => {
    const first = remapEnv({ DB_HOST: DK_HOST, DB_USER: "dies" }, dkCtx([dkMysql("rotate")]));
    const next: Record<string, string> = { DB_HOST: DK_HOST, DB_USER: "dies" };
    for (const c of first.changes) next[c.key] = c.newValue;
    expect(remapEnv(next, dkCtx([dkMysql("rotate")])).changes).toHaveLength(0);
  });
});

describe("remapEnv — old source services (RM_SERVICE_LINK_REVIEW)", () => {
  const SVC = "k1l2m3n4o5p6q7r8s9t0u1v2"; // Coolify service uuid (uuid-shaped)
  const services = [{ itemRef: `service:srv:${SVC}`, name: "minio", oldHost: SVC }];
  const c = (extra: Partial<RemapContext> = {}): RemapContext => ({ dbs: [pgTarget("preserve")], apps: [], services, ...extra });

  it("a URL whose host is the service uuid or a member container `<name>-<uuid>` is needsManual, never edited", () => {
    const r = remapEnv(
      { S3_ENDPOINT: `http://minio-${SVC}:9000`, S3_URL: `https://${SVC}:9000/bucket`, S3_HOST: SVC, S3_HOSTPORT: `${SVC}:9000`, S3_BARE: `minio-${SVC}` },
      c(),
    );
    expect(r.changes).toEqual([]);
    expect(r.needsManual.map((n) => [n.key, n.reason, n.target]).sort()).toEqual(
      ["S3_BARE", "S3_ENDPOINT", "S3_HOST", "S3_HOSTPORT", "S3_URL"].map((k) => [k, RM_SERVICE_LINK_REVIEW, services[0].itemRef]).sort(),
    );
    expect(r.unchanged).toEqual([]);
  });

  it("without `services` the same env is byte-identical to before (silently unchanged)", () => {
    const env = { S3_ENDPOINT: `http://minio-${SVC}:9000`, S3_HOST: SVC };
    const before = remapEnv(env, { dbs: [pgTarget("preserve")], apps: [] });
    const withEmpty = remapEnv(env, { dbs: [pgTarget("preserve")], apps: [], services: [] });
    expect(withEmpty).toEqual(before);
    expect(before.needsManual).toEqual([]);
    expect(before.unchanged.sort()).toEqual(["S3_ENDPOINT", "S3_HOST"]);
  });

  it("DB and app rules are unchanged by the services list; unrelated values stay unchanged", () => {
    const r = remapEnv({ DATABASE_URL: `postgres://appuser:pw@${UUID}:5432/appdb`, NAME: "minio-sibling", REGION: "eu-west-1" }, c());
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0].rule).toBe("url");
    expect(r.needsManual).toEqual([]);
    expect(r.unchanged.sort()).toEqual(["NAME", "REGION"]);
  });

  it("a service oldHost that is not uuid-shaped is ignored (never matched on a loose string)", () => {
    const r = remapEnv({ X: "minio" }, c({ services: [{ itemRef: "service:srv:minio", name: "minio", oldHost: "minio" }] }));
    expect(r.needsManual).toEqual([]);
  });
});

describe("R21: a uuid-shaped host no plan item owns", () => {
  const GHOST = "qrstuvwxyz0123456789abcd"; // 24 chars, owned by no database / app / service of the plan
  const known = (extra: Partial<RemapContext> = {}): RemapContext => ({ dbs: [pgTarget("preserve")], apps: [], flagUnresolvedHosts: true, ...extra });

  it("isCoolifyUuidHost: 24 lower-case letters+digits, or <service>-<uuid> with both letters and digits in the uuid; nothing else", () => {
    expect(isCoolifyUuidHost(GHOST)).toBe(true);
    expect(isCoolifyUuidHost(`meili-${GHOST}`)).toBe(true);
    expect(isCoolifyUuidHost("a".repeat(23))).toBe(false);
    expect(isCoolifyUuidHost("a".repeat(25))).toBe(false);
    expect(isCoolifyUuidHost("Q".repeat(24))).toBe(false);
    expect(isCoolifyUuidHost(`cache-${"a".repeat(24)}`)).toBe(false); // a plain word after a dash is not a member container
    expect(isCoolifyUuidHost("db.example.test")).toBe(false);
  });

  it("a connection URL whose host is an unknown uuid is needsManual with the stable code, and nothing is rewritten", () => {
    const r = remapEnv({ CACHE_URL: `redis://:pw@${GHOST}:6379/0`, DATABASE_URL: `postgres://appuser:pw@${UUID}:5432/appdb` }, known());
    expect(r.needsManual).toEqual([{ key: "CACHE_URL", reason: RM_UNRESOLVED_HOST }]);
    expect(r.changes.map((c) => c.key)).toEqual(["DATABASE_URL"]); // the database the plan owns is still rewritten
    expect(RM_UNRESOLVED_HOST).toBe("unresolved-uuid-host");
  });

  it("a bare host, host:port and a service member name are flagged; a bare value is judged only under a host-like key", () => {
    const r = remapEnv({ REDIS_HOST: GHOST, PGHOST: GHOST, OTHER_ADDR: `${GHOST}:5432`, ODD: `${GHOST}:6379`, SEARCH_HOST: `meili-${GHOST}`, DB_PASSWORD: GHOST, API_KEY: GHOST }, known());
    expect(r.needsManual.map((n) => n.key).sort()).toEqual(["ODD", "OTHER_ADDR", "PGHOST", "REDIS_HOST", "SEARCH_HOST"]);
    expect(r.needsManual.every((n) => n.reason === RM_UNRESOLVED_HOST)).toBe(true);
    expect(r.unchanged.sort()).toEqual(["API_KEY", "DB_PASSWORD"]); // a 24-character generated password is never taken for a host
  });

  it("a host the plan owns (database, app, service) keeps its own handling and is never reported unresolved", () => {
    const r = remapEnv(
      { DB_HOST: UUID, OTHER: `http://${APPUUID}:3000`, MINIO: `http://${GHOST}:9000` },
      known({ apps: [{ itemRef: `app:_:${APPUUID}`, name: "other", oldHost: APPUUID, newHost: "tugra_x" }], services: [{ itemRef: `service:_:${GHOST}`, name: "minio", oldHost: GHOST }] }),
    );
    expect(r.changes.map((c) => c.key)).toEqual(["DB_HOST"]);
    expect(r.needsManual).toEqual([
      { key: "OTHER", reason: RM_APP_LINK_REVIEW, target: `app:_:${APPUUID}` },
      { key: "MINIO", reason: RM_SERVICE_LINK_REVIEW, target: `service:_:${GHOST}` },
    ]);
  });

  it("is opt-in (a caller that omits flagUnresolvedHosts is byte-identical) and never flags a host the caller says a plan item owns", () => {
    const env = { REDIS_HOST: GHOST, CACHE_URL: `redis://${GHOST}:6379` };
    expect(remapEnv(env, known({ flagUnresolvedHosts: undefined })).needsManual).toEqual([]);
    expect(remapEnv(env, known({ flagUnresolvedHosts: false })).needsManual).toEqual([]);
    expect(remapEnv(env, known({ ownedHosts: [GHOST] })).needsManual).toEqual([]);
    expect(remapEnv(env, known({ ownedHosts: [GHOST] })).unchanged.sort()).toEqual(["CACHE_URL", "REDIS_HOST"]);
  });

  it("an ordinary hostname, an empty value and a longer host are untouched", () => {
    const r = remapEnv({ A: "https://api.example.test/x", B: "", C_HOST: "localhost", D: `http://${GHOST}x.example.test` }, known());
    expect(r.needsManual).toEqual([]);
  });
});

describe("R21 key gate and readable (carried) hosts", () => {
  const GHOST = "qrstuvwxyz0123456789abcd";
  const known = (extra: Partial<RemapContext> = {}): RemapContext => ({ dbs: [pgTarget("preserve")], apps: [], flagUnresolvedHosts: true, ...extra });

  it("a generated 24-character secret under a key that merely CONTAINS a host word is not an unresolved host", () => {
    const secret = "0123456789abcdef01234567";
    const r = remapEnv({ MASTER_KEY: secret, NODE_AUTH_TOKEN: secret, APP_SERVER_SECRET: secret, PRIMARY_PASSWORD: secret, REPLICA_PASS: secret, NODENAME: secret, ENDPOINTS: secret }, known());
    expect(r.needsManual).toEqual([]);
  });

  it("the host words still count as a whole word or as the end of the key (DBHOST, REDIS_ADDR, DB_HOST_PRIMARY, MASTER_NODE)", () => {
    const r = remapEnv({ DBHOST: GHOST, REDIS_ADDR: GHOST, DB_HOST_PRIMARY: GHOST, MASTER_NODE: GHOST, SERVER: GHOST }, known());
    expect(r.needsManual.map((n) => n.key).sort()).toEqual(["DBHOST", "DB_HOST_PRIMARY", "MASTER_NODE", "REDIS_ADDR", "SERVER"]);
  });

  describe("readableHosts: a carried container with an operator-chosen name", () => {
    const target = (name: string) => pgTarget("rotate", { oldHost: name, itemRef: `database:srv-a:${name}` });
    const rc = (name: string, extra: Partial<RemapContext> = {}): RemapContext => ({ dbs: [target(name)], apps: [], flagUnresolvedHosts: true, readableHosts: [name], ...extra });

    it("a bare host and host:port under a host-like key are rewritten to the new host (they were reported as contains-old-token)", () => {
      const r = remapEnv({ DB_HOST: "pg_main", PRIMARY_ADDR: "pg_main:5432", DATABASE_URL: "postgres://appuser:pw@pg_main:5432/appdb" }, rc("pg_main"));
      expect(r.changes.map((c) => `${c.key}:${c.rule}`).sort()).toEqual(["DATABASE_URL:url", "DB_HOST:host", "PRIMARY_ADDR:host-port"]);
      expect(r.needsManual).toEqual([]);
    });

    it("without readableHosts the same name is NOT rewritten (the shape gate is unchanged for every other caller)", () => {
      const r = remapEnv({ DB_HOST: "pg_main" }, { dbs: [target("pg_main")], apps: [] });
      expect(r.changes).toEqual([]);
    });

    it("a short name is never rewritten under a non-host key: a bare value is reported, and only a whole word is found in a longer one", () => {
      const r = remapEnv({ CACHE_DRIVER: "redis", LABEL: "myredis-cache", NOTE: "uses redis-cache", DSN: "host=redis port=6379" }, rc("redis"));
      expect(r.changes).toEqual([]);
      expect(r.needsManual.map((n) => `${n.key}:${n.reason}`).sort()).toEqual(["CACHE_DRIVER:contains-old-token", "DSN:contains-old-token"]);
      expect(r.unchanged.sort()).toEqual(["LABEL", "NOTE"]);
    });

    it("a secret under a host-like key is not a host", () => {
      const r = remapEnv({ DB_HOST_SECRET: "pg_main" }, rc("pg_main"));
      expect(r.changes).toEqual([]);
    });
  });
});

