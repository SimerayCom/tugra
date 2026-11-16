/** The env remap beyond DB hosts (grup-7, R12/R22/R23): cross-server references, service endpoints and sslmode. */
import { remapEnv, sslmodeOf, RM_CROSS_SERVER, RM_SERVICE_LINK_REVIEW, RM_SERVICE_NET, RM_TLS_VERIFY, type DbRemapTarget, type RemapContext, type ServiceRemapTarget } from "./env-rewrite";

const DB = "3f1a9c0b2d4e6f8a1b3c5d7e";
const SVC = "9a8b7c6d5e4f3a2b1c0d9e8f";

const pg = (extra: Partial<DbRemapTarget> = {}): DbRemapTarget => ({
  itemRef: `database:src-a:${DB}`,
  name: "db-main",
  engine: "POSTGRES",
  mode: "preserve",
  oldHost: DB,
  newHost: "tugra_db_x1",
  newPort: 5432,
  newUser: "tugra",
  newPassword: "pw",
  newDatabase: "app",
  ...extra,
});

const meili = (extra: Partial<ServiceRemapTarget> = {}): ServiceRemapTarget => ({
  itemRef: `service:src-a:${SVC}`,
  name: "search",
  oldHost: SVC,
  serverId: "tgt-1",
  privateAlias: { network: "svc-search", alias: "meilisearch" },
  ...extra,
});

const run = (env: Record<string, string>, over: Partial<RemapContext> = {}) => remapEnv(env, { dbs: [], apps: [], ...over });

describe("sslmodeOf", () => {
  it("reads the sslmode of a URL query, case-insensitively, ignoring other keys", () => {
    expect(sslmodeOf("/db?sslmode=Require")).toBe("require");
    expect(sslmodeOf("/db?x=1&sslmode=verify-full&y=2")).toBe("verify-full");
    expect(sslmodeOf("/db")).toBeUndefined();
    expect(sslmodeOf("/db?nosslmode=require")).toBeUndefined();
    expect(sslmodeOf("/db?sslmode=require#frag")).toBe("require");
  });
});

describe("sslmode (R22)", () => {
  it("sslmode=require: the URL is rewritten and the DB is reported as needing TLS until it serves it", () => {
    const env = { DATABASE_URL: `postgres://u:p@${DB}:5432/app?sslmode=require` };
    const r = run(env, { dbs: [pg()] });
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]).toMatchObject({ rule: "url", tls: "require" });
    expect(r.changes[0].newValue).toBe("postgres://u:p@tugra_db_x1:5432/app?sslmode=require");
    expect(r.tlsNeeded).toEqual([`database:src-a:${DB}`]);
    expect(run(env, { dbs: [pg({ ssl: true })] }).tlsNeeded).toBeUndefined(); // already serves TLS
  });

  it("verify-ca / verify-full: reported, never rewritten (a self-signed copy cannot satisfy a chain check)", () => {
    for (const m of ["verify-ca", "verify-full"]) {
      const r = run({ DATABASE_URL: `postgres://u:p@${DB}:5432/app?sslmode=${m}` }, { dbs: [pg()] });
      expect(r.changes).toEqual([]);
      expect(r.needsManual).toEqual([{ key: "DATABASE_URL", reason: RM_TLS_VERIFY, target: `database:src-a:${DB}` }]);
    }
  });

  it("prefer / disable / absent: no TLS requirement; MySQL URLs are not touched by the PostgreSQL rule", () => {
    for (const q of ["?sslmode=prefer", "?sslmode=disable", ""]) expect(run({ U: `postgres://u:p@${DB}:5432/app${q}` }, { dbs: [pg()] }).tlsNeeded).toBeUndefined();
    const my = pg({ engine: "MYSQL" });
    expect(run({ U: `mysql://u:p@${DB}:3306/app?sslmode=require` }, { dbs: [my] }).tlsNeeded).toBeUndefined();
  });

  it("PGSSLMODE: require needs TLS on the referenced PostgreSQL DBs, verify-* is manual, others are left alone", () => {
    const env = (m: string) => ({ DATABASE_URL: `postgres://u:p@${DB}:5432/app`, PGSSLMODE: m });
    expect(run(env("require"), { dbs: [pg()] }).tlsNeeded).toEqual([`database:src-a:${DB}`]);
    expect(run(env("verify-full"), { dbs: [pg()] }).needsManual).toContainEqual({ key: "PGSSLMODE", reason: RM_TLS_VERIFY, target: `database:src-a:${DB}` });
    expect(run(env("disable"), { dbs: [pg()] }).tlsNeeded).toBeUndefined();
    // no PostgreSQL DB referenced: PGSSLMODE is just another unrelated variable
    expect(run({ PGSSLMODE: "require" }, { dbs: [pg()] }).unchanged).toContain("PGSSLMODE");
  });
});

