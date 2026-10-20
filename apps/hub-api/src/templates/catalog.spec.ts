import {
  TEMPLATES,
  templateMetaList,
  buildCatalog,
  genSecret,
  buildTemplateEnv,
  type SecretSpec,
  type TemplateDef,
} from "./catalog";
import { TEMPLATE_META_OVERLAY, deriveBadges } from "./catalog-meta";
import { publicManifest, toManifest, validateConfigMountTarget } from "./template-manifest";

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
      // every declared secret must be referenced in the compose file OR in a config-mount body
      for (const s of tpl.secrets ?? []) {
        const sk = secretKey(s);
        const referenced =
          referencesSecret(tpl.composeFile, sk) || (tpl.mounts ?? []).some((m) => referencesSecret(m.content, sk));
        expect(`${key}:${sk}:${referenced}`).toBe(`${key}:${sk}:true`);
      }
    }
  });

  it("no unresolved Coolify magic tokens survive the import", () => {
    // A boundary-delimited SERVICE_ token is unresolved; a legit env var NAME that merely contains
    // "SERVICE_" (e.g. PDS_REPORT_SERVICE_FQDN, WEBSERVICE_PASSWORD) is fine.
    for (const [slug, tpl] of Object.entries(TEMPLATES)) {
      expect(`${slug}:${/(?<![A-Za-z0-9_])SERVICE_[A-Z0-9_]+/.test(tpl.composeFile)}`).toBe(`${slug}:false`);
    }
  });

  it("ships no unsupported compose features (inline content / relative binds)", () => {
    for (const [slug, tpl] of Object.entries(TEMPLATES)) {
      expect(`${slug}:${/^\s*content:/m.test(tpl.composeFile)}`).toBe(`${slug}:false`);
      expect(`${slug}:${/source:\s*\.\.?\//.test(tpl.composeFile)}`).toBe(`${slug}:false`);
    }
  });

  it("every template publishes a host port, unless it is a portless config-mount building block", () => {
    for (const [slug, tpl] of Object.entries(TEMPLATES)) {
      const publishes = /"\d+:\d+"/.test(tpl.composeFile);
      // A data-store like redis may legitimately publish no port (consumed over the compose network or
      // exposed manually); such a template must at least carry config mounts to justify the install.
      const portlessMountOnly = !publishes && !!(tpl.mounts && tpl.mounts.length);
      expect(`${slug}:${publishes || portlessMountOnly}`).toBe(`${slug}:true`);
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

  it("ships a large catalog (bulk import + curated) including v2-recovered templates", () => {
    expect(Object.keys(TEMPLATES).length).toBeGreaterThanOrEqual(260); // importer v2 recovered ~31 more
  });

  it("every generated template carries exposure metadata pointing at a real service + container port", () => {
    for (const [slug, tpl] of Object.entries(TEMPLATES)) {
      for (const e of tpl.exposure ?? []) {
        // the exposed service exists in the compose and the container port is a positive integer
        expect(`${slug}:${new RegExp(`^\\s+${e.serviceName}:`, "m").test(tpl.composeFile)}`).toBe(`${slug}:true`);
        expect(Number.isInteger(e.containerPort) && e.containerPort > 0).toBe(true);
      }
    }
  });

  it("never leaves an inline content mount in the compose (recovered into mounts[] metadata)", () => {
    for (const [slug, tpl] of Object.entries(TEMPLATES)) {
      // any recovered mount is metadata, never a raw `content:` line in the compose
      expect(`${slug}:${/^\s*content:/m.test(tpl.composeFile)}`).toBe(`${slug}:false`);
      for (const m of tpl.mounts ?? []) {
        expect(m.serviceName && m.target && typeof m.content === "string").toBeTruthy();
      }
    }
  });

  it("every curated mount target is a safe absolute path", () => {
    for (const tpl of Object.values(TEMPLATES)) {
      for (const m of tpl.mounts ?? []) {
        expect(() => validateConfigMountTarget(m.target)).not.toThrow();
      }
    }
  });

  it("ships the redis proof template with a config mount whose content is never exposed to the form", () => {
    const redis = TEMPLATES["redis"];
    expect(redis).toBeTruthy();
    expect(redis.mounts?.[0]).toMatchObject({ serviceName: "redis", target: "/usr/local/etc/redis/redis.conf" });
    expect(redis.mounts?.[0].content).toContain("${REDIS_PASSWORD}"); // placeholder, resolved at deploy
    // the public (form) manifest drops the mount content — no config body leaks to the client
    const p = publicManifest(toManifest(redis), false);
    expect(p.mounts).toEqual([{ serviceName: "redis", target: "/usr/local/etc/redis/redis.conf", mode: "0644" }]);
    expect(JSON.stringify(p)).not.toContain("requirepass");
  });

  it("buildCatalog overlays a remote set but a curated slug always wins", () => {
    const fake = (slug: string, name: string): TemplateDef => ({
      slug, name, description: "d", category: "tools", composeFile: "services:\n  x:\n    image: y\n",
    });
    const merged = buildCatalog({ brandnew: fake("brandnew", "Brand New"), wordpress: fake("wordpress", "EVIL") });
    expect(merged.brandnew?.name).toBe("Brand New"); // remote adds a new slug
    expect(merged.wordpress?.name).toBe("WordPress"); // curated wins — remote can't shadow it
    // no-arg buildCatalog == the bundled TEMPLATES
    expect(Object.keys(buildCatalog()).sort()).toEqual(Object.keys(TEMPLATES).sort());
  });

  it("most templates carry a documentation URL", () => {
    const withDoc = Object.values(TEMPLATES).filter((t) => t.documentation).length;
    expect(withDoc).toBeGreaterThanOrEqual(100);
    for (const t of Object.values(TEMPLATES)) {
      if (t.documentation) expect(t.documentation.startsWith("http")).toBe(true);
    }
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

  // ── presentation overlay (tagline/tags/featured/badges) ──

  it("every overlay slug is a real catalog slug (a typo fails here, not silently)", () => {
    for (const slug of Object.keys(TEMPLATE_META_OVERLAY)) {
      expect(`${slug}:${slug in TEMPLATES}`).toBe(`${slug}:true`);
    }
  });

  it("marks a healthy set of featured templates", () => {
    const featured = templateMetaList().filter((m) => m.featured);
    expect(featured.length).toBeGreaterThanOrEqual(10);
    // featured implies the overlay set it
    for (const m of featured) expect(TEMPLATE_META_OVERLAY[m.slug]?.featured).toBe(true);
  });

  it("merges the overlay tagline/tags/featured onto a template's meta", () => {
    const nc = templateMetaList().find((m) => m.slug === "nextcloud")!;
    expect(nc.tagline).toBeTruthy();
    expect(nc.tags).toContain("files");
    expect(nc.featured).toBe(true);
  });

  it("derives a 'db' badge for a stack that bundles a database, and none for a db-less app", () => {
    expect(deriveBadges(TEMPLATES.wordpress.composeFile)).toContain("db"); // mariadb
    expect(deriveBadges(TEMPLATES.directus.composeFile)).toContain("db"); // postgres
    expect(deriveBadges(TEMPLATES.adminer.composeFile)).not.toContain("db"); // ui only
    expect(deriveBadges(TEMPLATES.redis.composeFile)).not.toContain("db"); // cache, not a db badge
    // and it surfaces on the public meta
    expect(templateMetaList().find((m) => m.slug === "wordpress")!.badges).toContain("db");
  });

  it("overlay fields never introduce a composeFile/secrets leak into the meta", () => {
    for (const m of templateMetaList()) {
      expect(m).not.toHaveProperty("composeFile");
      expect(m).not.toHaveProperty("secrets");
    }
  });
});
