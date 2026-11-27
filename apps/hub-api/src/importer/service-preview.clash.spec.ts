import { buildServicePreview, serviceNameClashes } from "./service-preview";
import type { ForeignService } from "./foreign-fleet";

const compose = "services:\n  app:\n    image: getmeili/meilisearch:v1.8\n";
const svc = (sourceRef: string, name: string, serverRef = "s1"): ForeignService => ({ sourceRef, name, serverRef, composeFile: compose, memberApps: [], memberDbs: [], members: [{ name: "app", kind: "app", ref: "m", domains: [] }] });

const prismaOf = (apps: Array<{ teamId: string; name: string }>, servers: Array<{ id: string; teamId: string }> = []) => ({
  application: { findMany: jest.fn(async ({ where }: { where: { OR: Array<{ teamId: string; name: { in: string[] } }> } }) => apps.filter((a) => where.OR.some((o) => o.teamId === a.teamId && o.name.in.includes(a.name)))) },
  server: { findMany: jest.fn(async () => servers) },
});

describe("a service whose name is taken is flagged in the review, not failed at apply", () => {
  it("an app of that name on the target team: team clash", async () => {
    const p = prismaOf([{ teamId: "t1", name: "meilisearch" }]);
    const out = await serviceNameClashes(p as never, { sessionTeamId: "t1", services: [svc("a", "meilisearch"), svc("b", "minio")], choices: {}, importAppNames: [] });
    expect([...out]).toEqual([["service:s1:a", "team"]]);
  });

  it("the operator's rename is what is checked", async () => {
    const p = prismaOf([{ teamId: "t1", name: "meilisearch" }]);
    const choices = { "service:s1:a": { name: "meilisearch-2" } };
    expect((await serviceNameClashes(p as never, { sessionTeamId: "t1", services: [svc("a", "meilisearch")], choices, importAppNames: [] })).size).toBe(0);
    const clash = { "service:s1:a": { name: "meilisearch" } };
    expect((await serviceNameClashes(p as never, { sessionTeamId: "t1", services: [svc("a", "x")], choices: clash, importAppNames: [] })).get("service:s1:a")).toBe("team");
  });

  it("a name taken in another team is no clash; the chosen target server's team is the one checked", async () => {
    const p = prismaOf([{ teamId: "t2", name: "meilisearch" }], [{ id: "srv-t2", teamId: "t2" }]);
    expect((await serviceNameClashes(p as never, { sessionTeamId: "t1", services: [svc("a", "meilisearch")], choices: {}, importAppNames: [] })).size).toBe(0);
    const choices = { "service:s1:a": { targetServerId: "srv-t2" } };
    expect((await serviceNameClashes(p as never, { sessionTeamId: "t1", services: [svc("a", "meilisearch")], choices, importAppNames: [] })).get("service:s1:a")).toBe("team");
  });

  it("two services, or a service and an app of the same import, with one name: import clash", async () => {
    const p = prismaOf([]);
    const two = await serviceNameClashes(p as never, { sessionTeamId: "t1", services: [svc("a", "search", "s1"), svc("b", "search", "s2")], choices: {}, importAppNames: [] });
    expect([...two.values()]).toEqual(["import", "import"]);
    const withApp = await serviceNameClashes(p as never, { sessionTeamId: "t1", services: [svc("a", "search")], choices: {}, importAppNames: ["search"] });
    expect(withApp.get("service:s1:a")).toBe("import");
  });

  it("a service skipped by choice takes no name and clashes with none", async () => {
    const p = prismaOf([{ teamId: "t1", name: "search" }]);
    const choices = { "service:s1:a": { skip: true } };
    expect((await serviceNameClashes(p as never, { sessionTeamId: "t1", services: [svc("a", "search"), svc("b", "search")], choices, importAppNames: [] })).has("service:s1:a")).toBe(false);
  });

  it("the card carries the clash, but not for a service that is not imported", () => {
    expect(buildServicePreview(svc("a", "search"), undefined, undefined, "team").nameClash).toBe("team");
    expect(buildServicePreview(svc("a", "search"), undefined, undefined).nameClash).toBeUndefined();
    expect(buildServicePreview(svc("a", "search"), { skip: true }, undefined, "team").nameClash).toBeUndefined();
  });
});
