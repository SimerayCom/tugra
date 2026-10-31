import { describe, it, expect } from "vitest";
import {
  CONFIG_CARDS,
  CONFIG_GROUPS,
  CONFIG_GROUP_KEYS,
  DEFAULT_CONFIG_GROUP,
  visibleConfigGroups,
  type ConfigGatingFacts,
} from "./config-groups";

/** A fully-visible GIT app (every group populated), overridable per-test. */
function facts(over: Partial<ConfigGatingFacts> = {}): ConfigGatingFacts {
  return {
    source: "GIT",
    isPreview: false,
    canWrite: true,
    clusterId: null,
    webhookToken: "tok",
    domain: "app.example.com",
    domainKind: "custom",
    volumes: [{ name: "data", path: "/data" }],
    hasConfigMounts: false,
    composePath: null,
    ...over,
  };
}

const keysOf = (f: ConfigGatingFacts) => visibleConfigGroups(f).map((g) => g.key);
const group = (f: ConfigGatingFacts, key: string) => visibleConfigGroups(f).find((g) => g.key === key);

describe("config-groups registry", () => {
  it("every card maps to a known group and each id appears exactly once", () => {
    const ids = CONFIG_CARDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length); // no dupes
    for (const c of CONFIG_CARDS) {
      expect(CONFIG_GROUP_KEYS).toContain(c.group);
    }
  });

  it("general is always first and present, and is the default group", () => {
    expect(CONFIG_GROUPS[0].key).toBe("general");
    expect(DEFAULT_CONFIG_GROUP).toBe("general");
    // even a locked-down COMPOSE preview app keeps General (EnvironmentCard always renders)
    expect(keysOf(facts({ source: "COMPOSE", isPreview: true, webhookToken: null, domain: null }))[0]).toBe("general");
  });
});

