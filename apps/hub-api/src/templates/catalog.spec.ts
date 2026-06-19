import {
  TEMPLATES,
  templateMetaList,
  genSecret,
  buildTemplateEnv,
} from "./catalog";

describe("template catalog", () => {
  it("each template is well-formed and self-consistent", () => {
    for (const [key, tpl] of Object.entries(TEMPLATES)) {
      expect(tpl.slug).toBe(key);
      expect(tpl.name).toBeTruthy();
      expect(tpl.composeFile).toContain("services:");
      // every declared secret must be referenced in the compose file
      for (const s of tpl.secrets ?? []) {
        expect(tpl.composeFile).toContain(`\${${s}}`);
      }
    }
  });

  it("metadata list never leaks composeFile or secrets", () => {
    const metas = templateMetaList();
    expect(metas.length).toBe(Object.keys(TEMPLATES).length);
    for (const m of metas) {
      expect(m).not.toHaveProperty("composeFile");
      expect(m).not.toHaveProperty("secrets");
      expect(m.slug && m.name && m.icon).toBeTruthy();
    }
  });

  it("genSecret produces distinct alphanumeric secrets", () => {
    const a = genSecret();
    const b = genSecret();
    expect(a).toMatch(/^[a-zA-Z0-9]+$/);
    expect(a.length).toBeGreaterThanOrEqual(16);
    expect(a).not.toBe(b);
  });

  it("buildTemplateEnv fills every secret with a value plus static defaults", () => {
    const env = buildTemplateEnv(TEMPLATES.wordpress);
    expect(env.DB_PASSWORD).toMatch(/^[a-zA-Z0-9]+$/);
    expect(env.DB_ROOT_PASSWORD).toMatch(/^[a-zA-Z0-9]+$/);
    expect(env.DB_PASSWORD).not.toBe(env.DB_ROOT_PASSWORD);
  });

  it("buildTemplateEnv is empty for a template with no secrets/env", () => {
    expect(buildTemplateEnv(TEMPLATES.adminer)).toEqual({});
  });
});
