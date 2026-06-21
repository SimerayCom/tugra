import {
  TEMPLATES,
  templateMetaList,
  genSecret,
  buildTemplateEnv,
  type SecretSpec,
} from "./catalog";

const secretKey = (s: SecretSpec): string => (typeof s === "string" ? s : s.key);

// docker compose accepts both ${VAR} and $VAR — accept either reference form
const referencesSecret = (compose: string, key: string): boolean =>
  compose.includes(`\${${key}}`) ||
  new RegExp(`\\$${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_])`).test(compose);

describe("template catalog", () => {
  it("each template is well-formed and self-consistent", () => {
    for (const [key, tpl] of Object.entries(TEMPLATES)) {
      expect(tpl.slug).toBe(key);
      expect(tpl.name).toBeTruthy();
      expect(tpl.composeFile).toContain("services:");
      // every declared secret must be referenced in the compose file
      for (const s of tpl.secrets ?? []) {
        expect(`${key}:${referencesSecret(tpl.composeFile, secretKey(s))}`).toBe(`${key}:true`);
      }
    }
  });

  it("no unresolved Coolify magic tokens survive the import", () => {
    for (const [slug, tpl] of Object.entries(TEMPLATES)) {
      expect(`${slug}:${tpl.composeFile.includes("SERVICE_")}`).toBe(`${slug}:false`);
    }
  });

  it("ships no unsupported compose features (inline content / relative binds)", () => {
    for (const [slug, tpl] of Object.entries(TEMPLATES)) {
      expect(`${slug}:${/^\s*content:/m.test(tpl.composeFile)}`).toBe(`${slug}:false`);
      expect(`${slug}:${/source:\s*\.\.?\//.test(tpl.composeFile)}`).toBe(`${slug}:false`);
    }
  });

  it("every template publishes at least one host port", () => {
    for (const [slug, tpl] of Object.entries(TEMPLATES)) {
      expect(`${slug}:${/"\d+:\d+"/.test(tpl.composeFile)}`).toBe(`${slug}:true`);
    }
  });

  it("every template has an allowed category", () => {
    const allowed = new Set([
      "cms", "automation", "database", "monitoring", "tools",
      "analytics", "security", "productivity", "developer",
      "ai", "media", "communication", "finance",
    ]);
    for (const tpl of Object.values(TEMPLATES)) {
      expect(`${tpl.slug}:${allowed.has(tpl.category)}`).toBe(`${tpl.slug}:true`);
    }
  });

  it("published host ports are unique across the whole catalog", () => {
    const ports: string[] = [];
    for (const tpl of Object.values(TEMPLATES)) {
      // match published host ports in compose: `- "8080:80"` → 8080
      for (const m of tpl.composeFile.matchAll(/"(\d+):\d+"/g)) {
        ports.push(m[1]);
      }
    }
    expect(new Set(ports).size).toBe(ports.length);
  });

  it("ships a large catalog (bulk import + curated)", () => {
    expect(Object.keys(TEMPLATES).length).toBeGreaterThanOrEqual(100);
  });

  it("metadata list never leaks composeFile or secrets", () => {
    const metas = templateMetaList();
    expect(metas.length).toBe(Object.keys(TEMPLATES).length);
    for (const m of metas) {
      expect(m).not.toHaveProperty("composeFile");
      expect(m).not.toHaveProperty("secrets");
      expect(m.slug && m.name && m.category).toBeTruthy();
    }
  });

  it("genSecret produces distinct alphanumeric secrets", () => {
    const a = genSecret();
    const b = genSecret();
    expect(a).toMatch(/^[a-zA-Z0-9]+$/);
    expect(a.length).toBeGreaterThanOrEqual(16);
    expect(a).not.toBe(b);
  });

  it("genSecret honours kind and length variants", () => {
    expect(genSecret("hex", 64)).toMatch(/^[0-9a-f]{64}$/);
    expect(genSecret("alnum", 32)).toMatch(/^[a-zA-Z0-9]{32}$/);
    expect(genSecret("base64", 40).length).toBe(40);
    expect(/[!@#$%^&*\-_=+]/.test(genSecret("password-symbols", 24))).toBe(true);
  });

  it("buildTemplateEnv fills every secret with a value plus static defaults", () => {
    const env = buildTemplateEnv(TEMPLATES.wordpress);
    expect(env.DB_PASSWORD).toMatch(/^[a-zA-Z0-9]+$/);
    expect(env.DB_ROOT_PASSWORD).toMatch(/^[a-zA-Z0-9]+$/);
    expect(env.DB_PASSWORD).not.toBe(env.DB_ROOT_PASSWORD);
  });

  it("buildTemplateEnv fills typed secret descriptors from the import", () => {
    const withDesc = Object.values(TEMPLATES).find((t) =>
      (t.secrets ?? []).some((s) => typeof s !== "string"),
    );
    expect(withDesc).toBeTruthy();
    const env = buildTemplateEnv(withDesc!);
    for (const s of withDesc!.secrets ?? []) {
      const key = typeof s === "string" ? s : s.key;
      expect(env[key]).toBeTruthy();
    }
  });

  it("buildTemplateEnv is empty for a template with no secrets/env", () => {
    expect(buildTemplateEnv(TEMPLATES.adminer)).toEqual({});
  });
});
