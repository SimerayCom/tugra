import { spawnSync } from "node:child_process";
import { AGENT_SECTIONS, buildAgentReadSql } from "./coolify-agent-sql";
import { parseAgentRead } from "./coolify-agent-read";

/**
 * The agent read against a REAL PostgreSQL (psql). Runs only when COOLIFY_READ_TEST_PG names an EMPTY scratch database
 * (a psql connection string, e.g. `postgresql://user@127.0.0.1:5599/scratch`): it creates Coolify-shaped tables in `public` and drops
 * them again. It refuses to run in a database that already has a table in `public`. Skipped otherwise (the unit specs cover the
 * script text and the parser; this one proves the SQL itself: soft delete, secret columns, the guards, REPEATABLE READ).
 */
const URL = process.env.COOLIFY_READ_TEST_PG;
const suite = URL ? describe : describe.skip;

const psql = (sql: string, readOnly = false) =>
  spawnSync("psql", [URL!, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1"], { input: sql, encoding: "utf8", env: { ...process.env, ...(readOnly ? { PGOPTIONS: "-c default_transaction_read_only=on" } : {}) }, maxBuffer: 64 * 1024 * 1024 });

const TABLES = [...new Set(AGENT_SECTIONS.map((s) => s.table))].filter((t) => t !== "applications" && t !== "servers");

suite("agent read SQL on a real PostgreSQL", () => {
  beforeAll(() => {
    const existing = psql("select count(*) from information_schema.tables where table_schema = 'public';");
    if (existing.status !== 0 || existing.stdout.trim() !== "0") throw new Error("COOLIFY_READ_TEST_PG must be an empty scratch database");
    const ddl = [
      // every table the read lists, with only the columns the test needs: an unknown column in an allow-list is simply absent
      ...TABLES.map((t) => `create table public.${t}(id bigint, deleted_at timestamp, uuid text, name text);`),
      `create table public.servers(id bigint, uuid text, name text, ip text, port int, "user" text, deleted_at timestamp, unreachable_count int, server_metadata text);`,
      `create table public.applications(id bigint, uuid text, name text, fqdn text, git_repository text, build_pack text, install_command text, docker_compose_raw text, custom_labels text, dockerfile text, http_basic_auth_password text, deleted_at timestamp);`,
      `insert into public.servers values (0,'srv-local','localhost','host.docker.internal',22,'root',null,0,null),(1,'srv-edge','edge','198.51.100.7',2222,'deploy',null,3,'{"os":"Ubuntu"}'),(2,'srv-gone','gone','198.51.100.9',22,'root',now(),0,null);`,
      `insert into public.applications values (7,'app-web','web','https://user:tok@www.example.com','https://x-access-token:ghp_SECRET@github.com/acme/web.git','nixpacks','npm ci','services: {db: {password: SECRETCOMPOSE}}','traefik.enable=SECRETLABEL','FROM x # SECRETDOCKERFILE','SECRETBASICAUTH',null),(8,'app-gone','gone','x','x','nixpacks','x','x','x','x','x',now());`,
      `create table public.migrations(id serial primary key, migration text, batch int); insert into public.migrations(migration,batch) values ('2024_a',1),('2025_newest',2);`,
    ].join("\n");
    const r = psql(ddl);
    if (r.status !== 0) throw new Error(`scratch schema failed: ${r.stderr}`);
  });

  afterAll(() => {
    psql([...TABLES, "servers", "applications", "migrations"].map((t) => `drop table if exists public.${t} cascade;`).join("\n"));
  });

  const run = () => {
    const r = psql(buildAgentReadSql(), true);
    expect(r.status).toBe(0);
    return r.stdout + "\nTUGRA_CFY_DONE\n";
  };

  it("one read-only REPEATABLE READ session whose output the strict parser accepts", () => {
    const read = parseAgentRead(run());
    expect(read.schemaVersion).toBe("2025_newest");
    expect(read.skipped).toEqual([]);
  });

  it("leaves out soft-deleted rows, and keeps the live ones", () => {
    const read = parseAgentRead(run());
    expect(read.sections.get("servers")!.map((s) => s.uuid)).toEqual(["srv-local", "srv-edge"]);
    expect(read.sections.get("applications")!.map((a) => a.uuid)).toEqual(["app-web"]);
  });

  it("never outputs a secret: password and text columns arrive as presence, URLs lose their credentials", () => {
    const out = run();
    for (const secret of ["SECRETCOMPOSE", "SECRETLABEL", "SECRETDOCKERFILE", "SECRETBASICAUTH", "ghp_SECRET", "tok@", "user:tok"]) expect(out).not.toContain(secret);
    const app = parseAgentRead(out).sections.get("applications")![0];
    expect(app).toMatchObject({ fqdn: "https://www.example.com", git_repository: "https://github.com/acme/web.git", install_command: "npm ci", docker_compose_raw_present: true, custom_labels_present: true, dockerfile_present: true, http_basic_auth_password_present: true });
    expect(app).not.toHaveProperty("docker_compose_raw");
    expect(app).not.toHaveProperty("custom_labels");
  });

  it("cannot write: a statement after the read in the same read-only-by-default session is refused", () => {
    const r = psql(`${buildAgentReadSql()}\ninsert into public.migrations(migration,batch) values ('x',9);`, true);
    // the read's own transaction is closed by `commit`; a write after it is refused by the read-only default of the session
    expect(r.status).not.toBe(0);
  });
});
