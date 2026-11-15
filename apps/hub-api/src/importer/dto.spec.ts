import { ImportApplySchema, ImportServicesPreviewSchema, ServiceChoiceSchema, ServiceChoicesSchema } from "./dto";

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
