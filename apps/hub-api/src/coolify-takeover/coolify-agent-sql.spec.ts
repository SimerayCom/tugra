import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildSectionSql, SECRET_NAME_SQL_RE, SECTIONS as V1 } from "./coolify-sql";
import { AGENT_SECTIONS, APP_TEXT_PRESENT, buildAgentReadScript, buildAgentReadSql, CFYA, DB_TEXT_PRESENT, SCHEMA_SECTION, sectionLimits } from "./coolify-agent-sql";
import { CFY } from "./coolify-read-script";
import { parseAgentRead } from "./coolify-agent-read";

const secretName = new RegExp(SECRET_NAME_SQL_RE.replace("private_key", "private_key(?!_id)"), "i");
const sh = (script: string) => spawnSync("sh", ["-n"], { input: script, encoding: "utf8" });

describe("agent read SQL: what is read", () => {
  it("every section is one plain select over the public schema, soft-delete filtered, with no write keyword", () => {
    const bad: string[] = [];
    for (const s of AGENT_SECTIONS) {
      const sql = buildSectionSql(s);
      const single = sql.split(";").filter((x) => x.trim()).length === 1;
      const writes = /\b(insert|update|delete|drop|alter|create|truncate|grant|copy|call|do|set|lock)\b/i.test(sql);
      if (!sql.trimStart().startsWith("select") || !single || writes || !sql.includes(`from public.${s.table} t`) || !sql.includes("(to_jsonb(t)->>'deleted_at') is null")) bad.push(s.name);
    }
    expect(bad).toEqual([]);
  });

  it("has unique section names", () => {
    expect(new Set(AGENT_SECTIONS.map((s) => s.name)).size).toBe(AGENT_SECTIONS.length);
  });

  it("never allow-lists a column that looks like a secret: those arrive as present flags only", () => {
    const offenders: string[] = [];
    for (const s of AGENT_SECTIONS) for (const c of [...s.plain, ...(s.scrubUrl ?? [])]) if (secretName.test(c) && c !== "key") offenders.push(`${s.name}.${c}`);
    expect(offenders).toEqual([]);
  });

  it("free-form text that can hold a secret is present-only, never plain (compose, Dockerfile, labels, Docker options, hooks, engine config, file contents)", () => {
    const app = AGENT_SECTIONS.find((s) => s.name === "applications")!;
    for (const c of APP_TEXT_PRESENT) {
      expect(app.plain).not.toContain(c);
      expect(app.present).toContain(c);
    }
    for (const s of AGENT_SECTIONS.filter((x) => x.name.startsWith("db_"))) {
      for (const c of DB_TEXT_PRESENT) {
        expect(s.plain).not.toContain(c);
        expect(s.present).toContain(c);
      }
    }
    expect(AGENT_SECTIONS.find((s) => s.name === "file_volumes")!.present).toContain("content");
    expect(AGENT_SECTIONS.find((s) => s.name === "services")!.present).toContain("docker_compose_raw");
    expect(AGENT_SECTIONS.find((s) => s.name === "scheduled_tasks")!.present).toContain("command");
    expect(AGENT_SECTIONS.find((s) => s.name === "env_vars")!.present).toContain("value");
    expect(AGENT_SECTIONS.find((s) => s.name === "s3")!.present).toEqual(expect.arrayContaining(["key", "secret"]));
    // and no section ever allow-lists a value column
    expect(AGENT_SECTIONS.filter((s) => s.plain.some((c) => ["value", "content", "command", "docker_compose_raw", "dockerfile", "custom_labels"].includes(c))).map((s) => s.name)).toEqual([]);
  });

  it("keeps URL scrubbing on the columns that can carry user:token@", () => {
    const stray: string[] = [];
    for (const s of AGENT_SECTIONS) for (const c of s.scrubUrl ?? []) if (!s.plain.includes(c)) stray.push(`${s.name}.${c}`);
    expect(stray).toEqual([]);
    expect(AGENT_SECTIONS.find((s) => s.name === "applications")!.scrubUrl).toEqual(expect.arrayContaining(["git_repository", "fqdn"]));
  });

  it("every plain column that can hold a URL with credentials (fqdn, endpoint, repository) is scrubbed, including the instance row", () => {
    const unscrubbed: string[] = [];
    for (const s of AGENT_SECTIONS) for (const c of s.plain) if (/^(fqdn|endpoint|git_repository)$/.test(c) && !(s.scrubUrl ?? []).includes(c)) unscrubbed.push(`${s.name}.${c}`);
    expect(unscrubbed).toEqual([]);
  });

  it("reads everything the plan needs (build and run config, settings, volumes, database users, tags, git apps, S3, teams)", () => {
    const names = AGENT_SECTIONS.map((s) => s.name);
    for (const n of ["teams", "team_members", "servers", "server_settings", "projects", "environments", "docker_standalone", "applications", "app_settings", "db_postgresql", "db_redis", "services", "service_apps", "service_dbs", "env_vars", "shared_vars", "volumes", "file_volumes", "scheduled_tasks", "backups", "s3", "git_github", "git_gitlab", "git_gitea", "tags", "taggables"]) {
      expect(names).toContain(n);
    }
    const app = AGENT_SECTIONS.find((s) => s.name === "applications")!;
    for (const c of ["install_command", "build_command", "start_command", "health_check_enabled", "limits_memory", "redirect", "watch_paths", "docker_compose_domains", "custom_network_aliases", "restart_count"]) expect(app.plain).toContain(c);
    expect(AGENT_SECTIONS.find((s) => s.name === "app_settings")!.plain).toEqual(expect.arrayContaining(["is_static", "custom_container_name_prefix"]));
  });

  it("reads a member's name and email only (never a password hash, a 2FA secret or a session token)", () => {
    const users = AGENT_SECTIONS.find((s) => s.table === "users")!;
    expect(users.plain).toEqual(["id", "name", "email"]);
    expect(users.present ?? []).toEqual([]);
    expect(AGENT_SECTIONS.flatMap((s) => s.plain).filter((c) => /password|two_factor|remember_token/.test(c))).toEqual([]);
    // the statement projects through the allow-list: the secret-looking columns of `users` can only come out as a presence flag
    const sql = buildAgentReadSql();
    expect(sql).toMatch(/public\.users t/);
    expect(sql).not.toMatch(/'password'|two_factor_secret'|remember_token'/);
  });

  it("v1 sections are untouched in name and table except where the agent read widens them", () => {
    const widened = new Set(AGENT_SECTIONS.map((s) => s.name));
    for (const s of V1) expect(widened.has(s.name)).toBe(true);
    for (const s of V1) expect(AGENT_SECTIONS.find((x) => x.name === s.name)!.table).toBe(s.table);
  });

  it("caps every section: the cap is known so a read that hit it can be reported", () => {
    const limits = sectionLimits();
    for (const s of AGENT_SECTIONS) expect(limits[s.name]).toBe(Math.min(50_000, s.limit)); // the query clamps at 50,000
    // "the newest migration" is one row by design: it is not a cap a read can hit
    expect(limits[SCHEMA_SECTION]).toBeUndefined();
  });

  it("every section query asks for one row more than its cap, so a full table is told apart from a cut one", () => {
    const script = buildAgentReadSql();
    for (const s of AGENT_SECTIONS) expect(script).toContain(`  limit ${Math.min(50_000, s.limit) + 1}\n`);
    expect(buildSectionSql({ name: "x", table: "t", plain: ["id"], limit: 1 })).toContain("limit 1\n");
  });
});

