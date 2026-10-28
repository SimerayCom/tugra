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
    expect(group(f, "domains")!.cardIds).toEqual(["expose"]);
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

  it("volumeBackups appears only when there is at least one volume", () => {
    expect(group(facts(), "storage")!.cardIds).toContain("volumeBackups");
    expect(group(facts({ volumes: [] }), "storage")!.cardIds).not.toContain("volumeBackups");
  });

  it("buildArgs is GIT-only", () => {
    expect(group(facts(), "build")!.cardIds).toContain("buildArgs");
    expect(group(facts({ source: "DOCKERFILE" }), "build")?.cardIds ?? []).not.toContain("buildArgs");
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