describe("cross-server references (R12)", () => {
  it("a database on another Tugra server is reported in every form, never rewritten to an unreachable name", () => {
    const db = pg({ serverId: "tgt-2" });
    const r = run({ URL_FORM: `postgres://u:p@${DB}:5432/app`, BARE_HOST: DB, HOST_PORT: `${DB}:5432` }, { dbs: [db], appServerId: "tgt-1" });
    expect(r.changes).toEqual([]);
    expect(r.needsManual.map((n) => [n.key, n.reason])).toEqual([["URL_FORM", RM_CROSS_SERVER], ["BARE_HOST", RM_CROSS_SERVER], ["HOST_PORT", RM_CROSS_SERVER]]);
  });

  it("same server, an unknown server on either side, or no appServerId: the rewrite is unchanged", () => {
    const env = { URL: `postgres://u:p@${DB}:5432/app` };
    expect(run(env, { dbs: [pg({ serverId: "tgt-1" })], appServerId: "tgt-1" }).changes).toHaveLength(1);
    expect(run(env, { dbs: [pg()], appServerId: "tgt-1" }).changes).toHaveLength(1);
    expect(run(env, { dbs: [pg({ serverId: "tgt-2" })] }).changes).toHaveLength(1);
  });
});

describe("service endpoints (R23)", () => {
  const ok: Partial<RemapContext> = { services: [meili()], appServerId: "tgt-1", appCanJoinNetwork: true };

  it("an internal service host becomes the private alias, in URL, bare and host:port forms, and names the network to join", () => {
    const r = run({ MEILI_URL: `http://meilisearch-${SVC}:7700`, MEILI_HOST: `meilisearch-${SVC}`, MEILI_ADDR: `meilisearch-${SVC}:7700` }, ok);
    expect(r.changes.map((c) => [c.key, c.rule, c.newValue, c.joinNetwork])).toEqual([
      ["MEILI_URL", "service-host", "http://meilisearch:7700", "svc-search"],
      ["MEILI_HOST", "service-host", "meilisearch", "svc-search"],
      ["MEILI_ADDR", "service-host", "meilisearch:7700", "svc-search"],
    ]);
    expect(r.changes[0].target).toEqual({ itemRef: `service:src-a:${SVC}`, kind: "service", name: "search" });
    expect(r.serviceLinks).toHaveLength(3);
  });

  it("a URL keeps its userinfo, path and query; the masked diff never shows the password", () => {
    const r = run({ S3: `https://key:s3cr3t@meilisearch-${SVC}:7700/idx?x=1` }, ok);
    expect(r.changes[0].newValue).toBe("https://key:s3cr3t@meilisearch:7700/idx?x=1");
    expect(r.changes[0].newMasked).toBe("https://key:***@meilisearch:7700/idx?x=1");
    expect(r.changes[0].oldMasked).not.toContain("s3cr3t");
  });

  it("only the aliased member is rewritten; another member, a bare uuid host, no alias or an old shape stays manual", () => {
    expect(run({ A: `http://other-${SVC}:80` }, ok).needsManual).toEqual([{ key: "A", reason: RM_SERVICE_LINK_REVIEW, target: `service:src-a:${SVC}` }]);
    expect(run({ A: `http://${SVC}:80` }, ok).needsManual[0].reason).toBe(RM_SERVICE_LINK_REVIEW);
    expect(run({ A: `http://meilisearch-${SVC}:80` }, { ...ok, services: [meili({ privateAlias: undefined })] }).needsManual[0].reason).toBe(RM_SERVICE_LINK_REVIEW);
    expect(run({ A: `http://meilisearch-${SVC}:80` }, { ...ok, services: [{ itemRef: "s", name: "x", oldHost: SVC }] }).needsManual[0].reason).toBe(RM_SERVICE_LINK_REVIEW);
  });

  it("a service on another server, or an app that cannot join a network, is reported with its own reason", () => {
    expect(run({ A: `http://meilisearch-${SVC}:80` }, { ...ok, appServerId: "tgt-2" }).needsManual[0].reason).toBe(RM_CROSS_SERVER);
    expect(run({ A: `http://meilisearch-${SVC}:80` }, { ...ok, appCanJoinNetwork: false }).needsManual[0].reason).toBe(RM_SERVICE_NET);
    expect(run({ A: `http://meilisearch-${SVC}:80` }, { services: ok.services, appServerId: "tgt-1" }).needsManual[0].reason).toBe(RM_SERVICE_NET); // flag absent = not joinable
  });

  it("a public service host follows the DNS flip: unchanged, but the dependency is recorded", () => {
    const svc = meili({ publicHosts: [{ host: "s3.example.test" }] });
    const r = run({ S3_ENDPOINT: "https://S3.example.test:9000", OTLP: "otel.example.test" }, { services: [svc] });
    expect(r.changes).toEqual([]);
    expect(r.unchanged).toContain("S3_ENDPOINT");
    expect(r.serviceLinks).toEqual([{ key: "S3_ENDPOINT", target: `service:src-a:${SVC}`, via: "public" }]);
  });

  it("a renamed public host is rewritten in URL, bare and host:port forms", () => {
    const svc = meili({ publicHosts: [{ host: "old.example.test", rename: "new.example.test" }] });
    const r = run({ A: "https://u:p@old.example.test:9000/x", B: "old.example.test", C: "old.example.test:4318" }, { services: [svc] });
    expect(r.changes.map((c) => [c.key, c.rule, c.newValue])).toEqual([
      ["A", "service-public-host", "https://u:p@new.example.test:9000/x"],
      ["B", "service-public-host", "new.example.test"],
      ["C", "service-public-host", "new.example.test:4318"],
    ]);
  });

  it("the new fields are absent when nothing applies (the result keeps its old shape)", () => {
    const r = run({ X: "plain" }, { services: [meili()], dbs: [pg()] });
    expect(Object.keys(r).sort()).toEqual(["changes", "needsManual", "unchanged"]);
  });
});
