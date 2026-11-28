import { planImport } from "./import-planner";
import { buildPreflight } from "./preflight";
import { loadServiceFixtures } from "./testing/service-fixtures";
import type { ForeignFleet } from "./foreign-fleet";

/**
 * The exact image of an item is part of the APPLY INPUT (`imagePins`, `serviceChoices[].pins`), never of the plan. These specs freeze the
 * plan hash of a fleet with every real service shape, an image app and databases: a plan with no digests must hash exactly as it did before
 * the exact-image work, or every reviewed plan, API-token caller and older agent would meet a 409 on a plan nothing changed in.
 */
const fleet = (): ForeignFleet => ({
  servers: [{ ref: "srv-a", name: "box", ip: "1.2.3.4" }],
  apps: [
    { sourceRef: "img-1", name: "search", kind: "image", buildPack: "image", image: "getmeili/meilisearch:latest", serverRef: "srv-a", env: [], volumes: [], domains: [] },
    { sourceRef: "img-2", name: "cache-ui", kind: "image", buildPack: "image", image: "redis:7.2", serverRef: "srv-a", env: [], volumes: [], domains: [] },
  ],
  databases: [
    { sourceRef: "db-1", name: "orders", engine: "POSTGRES", version: "16", image: "postgres:16-alpine", serverRef: "srv-a" },
    { sourceRef: "db-2", name: "sessions", engine: "REDIS", version: "7", serverRef: "srv-a" },
  ],
  services: loadServiceFixtures().map((f) => f.svc),
  volumes: [],
  sharedEnv: [],
  warnings: [],
});

describe("the plan hash does not know about exact images", () => {
  it("is the value it had before the exact-image work (frozen)", () => {
    expect(planImport(fleet(), { sourceKind: "coolify" }).planHash).toBe("b67408ef55019707173a577be4dce31a");
  });
  it("is the same hash however many exact images the apply input carries: the pins are not read by the plan", () => {
    const a = planImport(fleet(), { sourceKind: "coolify" });
    const b = planImport(fleet(), { sourceKind: "coolify" });
    expect(a.planHash).toBe(b.planHash);
    expect(JSON.stringify(a.items)).not.toMatch(/sha256:|exact|imagePins/);
  });
  it("the stack's member images live in the preflight, which is outside the hash (additive), and are the source's own refs", () => {
    const pre = buildPreflight(fleet(), { sourceKind: "coolify" });
    const withImages = (pre.services ?? []).filter((s) => (s.images ?? []).length > 0);
    expect(withImages.length).toBeGreaterThan(0);
    for (const s of withImages) for (const m of s.images ?? []) expect(m.image).not.toContain("@sha256:");
    expect(planImport(fleet(), { sourceKind: "coolify" }).planHash).toBe(planImport(fleet(), { sourceKind: "coolify" }).planHash);
  });
});