describe("agent read script", () => {
  const script = buildAgentReadScript();

  it("is valid shell and a constant", () => {
    expect(sh(script).status).toBe(0);
    expect(buildAgentReadScript()).toBe(script);
  });

  it("is ONE psql session in ONE REPEATABLE READ READ ONLY transaction, ended by a commit", () => {
    expect([...script.matchAll(/docker exec/g)]).toHaveLength(1);
    const sql = buildAgentReadSql();
    expect(sql.indexOf("begin isolation level repeatable read read only;")).toBeGreaterThan(0);
    expect(sql.split("begin ")).toHaveLength(2);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    expect(sql).toContain("\\set ON_ERROR_STOP on");
    // the hub is told what the server confirmed, before the first section
    expect(sql.indexOf("transaction_read_only")).toBeLessThan(sql.indexOf(`${CFY.begin}`));
    expect(sql.indexOf("transaction_isolation")).toBeLessThan(sql.indexOf(`${CFY.begin}`));
  });

  it("guards every section with a table lookup, so a table this version lacks is a skip and never an aborted transaction", () => {
    const sql = buildAgentReadSql();
    for (const s of AGENT_SECTIONS) {
      expect(sql).toContain(`select to_regclass('public.${s.table}') is not null as has \\gset`);
      expect(sql).toContain(`\\echo ${CFY.begin}${s.name}\n`);
      expect(sql).toContain(`\\echo ${CFY.skip}${s.name}\n`);
    }
    expect(sql.match(/\\if :has/g)).toHaveLength(AGENT_SECTIONS.length + 1); // + the schema version
  });

  it("only talks to the coolify-db container, read-only, and never touches the database password or APP_KEY", () => {
    expect(script).toContain('PGOPTIONS="-c default_transaction_read_only=on');
    expect([...script.matchAll(/docker exec [^\n]*? (\S+) sh -c/g)].every((m) => m[1] === "coolify-db")).toBe(true);
    expect(script).not.toMatch(/docker (rm|run|stop|start|restart|cp|commit|kill|pause|network|volume)/);
    expect(script).not.toMatch(/APP_KEY|POSTGRES_PASSWORD|PGPASSWORD|\.env\b|base64:/);
    expect(script).not.toMatch(/\$\{|\$\(.*(curl|wget|nc)\b/); // nothing from a request, no network tool
  });

  it("prints DONE only when psql ended cleanly, and FAIL otherwise", () => {
    expect(script).toContain(`[ $? -eq 0 ] || { echo ${CFYA.fail}; exit 0; }`);
    expect(script.indexOf(CFYA.fail)).toBeLessThan(script.lastIndexOf(`echo ${CFY.done}`));
  });

  describe("run against a stand-in docker", () => {
    function run(answer: string, opts: { running?: string } = {}) {
      const dir = mkdtempSync(path.join(tmpdir(), "cfya-"));
      const fake = `#!/bin/sh
case "$1" in
  inspect)
    case "$*" in
      *State.Running*) echo ${opts.running ?? "true"} ;;
      *coolify-db*) echo postgres:16-alpine ;;
      *) echo ghcr.io/coollabsio/coolify:4.0.0-beta.463 ;;
    esac ;;
  exec)
    cat > "${dir}/stdin.sql"
    cat "${dir}/answer.txt" ;;
esac
`;
      writeFileSync(path.join(dir, "docker"), fake);
      chmodSync(path.join(dir, "docker"), 0o755);
      writeFileSync(path.join(dir, "answer.txt"), answer);
      const test = script.replace(/^export PATH=.*$/m, `export PATH=${dir}:/usr/bin:/bin`);
      const out = spawnSync("sh", ["-c", test], { encoding: "utf8" }).stdout;
      return { out, dir };
    }
    const good = ["TUGRA_CFY_RO on", "TUGRA_CFY_ISO repeatable read", `${CFY.begin}servers`, '[{"id":0,"uuid":"s","name":"localhost","ip":"x","port":22,"user":"root"}]', `${CFY.end}servers`, `${CFY.begin}${SCHEMA_SECTION}`, '[{"id":9,"migration":"2025_m"}]', `${CFY.end}${SCHEMA_SECTION}`].join("\n");

    it("frames the read and the output parses; the SQL sent to the container is the constant read", () => {
      const { out, dir } = run(good + "\n");
      expect(out).toContain(CFY.done);
      const read = parseAgentRead(out);
      expect(read.sections.get("servers")).toHaveLength(1);
      expect(read.schemaVersion).toBe("2025_m");
      expect(require("node:fs").readFileSync(path.join(dir, "stdin.sql"), "utf8").trim()).toBe(buildAgentReadSql().trim());
    });

    it("reports a stopped Coolify database instead of reading", () => {
      expect(run("", { running: "false" }).out).toContain(CFY.stopped);
    });
  });
});
