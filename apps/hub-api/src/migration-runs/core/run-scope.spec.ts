import { applyScope, hostOfItemRef, resolveScope, type ScopePlan } from "./run-scope";
import { CreateMigrationRunSchema, RunScopeSchema } from "./dto";

const plan: ScopePlan = {
  items: [
    { itemRef: "app:srvA:web", kind: "app", name: "web", dependsOn: ["volume:srvA:web-data", "database:srvA:pg"] },
    { itemRef: "database:srvA:pg", kind: "database", name: "pg", dependsOn: [] },
    { itemRef: "service:srvA:meili", kind: "service", name: "meili", dependsOn: [] },
    { itemRef: "app:srvB:api", kind: "app", name: "api", dependsOn: ["volume:srvB:api-data"] },
    { itemRef: "database:srvB:redis", kind: "database", name: "redis", dependsOn: [] },
    { itemRef: "volume:srvA:web-data", kind: "volume", name: "web-data", dependsOn: [] },
    { itemRef: "volume:srvB:api-data", kind: "volume", name: "api-data", dependsOn: [] },
  ],
  preflight: { hosts: [{ ref: "srvA" }, { ref: "srvB" }, { ref: "srvC" }], projects: [{ ref: "p1", itemRefs: ["app:srvA:web", "database:srvA:pg"] }, { ref: "p2", itemRefs: ["app:srvB:api", "ghost:x:y"] }] },
};
const ok = (s: Parameters<typeof resolveScope>[1]) => {
  const r = resolveScope(plan, s);
  if ("fail" in r) throw new Error(r.fail);
  return r;
};

describe("hostOfItemRef", () => {
  it("reads the source server of an item ref", () => {
    expect(hostOfItemRef("app:srvA:web")).toBe("srvA");
    expect(hostOfItemRef("app:_:web")).toBe("_");
    expect(hostOfItemRef("weird")).toBe("_");
  });
});

describe("resolveScope", () => {
  it("a source server brings its apps, databases, services and the volumes they carry", () => {
    const r = ok({ sourceServers: ["srvA"] });
    expect([...r.inScope].sort()).toEqual(["app:srvA:web", "database:srvA:pg", "service:srvA:meili", "volume:srvA:web-data"]);
    expect(r).toMatchObject({ kept: 3, excluded: 2 });
  });

  it("projects bring their items; include adds on top, exclude always wins", () => {
    expect([...ok({ projects: ["p2"] }).inScope].sort()).toEqual(["app:srvB:api", "volume:srvB:api-data"]);
    expect([...ok({ projects: ["p2"], include: ["database:srvB:redis"] }).inScope].sort()).toEqual(["app:srvB:api", "database:srvB:redis", "volume:srvB:api-data"]);
    const r = ok({ sourceServers: ["srvA"], exclude: ["service:srvA:meili", "app:srvA:web"] });
    expect([...r.inScope]).toEqual(["database:srvA:pg"]);
    expect(r).toMatchObject({ kept: 1, excluded: 4 });
  });

  it("servers and projects together are a union", () => {
    expect(ok({ sourceServers: ["srvB"], projects: ["p1"] }).kept).toBe(4);
  });

  it("never ignores a name the plan does not have, and refuses a scope that keeps nothing", () => {
    expect(resolveScope(plan, { sourceServers: ["nope"] })).toEqual({ fail: "scope-unknown-server" });
    expect(resolveScope(plan, { projects: ["nope"] })).toEqual({ fail: "scope-unknown-project" });
    expect(resolveScope(plan, { include: ["app:srvA:ghost"] })).toEqual({ fail: "scope-unknown-item" });
    expect(resolveScope(plan, { sourceServers: ["srvA"], exclude: ["volume:srvA:web-data"] })).toEqual({ fail: "scope-unknown-item" });
    expect(resolveScope(plan, { sourceServers: ["srvC"] })).toEqual({ fail: "scope-empty" });
    expect(resolveScope(plan, { sourceServers: ["srvA"], exclude: ["app:srvA:web", "database:srvA:pg", "service:srvA:meili"] })).toEqual({ fail: "scope-empty" });
  });
});

describe("applyScope", () => {
  it("excludes every app and database outside the scope and skips the stacks outside it", () => {
    const r = ok({ sourceServers: ["srvA"] });
    const out = applyScope(plan, r.inScope, {});
    expect(out.mapping.items).toEqual({ "app:srvB:api": { include: false }, "database:srvB:redis": { include: false } });
    expect(out.serviceChoices).toBeUndefined();
    const b = applyScope(plan, ok({ sourceServers: ["srvB"] }).inScope, {});
    expect(b.serviceChoices).toEqual({ "service:srvA:meili": { skip: true } });
    expect(Object.keys(b.mapping.items).sort()).toEqual(["app:srvA:web", "database:srvA:pg"]);
  });

  it("keeps what the caller chose for the items that stay, and lets the scope win over a stale exclusion", () => {
    const r = ok({ sourceServers: ["srvA"] });
    const out = applyScope(plan, r.inScope, {
      mapping: { version: 1, items: { "app:srvA:web": { include: false, name: "Shop" }, "database:srvA:pg": { name: "main" } }, projects: {}, gitSources: {}, acks: [] },
      serviceChoices: { "service:srvA:meili": { name: "Search" }, "service:srvB:gone": { name: "X" } },
    });
    expect(out.mapping.items["app:srvA:web"]).toEqual({ name: "Shop" });
    expect(out.mapping.items["database:srvA:pg"]).toEqual({ name: "main" });
    expect(out.serviceChoices?.["service:srvA:meili"]).toEqual({ name: "Search" });
  });

  it("does not mutate its inputs", () => {
    const mapping = { version: 1 as const, items: { "app:srvA:web": { include: false } }, projects: {}, gitSources: {}, acks: [] };
    applyScope(plan, ok({ sourceServers: ["srvA"] }).inScope, { mapping });
    expect(mapping.items).toEqual({ "app:srvA:web": { include: false } });
  });
});

describe("the create body", () => {
  const base = { sessionId: "s1", sourceKind: "coolify", targetServerId: "srv", planHash: "d".repeat(32) };
  it("takes a scope, with serverMap, and refuses an empty one", () => {
    expect(CreateMigrationRunSchema.safeParse({ ...base, scope: { sourceServers: ["srvA"] }, serverMap: { srvA: "t1" } }).success).toBe(true);
    expect(RunScopeSchema.safeParse({}).success).toBe(false);
    expect(RunScopeSchema.safeParse({ exclude: ["app:a:b"] }).success).toBe(false);
    expect(RunScopeSchema.safeParse({ projects: ["p"], exclude: ["volume:a:b"] }).success).toBe(false);
    expect(RunScopeSchema.safeParse({ projects: ["p"], extra: 1 }).success).toBe(false);
  });
  it("is not combined with a mapping", () => {
    const mapping = { version: 1, items: {}, projects: {}, gitSources: {}, acks: [] };
    expect(CreateMigrationRunSchema.safeParse({ ...base, scope: { projects: ["p"] }, mapping, mappingHash: "a".repeat(32) }).success).toBe(false);
    expect(CreateMigrationRunSchema.safeParse({ ...base, mapping, mappingHash: "a".repeat(32) }).success).toBe(true);
  });
});
