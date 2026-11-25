import { buildSectionSql, SECTIONS, SECRET_NAME_SQL_RE } from "./coolify-sql";

// `private_key_id` is an id (a reference), not the key itself.
const secretName = new RegExp(SECRET_NAME_SQL_RE.replace("private_key", "private_key(?!_id)"), "i");

describe("coolify read SQL", () => {
  it("is one plain select per section, with no write or DDL keyword", () => {
    const bad: string[] = [];
    for (const s of SECTIONS) {
      const sql = buildSectionSql(s);
      const single = sql.split(";").filter((x) => x.trim()).length === 1;
      const writes = /\b(insert|update|delete|drop|alter|create|truncate|grant|copy|call|do|set|lock)\b/i.test(sql);
      if (!sql.trimStart().startsWith("select") || !sql.trimEnd().endsWith(";") || !single || writes) bad.push(s.name);
    }
    expect(bad).toEqual([]);
  });

  it("has unique section names and only reads from the public schema", () => {
    expect(new Set(SECTIONS.map((s) => s.name)).size).toBe(SECTIONS.length);
    expect(SECTIONS.filter((s) => !buildSectionSql(s).includes(`from public.${s.table} t`)).map((s) => s.name)).toEqual([]);
  });

  it("never allow-lists a column that looks like a secret (those are reported as present flags only)", () => {
    const offenders: string[] = [];
    for (const s of SECTIONS) for (const c of [...s.plain, ...(s.scrubUrl ?? [])]) if (secretName.test(c) && c !== "key") offenders.push(`${s.name}.${c}`);
    expect(offenders).toEqual([]);
  });

  it("the env variable NAME is plain and its value is present-only", () => {
    expect(SECTIONS.filter((s) => s.plain.includes("value")).map((s) => s.name)).toEqual([]);
    const env = SECTIONS.find((s) => s.name === "env_vars")!;
    expect(env.plain).toContain("key");
    expect(env.present).toContain("value");
  });

  it("scrubbed URL columns are allow-listed ones", () => {
    const stray: string[] = [];
    for (const s of SECTIONS) for (const c of s.scrubUrl ?? []) if (!s.plain.includes(c)) stray.push(`${s.name}.${c}`);
    expect(stray).toEqual([]);
  });

  it("rejects an unsafe identifier or literal", () => {
    expect(() => buildSectionSql({ name: "x", table: "a; drop table b", plain: ["id"], limit: 1 })).toThrow("unsafe identifier");
    expect(() => buildSectionSql({ name: "x", table: "a", plain: ["id'"], limit: 1 })).toThrow("unsafe identifier");
    expect(() => buildSectionSql({ name: "x", table: "a", plain: ["id"], literal: { type: "x'y" }, limit: 1 })).toThrow("unsafe literal");
  });

  it("covers what item 72 lists", () => {
    const names = SECTIONS.map((s) => s.name);
    for (const n of ["teams", "projects", "environments", "servers", "applications", "services", "shared_vars", "scheduled_tasks", "backups", "s3", "db_postgresql", "notify_discord"]) {
      expect(names).toContain(n);
    }
  });

  it("outputs the per-event toggles of a channel through a validated prefix, and refuses an unsafe one", () => {
    const sql = buildSectionSql({ name: "n", table: "telegram_notification_settings", plain: ["id"], prefixes: ["telegram_notifications_"], limit: 10 });
    expect(sql).toContain("e.k ~ '^(telegram_notifications_)'");
    expect(() => buildSectionSql({ name: "n", table: "t", plain: ["id"], prefixes: ["x') or ('1'='1"], limit: 10 })).toThrow(/unsafe identifier/);
  });
});