describe("visibleConfigGroups", () => {
  it("shows all 7 groups for a GIT app with a domain and volumes", () => {
    expect(keysOf(facts())).toEqual([
      "general",
      "build",
      "environment",
      "domains",
      "storage",
      "health-resources",
      "automation",
    ]);
  });

  it("emits groups in CONFIG_GROUPS order", () => {
    const order = CONFIG_GROUPS.map((g) => g.key);
    const got = keysOf(facts());
    expect(got).toEqual(order.filter((k) => got.includes(k)));
  });

  it("COMPOSE (writable, not preview) shows general, build, environment and domains via expose", () => {
    const f = facts({ source: "COMPOSE", webhookToken: null, domain: null, domainKind: null, volumes: [] });
    expect(keysOf(f)).toEqual(["general", "build", "environment", "domains"]);
    // general holds only the always-on cards (environment + tags), build only credentials
    expect(group(f, "general")!.cardIds).toEqual(["environment", "tags"]);
    expect(group(f, "build")!.cardIds).toEqual(["credentials"]);
    expect(group(f, "environment")!.cardIds).toEqual(["env"]);
    expect(group(f, "domains")!.cardIds).toEqual(["expose", "serviceDomains"]); // compose gains per-service domains
  });

  it("a locked-down COMPOSE preview app collapses to general, build, environment", () => {
    const f = facts({ source: "COMPOSE", isPreview: true, webhookToken: null, domain: null, domainKind: null, volumes: [] });
    expect(keysOf(f)).toEqual(["general", "build", "environment"]);
    // preview hides tags, so general is just environment
    expect(group(f, "general")!.cardIds).toEqual(["environment"]);
  });

  it("COMPOSE with a webhook token surfaces automation with only webhooks", () => {
    const f = facts({ source: "COMPOSE", domain: null, domainKind: null, volumes: [] });
    expect(keysOf(f)).toContain("automation");
    expect(group(f, "automation")!.cardIds).toEqual(["webhooks"]);
  });

  it("isPreview hides tags, preview and expose", () => {
    const f = facts({ isPreview: true });
    expect(group(f, "general")!.cardIds).not.toContain("tags");
    expect(group(f, "automation")!.cardIds).not.toContain("preview");
    expect(group(f, "domains")?.cardIds ?? []).not.toContain("expose");
  });

  it("domainOptions appears only when a domain is set", () => {
    expect(group(facts(), "domains")!.cardIds).toContain("domainOptions");
    expect(group(facts({ domain: null }), "domains")?.cardIds ?? []).not.toContain("domainOptions");
  });

  it("customCert needs a domain, write access and a non-preview app", () => {
    expect(group(facts(), "domains")!.cardIds).toContain("customCert");
    expect(group(facts({ domain: null }), "domains")?.cardIds ?? []).not.toContain("customCert");
    expect(group(facts({ isPreview: true }), "domains")?.cardIds ?? []).not.toContain("customCert");
    expect(group(facts({ canWrite: false }), "domains")?.cardIds ?? []).not.toContain("customCert");
  });

  it("volumeBackups appears only when there is at least one volume", () => {
    expect(group(facts(), "storage")!.cardIds).toContain("volumeBackups");
    expect(group(facts({ volumes: [] }), "storage")!.cardIds).not.toContain("volumeBackups");
  });

  it("buildArgs is GIT-only", () => {
    expect(group(facts(), "build")!.cardIds).toContain("buildArgs");
    expect(group(facts({ source: "DOCKERFILE" }), "build")?.cardIds ?? []).not.toContain("buildArgs");
  });

  it("source card edits non-compose apps and needs write + non-preview", () => {
    expect(group(facts(), "build")!.cardIds).toContain("source"); // GIT
    expect(group(facts({ source: "IMAGE" }), "build")!.cardIds).toContain("source");
    expect(group(facts({ source: "COMPOSE", domain: null, domainKind: null, volumes: [] }), "build")?.cardIds ?? []).not.toContain("source"); // pasted compose
    expect(group(facts({ isPreview: true }), "build")?.cardIds ?? []).not.toContain("source");
    expect(group(facts({ canWrite: false }), "build")?.cardIds ?? []).not.toContain("source");
  });

  it("source card ALSO edits a git-compose app (composePath set) — repo/branch/path", () => {
    const gc = { source: "COMPOSE", composePath: "docker-compose.yml", domain: null, domainKind: null, volumes: [] } as const;
    expect(group(facts(gc), "build")!.cardIds).toContain("source");
    expect(group(facts({ ...gc, isPreview: true }), "build")?.cardIds ?? []).not.toContain("source");
    expect(group(facts({ ...gc, canWrite: false }), "build")?.cardIds ?? []).not.toContain("source");
  });

  it("build card is GIT-only and needs write + non-preview", () => {
    expect(group(facts(), "build")!.cardIds).toContain("build");
    expect(group(facts({ source: "IMAGE" }), "build")?.cardIds ?? []).not.toContain("build");
    expect(group(facts({ isPreview: true }), "build")?.cardIds ?? []).not.toContain("build");
    expect(group(facts({ canWrite: false }), "build")?.cardIds ?? []).not.toContain("build");
  });

  it("extraDomains needs a primary domain, write access, non-preview and a non-clustered app", () => {
    expect(group(facts(), "domains")!.cardIds).toContain("extraDomains");
    expect(group(facts({ domain: null }), "domains")?.cardIds ?? []).not.toContain("extraDomains");
    expect(group(facts({ isPreview: true }), "domains")?.cardIds ?? []).not.toContain("extraDomains");
    expect(group(facts({ canWrite: false }), "domains")?.cardIds ?? []).not.toContain("extraDomains");
    expect(group(facts({ clusterId: "c1" }), "domains")!.cardIds).not.toContain("extraDomains");
  });

  it("serviceDomains is COMPOSE-only (+ write, non-preview, non-clustered)", () => {
    expect(group(facts({ source: "COMPOSE", domain: null, domainKind: null, volumes: [] }), "domains")!.cardIds).toContain("serviceDomains");
    expect(group(facts(), "domains")?.cardIds ?? []).not.toContain("serviceDomains"); // GIT app
    expect(group(facts({ source: "COMPOSE", isPreview: true, domain: null, domainKind: null, volumes: [] }), "domains")?.cardIds ?? []).not.toContain("serviceDomains");
    expect(group(facts({ source: "COMPOSE", clusterId: "c1", domain: null, domainKind: null, volumes: [] }), "domains")?.cardIds ?? []).not.toContain("serviceDomains");
  });

  it("domain card needs a custom domainKind", () => {
    expect(group(facts(), "domains")!.cardIds).toContain("domain");
    expect(group(facts({ domainKind: "auto" }), "domains")!.cardIds).not.toContain("domain");
  });

  it("databaseLinks shows for a classic app and hides for compose / swarm / preview", () => {
    expect(group(facts(), "environment")!.cardIds).toEqual(["env", "databaseLinks"]);
    expect(group(facts({ source: "COMPOSE" }), "environment")!.cardIds).toEqual(["env"]);
    expect(group(facts({ clusterId: "c1" }), "environment")!.cardIds).toEqual(["env"]);
    expect(group(facts({ isPreview: true }), "environment")!.cardIds).toEqual(["env"]);
  });

  it("deployHooks shows for a classic app and hides for compose / swarm / preview", () => {
    expect(group(facts(), "automation")!.cardIds).toContain("deployHooks");
    expect(group(facts({ source: "COMPOSE", domain: null, domainKind: null, volumes: [] }), "automation")?.cardIds ?? []).not.toContain("deployHooks");
    expect(group(facts({ clusterId: "c1" }), "automation")!.cardIds).not.toContain("deployHooks");
    expect(group(facts({ isPreview: true }), "automation")!.cardIds).not.toContain("deployHooks");
  });
});
