import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { assertSafeCompose } from "../deploy/compose-safety";
import generated from "./catalog.generated.json";
import { TEMPLATES, type SecretSpec } from "./catalog";
import { EXTRA_PORT_BASE, EXTRA_SPECS, EXTRA_TEMPLATES, buildExtraTemplates } from "./catalog-extra";
import { rewriteHostPorts, substituteSelfUrls } from "./install-compose";
import { toManifest } from "./template-manifest";

const ICON_DIR = join(__dirname, "../../../web/public/icons");
const GENERATED = (generated as unknown as { templates: Record<string, { composeFile: string; name?: string }> }).templates;
const secretKey = (s: SecretSpec): string => (typeof s === "string" ? s : s.key);

interface ComposeDoc {
  services: Record<string, { image?: string; depends_on?: Record<string, unknown>; volumes?: string[]; ports?: string[]; healthcheck?: { test: string[] } }>;
  volumes?: Record<string, unknown>;
}
const doc = (slug: string): ComposeDoc => parse(EXTRA_TEMPLATES[slug].composeFile) as ComposeDoc;

describe("hand-written template catalog", () => {
  it("adds at least 76 templates on top of the earlier 284", () => {
    expect(EXTRA_SPECS.length).toBeGreaterThanOrEqual(76);
    expect(Object.keys(TEMPLATES).length).toBeGreaterThanOrEqual(360);
  });

  it("never reuses a generated slug, and slugs and names are unique", () => {
    for (const spec of EXTRA_SPECS) expect(`${spec.slug}:${spec.slug in GENERATED}`).toBe(`${spec.slug}:false`);
    expect(new Set(EXTRA_SPECS.map((s) => s.slug)).size).toBe(EXTRA_SPECS.length);
    expect(new Set(EXTRA_SPECS.map((s) => s.name.toLowerCase())).size).toBe(EXTRA_SPECS.length);
    const generatedNames = new Set(Object.values(GENERATED).map((g) => (g as { name?: string }).name?.toLowerCase()));
    for (const spec of EXTRA_SPECS) expect(`${spec.name}:${generatedNames.has(spec.name.toLowerCase())}`).toBe(`${spec.name}:false`);
  });

  it("keeps every earlier template id", () => {
    for (const slug of Object.keys(GENERATED)) expect(`${slug}:${slug in TEMPLATES}`).toBe(`${slug}:true`);
    for (const spec of EXTRA_SPECS) expect(`${spec.slug}:${spec.slug in TEMPLATES}`).toBe(`${spec.slug}:true`);
  });

  it("compiles to valid compose that passes the sandbox safety checks", () => {
    for (const slug of Object.keys(EXTRA_TEMPLATES)) {
      const d = doc(slug);
      expect(Object.keys(d.services).length).toBeGreaterThan(0);
      expect(() => assertSafeCompose(EXTRA_TEMPLATES[slug].composeFile)).not.toThrow();
    }
  });

  it("pins every image to a version tag (no latest, no bare name)", () => {
    for (const slug of Object.keys(EXTRA_TEMPLATES)) {
      for (const [name, svc] of Object.entries(doc(slug).services)) {
        expect(`${slug}/${name}:${/:[A-Za-z0-9._-]+$/.test(svc.image ?? "")}`).toBe(`${slug}/${name}:true`);
        expect(`${slug}/${name}:${/:(latest|main|master|edge|nightly)$/.test(svc.image ?? "")}`).toBe(`${slug}/${name}:false`);
      }
    }
  });

  it("declares every named volume and every depends_on target", () => {
    for (const slug of Object.keys(EXTRA_TEMPLATES)) {
      const d = doc(slug);
      const declared = new Set(Object.keys(d.volumes ?? {}));
      for (const [name, svc] of Object.entries(d.services)) {
        for (const v of svc.volumes ?? []) {
          const src = v.split(":")[0];
          expect(`${slug}/${name}/${src}:${declared.has(src)}`).toBe(`${slug}/${name}/${src}:true`);
        }
        for (const dep of Object.keys(svc.depends_on ?? {})) {
          expect(`${slug}/${name}->${dep}:${dep in d.services}`).toBe(`${slug}/${name}->${dep}:true`);
        }
      }
      for (const v of declared) {
        const used = Object.values(d.services).some((svc) => (svc.volumes ?? []).some((x) => x.startsWith(`${v}:`)));
        expect(`${slug}/${v}:${used}`).toBe(`${slug}/${v}:true`);
      }
    }
  });

  it("gives every template persistent storage unless it is stateless by design", () => {
    const stateless = new Set(["swagger-ui", "plantuml", "kroki", "whoami", "openspeedtest", "shlink-web-client", "element-web", "drawio", "tika", "kokoro-tts", "hasura", "ackee", "phpmyadmin", "pgweb", "mongo-express", "wekan", "yourls", "ghostfolio", "litellm"]);
    for (const slug of Object.keys(EXTRA_TEMPLATES)) {
      const hasVolume = Object.keys(doc(slug).volumes ?? {}).length > 0;
      expect(`${slug}:${hasVolume || stateless.has(slug)}`).toBe(`${slug}:true`);
    }
  });

  it("references each declared secret and generates a distinct, usable value", () => {
    for (const [slug, tpl] of Object.entries(EXTRA_TEMPLATES)) {
      const keys = (tpl.secrets ?? []).map(secretKey);
      expect(new Set(keys).size).toBe(keys.length);
      for (const k of keys) expect(`${slug}:${k}:${tpl.composeFile.includes(`\${${k}}`)}`).toBe(`${slug}:${k}:true`);
    }
  });

  it("publishes the web port first, on a unique host port from the hand-written range", () => {
    const seen = new Set<number>();
    for (const [slug, tpl] of Object.entries(EXTRA_TEMPLATES)) {
      const spec = EXTRA_SPECS.find((s) => s.slug === slug)!;
      const published = [...tpl.composeFile.matchAll(/"(\d+):(\d+)"/g)].map((m) => [Number(m[1]), Number(m[2])]);
      expect(published.length).toBe(1 + (spec.ports?.length ?? 0));
      expect(published[0][1]).toBe(spec.port);
      for (const [host] of published) {
        expect(host).toBeGreaterThanOrEqual(EXTRA_PORT_BASE);
        expect(seen.has(host)).toBe(false);
        seen.add(host);
      }
      const first = Object.entries(doc(slug).services)[0];
      expect(first[0]).toBe(slug);
      expect((first[1].ports ?? []).length).toBe(published.length);
      expect(tpl.exposure?.[0]).toMatchObject({ serviceName: slug, containerPort: spec.port, defaultMode: "domain", public: true });
      expect(tpl.exposure?.length).toBe(published.length);
    }
  });

  it("bakes self-URL tokens into localhost:<hostPort> and leaves none behind", () => {
    for (const tpl of Object.values(EXTRA_TEMPLATES)) {
      expect(tpl.composeFile).not.toMatch(/\{\{[A-Z]+\}\}/);
    }
    const planka = EXTRA_TEMPLATES.planka;
    const host = /"(\d+):1337"/.exec(planka.composeFile)![1];
    expect(planka.composeFile).toContain(`BASE_URL: "http://localhost:${host}"`);
  });

  it("every database sidecar has a healthcheck and the app waits for it", () => {
    for (const [slug, tpl] of Object.entries(EXTRA_TEMPLATES)) {
      const d = doc(slug);
      for (const name of ["db", "redis", "mongo", "clickhouse"]) {
        if (!(name in d.services)) continue;
        expect(`${slug}/${name}:${!!d.services[name].healthcheck}`).toBe(`${slug}/${name}:true`);
        expect(`${slug}/${name}:${name in (d.services[slug].depends_on ?? {})}`).toBe(`${slug}/${name}:true`);
      }
      expect(tpl.composeFile).not.toMatch(/privileged|docker\.sock|network_mode:\s*host/);
    }
  });

  it("vendored brand icons exist for every template that names one", () => {
    for (const [slug, tpl] of Object.entries(EXTRA_TEMPLATES)) {
      if (!tpl.logo) continue;
      const found = existsSync(join(ICON_DIR, `${tpl.logo}.svg`)) || existsSync(join(ICON_DIR, `${tpl.logo}.png`));
      expect(`${slug}:${found}`).toBe(`${slug}:true`);
    }
  });

  it("uses one plain sentence per description, with no hype or self-doubt wording", () => {
    const banned = /\b(seamless(ly)?|robust|effortless(ly)?|blazing|powerful|revolutionary|cutting-edge|beta|experimental|not yet|may break|only parity)\b/i;
    for (const spec of EXTRA_SPECS) {
      expect(`${spec.slug}:${spec.description.length >= 20 && spec.description.length <= 130}`).toBe(`${spec.slug}:true`);
      expect(`${spec.slug}:${/[.!?]./.test(spec.description.replace(/\.$/, "").replace(/\be\.g\./g, ""))}`).toBe(`${spec.slug}:false`);
      expect(spec.description.endsWith(".")).toBe(true);
      expect(`${spec.slug}:${banned.test(spec.description)}`).toBe(`${spec.slug}:false`);
      expect(spec.documentation.startsWith("https://")).toBe(true);
    }
  });

  it("ships no known-weak default credential literals", () => {
    for (const [slug, tpl] of Object.entries(EXTRA_TEMPLATES)) {
      expect(`${slug}:${/(PASSWORD|PASS|SECRET|TOKEN)\w*"?:\s*"(admin|password|changeme|secret|root|123456)"/i.test(tpl.composeFile)}`).toBe(`${slug}:false`);
    }
  });

  it("maps cleanly to the install manifest", () => {
    for (const [slug, tpl] of Object.entries(EXTRA_TEMPLATES)) {
      const m = toManifest(tpl);
      expect(m.slug).toBe(slug);
      expect((m.fields ?? []).length).toBe((tpl.secrets ?? []).length);
    }
  });

  it("buildExtraTemplates is deterministic", () => {
    expect(buildExtraTemplates()).toEqual(EXTRA_TEMPLATES);
  });

  it("survives the install-time port rewrite and self-URL swap", () => {
    const tpl = EXTRA_TEMPLATES.planka;
    const { compose, portMappings } = rewriteHostPorts(tpl.composeFile, tpl.exposure!, [34567]);
    expect(compose).toContain('"34567:1337"');
    expect(compose).toContain('BASE_URL: "http://localhost:34567"');
    const web = { service: "planka", port: 1337 };
    const withDomain = substituteSelfUrls(compose, portMappings, { domain: "boards.example.com", https: true, serverIp: null, web });
    expect(withDomain.compose).toContain('BASE_URL: "https://boards.example.com"');
    const withIp = substituteSelfUrls(compose, portMappings, { domain: null, https: false, serverIp: "203.0.113.7", web });
    expect(withIp.compose).toContain('BASE_URL: "http://203.0.113.7:34567"');
  });

  it("renumbers a template that publishes more than one port", () => {
    const tpl = EXTRA_TEMPLATES.mailpit;
    const { compose, portMappings } = rewriteHostPorts(tpl.composeFile, tpl.exposure!, [40001, 40002]);
    expect(compose).toContain('"40001:8025"');
    expect(compose).toContain('"40002:1025"');
    expect(portMappings.map((p) => p.mode)).toEqual(["domain", "hostPort"]);
  });
});
