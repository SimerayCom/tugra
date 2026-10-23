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
    // never leak the real password in the masked output
    expect(JSON.stringify(r)).not.toContain("S3cr3t");
    expect(JSON.stringify(r)).not.toContain("NEWpw");
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

  it("masks a password carried in the QUERY string (preserve) — never leaks it", () => {
    const r = remapEnv({ DATABASE_URL: `postgres://u:p@${UUID}:5432/db?password=S3cr3tQ&sslmode=require` }, ctx([pgTarget("preserve")]));
    expect(JSON.stringify(r)).not.toContain("S3cr3tQ");
    expect(r.changes[0].newMasked).toContain("password=***");
    expect(r.changes[0].newMasked).toContain("sslmode=require"); // non-secret query kept
  });

  it("masks a userinfo-LESS URL's query password too", () => {
    const r = remapEnv({ DATABASE_URL: `postgres://${UUID}:5432/db?password=S3cr3tQ` }, ctx([pgTarget("preserve")]));
    expect(JSON.stringify(r)).not.toContain("S3cr3tQ");
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
