import { ImportApplySchema, ImportPlanRequestSchema, ImportTestSchema, RUN_SOURCE_KINDS, REMOTE_SOURCE_KINDS, ImportConnectAgentSchema, ImportConnectSchema, ImportMappingPutSchema, ImportMappingResolveSchema, ImportServicesPreviewSchema, ServiceChoiceSchema, ServiceChoicesSchema } from "./dto";

describe("ServiceChoiceSchema", () => {
  const ok = (v: unknown) => ServiceChoiceSchema.safeParse(v).success;

  it("accepts every documented choice", () => {
    expect(
      ok({
        skip: false,
        name: "My Search 1",
        environmentId: "env1",
        targetServerId: "srv2",
        serviceDomains: [{ service: "web", hostname: "a.example.test", port: 8080 }],
        hostnameMap: { "old.example.test": "new.example.test" },
        volumes: { "minio-data": { policy: "copy", owner: { uid: 1000, gid: 1000 } } },
        dropMembers: ["agent"],
        pinImages: false,
        pins: { meilisearch: "getmeili/meilisearch:v1.12.3" },
        privateNetwork: false,
        hold: true,
      }),
    ).toBe(true);
    expect(ok({})).toBe(true);
  });

  it("is strict: unknown keys are rejected", () => {
    expect(ok({ nope: 1 })).toBe(false);
    expect(ok({ volumes: { "minio-data": { policy: "copy", extra: 1 } } })).toBe(false);
    expect(ok({ serviceDomains: [{ service: "web", hostname: "a.example.test", port: 80, extra: 1 }] })).toBe(false);
    expect(ok({ volumes: { "minio-data": { policy: "copy", owner: { uid: 1, gid: 2, extra: 3 } } } })).toBe(false);
  });

  it("enforces caps and charsets", () => {
    expect(ok({ name: "bad/name" })).toBe(false);
    expect(ok({ name: "x".repeat(64) })).toBe(false);
    expect(ok({ serviceDomains: Array.from({ length: 21 }, (_, i) => ({ service: "a", hostname: `h${i}.example.test`, port: 80 })) })).toBe(false);
    expect(ok({ serviceDomains: [{ service: "a b", hostname: "a.example.test", port: 80 }] })).toBe(false);
    expect(ok({ serviceDomains: [{ service: "a", hostname: "A.Example.Test", port: 80 }] })).toBe(false); // lowercase only
    expect(ok({ serviceDomains: [{ service: "a", hostname: "nodots", port: 80 }] })).toBe(false);
    expect(ok({ serviceDomains: [{ service: "a", hostname: "a.example.test", port: 70000 }] })).toBe(false);
    expect(ok({ volumes: { "Bad Name": { policy: "copy" } } })).toBe(false);
    expect(ok({ volumes: { v: { policy: "wipe" } } })).toBe(false);
    expect(ok({ volumes: { v: { policy: "copy", owner: { uid: 70000, gid: 0 } } } })).toBe(false);
    expect(ok({ dropMembers: Array.from({ length: 33 }, () => "a") })).toBe(false);
    expect(ok({ pins: { a: "not an image ref!" } })).toBe(false);
    expect(ok({ pins: { a: "x/y:1; rm -rf /" } })).toBe(false);
    expect(ok({ hostnameMap: { "not a host": "a.example.test" } })).toBe(false);
  });

  it("serviceChoices: at most 64 entries; wired into the coolify/dokploy apply but not local-docker", () => {
    const many = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`service:s:${i}`, {}]));
    expect(ServiceChoicesSchema.safeParse(many).success).toBe(false);
    const base = { sessionId: "s", targetServerId: "t", planHash: "a".repeat(32) };
    expect(ImportApplySchema.safeParse({ sourceKind: "coolify", ...base, serviceChoices: { "service:s:1": { skip: true } } }).success).toBe(true);
    expect(ImportApplySchema.safeParse({ sourceKind: "coolify", ...base, serviceChoices: { "service:s:1": { bogus: true } } }).success).toBe(false);
    expect(ImportApplySchema.safeParse({ sourceKind: "local-docker", serverId: "x", planHash: "a".repeat(32), serviceChoices: {} }).success).toBe(true); // zod strips the unknown key on a non-strict object
  });

  it("the preview body takes a session and optional choices", () => {
    expect(ImportServicesPreviewSchema.safeParse({ sessionId: "s" }).success).toBe(true);
    expect(ImportServicesPreviewSchema.safeParse({ sessionId: "s", choices: { "service:s:1": { name: "x" } } }).success).toBe(true);
    expect(ImportServicesPreviewSchema.safeParse({ choices: {} }).success).toBe(false);
  });
});

const H = "a".repeat(32);
const base = { sourceKind: "coolify", sessionId: "s", targetServerId: "t", planHash: H };
const mapping = { version: 1, items: { "app:srv:a": { name: "x" } } };

