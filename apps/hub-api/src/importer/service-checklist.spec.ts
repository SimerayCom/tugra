import { buildServiceChecklist } from "./service-checklist";
import { transformServiceCompose } from "./import-service-map";
import { fixtureByName, SIGNOZ_FILES } from "./testing/service-fixtures";

const build = (name: string, choice?: Parameters<typeof buildServiceChecklist>[2], outcome?: Parameters<typeof buildServiceChecklist>[3], files = SIGNOZ_FILES) => {
  const f = fixtureByName(name);
  const res = transformServiceCompose({ svc: f.svc, raw: f.raw.docker_compose_raw!, bundle: { values: {}, files }, choice });
  return buildServiceChecklist(f.svc, res, choice, outcome);
};
const kinds = (xs: ReturnType<typeof build>) => xs.map((x) => x.kind);

describe("buildServiceChecklist", () => {
  it("meilisearch: deploy-after-data first, data + quiesce for its volume, internal-only reach/repoint, unpinned image", () => {
    const c = build("alpha-meilisearch", undefined, { network: { network: "svc-alpha-meilisearch", alias: "meilisearch" } });
    expect(kinds(c)).toEqual(["deploy-after-data", "data-step", "quiesce", "reach", "repoint-dependents", "unpinned-image"]);
    expect(c[1].params).toEqual({ volumes: ["meilisearch-data"], manualLarge: [] });
    expect(c[2].params).toEqual({ members: ["meilisearch"] });
    expect(c[3].params).toEqual({ network: "svc-alpha-meilisearch", alias: "meilisearch" });
  });

  it("reach is manual when no private network was attached", () => {
    expect(build("alpha-meilisearch").find((i) => i.kind === "reach")!.params).toEqual({ manual: 1 });
  });

  it("cloudflared: tunnel item, no reach/repoint (nothing listens)", () => {
    const c = build("cloudflared-hub");
    expect(kinds(c)).toEqual(["deploy-after-data", "tunnel", "unpinned-image"]);
  });

  it("a mapped domain gives a dns item (hosts + target ip), no reach", () => {
    const c = build("beszel-hub", undefined, { targetIp: "203.0.113.9" });
    const dns = c.find((i) => i.kind === "dns")!;
    expect(dns.params).toEqual({ hosts: ["monitor.example.test"], targetIp: "203.0.113.9" });
    expect(kinds(c)).not.toContain("reach");
    expect(c.find((i) => i.kind === "not-carried")!.params).toEqual({ members: ["beszel-agent"], volumes: [] });
  });

  it("signoz: not-carried names the clickhouse volume; hostnameMap shows in dns", () => {
    const c = build("signoz-hub", { hostnameMap: { "signoz.example.test": "obs.example.test" } });
    expect(c.find((i) => i.kind === "not-carried")!.params).toEqual({ members: [], volumes: ["clickhouse"] });
    expect((c.find((i) => i.kind === "dns")!.params.hosts as string[])).toContain("obs.example.test");
  });

  it("is deterministic, uses the chosen name, and carries nothing but kinds, keys, hostnames and numbers", () => {
    const a = build("alpha-meilisearch", { name: "My Search" });
    expect(JSON.stringify(a)).toBe(JSON.stringify(build("alpha-meilisearch", { name: "My Search" })));
    expect(a[0].params).toEqual({ name: "My Search" });
    expect(JSON.stringify(a)).not.toMatch(/password|secret|token|http/i);
  });
});