describe("ImportApplySchema — editable mapping fields", () => {
  it("an old call shape (no mapping fields) still parses unchanged", () => {
    expect(ImportApplySchema.parse(base)).toEqual(base);
    expect(ImportApplySchema.parse({ sourceKind: "local-docker", serverId: "s", planHash: H })).toEqual({ sourceKind: "local-docker", serverId: "s", planHash: H });
  });
  it("mapping and mappingHash travel together (refine)", () => {
    expect(ImportApplySchema.safeParse({ ...base, mapping }).success).toBe(false);
    expect(ImportApplySchema.safeParse({ ...base, mappingHash: H }).success).toBe(false);
    const ok = ImportApplySchema.safeParse({ ...base, mapping, mappingHash: H, reconcile: true, saveMapping: false, ignoreStoredMapping: false });
    expect(ok.success).toBe(true);
    if (ok.success && ok.data.sourceKind === "coolify") expect(ok.data.mapping?.items["app:srv:a"]).toEqual({ name: "x" });
  });
  it("is strict inside the document and validates the hash shape", () => {
    expect(ImportApplySchema.safeParse({ ...base, mapping: { version: 1, rules: [] }, mappingHash: H }).success).toBe(false);
    expect(ImportApplySchema.safeParse({ ...base, mapping, mappingHash: "nope" }).success).toBe(false);
  });
  it("local-docker never takes a mapping (stripped, byte-identical behaviour)", () => {
    const r = ImportApplySchema.parse({ sourceKind: "local-docker", serverId: "s", planHash: H, mapping, mappingHash: H });
    expect(Object.keys(r)).not.toContain("mapping");
  });
});

describe("ImportConnectSchema.scopeLabel", () => {
  const c = { sourceKind: "coolify", teamId: "t", baseUrl: "https://c.example.com", token: "x" };
  it("optional, lowercase label charset only", () => {
    expect(ImportConnectSchema.parse(c)).toEqual(c);
    expect(ImportConnectSchema.parse({ ...c, scopeLabel: "team-3.prod_a" }).scopeLabel).toBe("team-3.prod_a");
    expect(ImportConnectSchema.safeParse({ ...c, scopeLabel: "Team 3" }).success).toBe(false);
    expect(ImportConnectSchema.safeParse({ ...c, scopeLabel: "a".repeat(65) }).success).toBe(false);
  });
});

describe("resolve / put bodies", () => {
  it("resolve requires the mapping document and a planHash", () => {
    const body = { sessionId: "s", sourceKind: "dokploy", planHash: H, targetServerId: "t", mapping };
    expect(ImportMappingResolveSchema.safeParse(body).success).toBe(true);
    expect(ImportMappingResolveSchema.safeParse({ ...body, mapping: undefined }).success).toBe(false);
    expect(ImportMappingResolveSchema.safeParse({ ...body, sourceKind: "local-docker" }).success).toBe(false);
  });
  it("put validates SHAPE only (a name over the cap is a resolve conflict, not a save error)", () => {
    expect(ImportMappingPutSchema.safeParse({ mapping: { version: 1, items: { "app:s:a": { name: "x".repeat(150) } } } }).success).toBe(true);
    expect(ImportMappingPutSchema.safeParse({ mapping: { version: 1, items: { "app:s:a": { bogus: 1 } } } }).success).toBe(false);
    expect(ImportMappingPutSchema.safeParse({ mapping, expectedVersion: 0 }).success).toBe(false);
  });
});

describe("ImportConnectAgentSchema (Coolify read through the agent)", () => {
  const ok = (v: unknown) => ImportConnectAgentSchema.safeParse(v).success;

  it("takes a team and a server, nothing else that matters: no token and no URL exist on this path", () => {
    expect(ok({ sourceKind: "coolify", teamId: "t1", serverId: "s1" })).toBe(true);
    expect(ok({ sourceKind: "coolify", teamId: "t1", serverId: "s1", scopeLabel: "acme" })).toBe(true);
    const parsed = ImportConnectAgentSchema.parse({ sourceKind: "coolify", teamId: "t1", serverId: "s1", token: "T", baseUrl: "https://x.example.com" });
    expect(parsed).toEqual({ sourceKind: "coolify", teamId: "t1", serverId: "s1" }); // a smuggled token or URL is dropped, never carried
  });

  it("is Coolify only, and needs both ids", () => {
    expect(ok({ sourceKind: "dokploy", teamId: "t1", serverId: "s1" })).toBe(false);
    expect(ok({ sourceKind: "coolify", teamId: "t1" })).toBe(false);
    expect(ok({ sourceKind: "coolify", serverId: "s1" })).toBe(false);
    expect(ok({ sourceKind: "coolify", teamId: "", serverId: "s1" })).toBe(false);
  });

  it("keeps the scope label to the same charset as the token path", () => {
    expect(ok({ sourceKind: "coolify", teamId: "t1", serverId: "s1", scopeLabel: "Bad Label!" })).toBe(false);
  });
});

describe("CapRover source kind", () => {
  it("is a remote kind: connect and test take the dashboard password as the token", () => {
    expect(REMOTE_SOURCE_KINDS).toContain("caprover");
    const c = { sourceKind: "caprover", teamId: "t1", baseUrl: "https://captain.example.com", token: "dashboard-password" };
    expect(ImportConnectSchema.safeParse(c).success).toBe(true);
    expect(ImportTestSchema.safeParse(c).success).toBe(true);
    expect(ImportConnectSchema.safeParse({ ...c, token: "" }).success).toBe(false);
    expect(ImportConnectSchema.safeParse({ ...c, baseUrl: "not a url" }).success).toBe(false);
  });

  it("plans and applies like the other remote kinds", () => {
    expect(ImportPlanRequestSchema.safeParse({ sourceKind: "caprover", sessionId: "s1" }).success).toBe(true);
    expect(ImportApplySchema.safeParse({ sourceKind: "caprover", sessionId: "s1", targetServerId: "t1", planHash: "a".repeat(32) }).success).toBe(true);
    expect(ImportApplySchema.safeParse({ sourceKind: "caprover", sessionId: "s1", targetServerId: "t1", planHash: "short" }).success).toBe(false);
  });

  it("guided migration runs stay Coolify and Dokploy only", () => {
    expect([...RUN_SOURCE_KINDS]).toEqual(["coolify", "dokploy"]);
  });
});
