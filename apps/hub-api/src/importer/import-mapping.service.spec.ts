import { ConflictException, ForbiddenException } from "@nestjs/common";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ImportMappingService, type MappingSession } from "./import-mapping.service";
import { ImportMappingDocSchema, docHash } from "./import-mapping";

const sessionA: MappingSession = { id: "s1", teamId: "team-a", sourceKind: "coolify", baseUrl: "HTTPS://Coolify.Example.com/", scopeKey: "team-3" };
const doc = (d: Record<string, unknown> = {}) => ImportMappingDocSchema.parse({ version: 1, ...d });

function make(rows: Array<Record<string, unknown>> = []) {
  const store = rows.map((r) => ({ ...r }));
  const key = (w: { teamId: string; sourceKind: string; baseUrl: string; scopeKey: string }) => store.find((r) => r.teamId === w.teamId && r.sourceKind === w.sourceKind && r.baseUrl === w.baseUrl && r.scopeKey === w.scopeKey);
  const prisma = {
    importMapping: {
      findUnique: jest.fn(async ({ where }: { where: { teamId_sourceKind_baseUrl_scopeKey?: never; id?: string } }) => {
        const row = where.id ? store.find((r) => r.id === where.id) : key(where.teamId_sourceKind_baseUrl_scopeKey as never);
        return row ? { ...row } : null; // a copy, like a real query result
      }),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `m${store.length + 1}`, version: 1, ...data };
        store.push(row);
        return row;
      }),
      updateMany: jest.fn(async ({ where, data }: { where: { id: string; version?: number }; data: Record<string, unknown> }) => {
        const r = store.find((x) => x.id === where.id && (where.version === undefined || x.version === where.version));
        if (!r) return { count: 0 };
        Object.assign(r, { ...data, version: (r.version as number) + 1 });
        return { count: 1 };
      }),
      deleteMany: jest.fn(async ({ where }: { where: { teamId: string } }) => {
        const n = store.length;
        for (let i = store.length - 1; i >= 0; i--) if (key(where as never) === store[i]) store.splice(i, 1);
        return { count: n - store.length };
      }),
    },
    project: { findMany: jest.fn().mockResolvedValue([]) },
    application: { findMany: jest.fn().mockResolvedValue([]) },
    database: { findMany: jest.fn().mockResolvedValue([]) },
    gitSource: { findMany: jest.fn().mockResolvedValue([]) },
    bulkTask: { findMany: jest.fn().mockResolvedValue([]) },
    server: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const access = { requirePermission: jest.fn().mockResolvedValue(undefined), membershipPermissions: jest.fn().mockResolvedValue(new Set(["apps:config", "projects"])) };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const svc = new ImportMappingService(prisma as never, access as never, audit as never);
  return { svc, prisma, access, audit, store };
}

describe("ImportMappingService — profile", () => {
  it("is keyed by team + source kind + NORMALIZED base url + scope label (derived server-side from the session)", async () => {
    const { svc, prisma } = make();
    await svc.getProfile(sessionA);
    expect(prisma.importMapping.findUnique).toHaveBeenCalledWith({ where: { teamId_sourceKind_baseUrl_scopeKey: { teamId: "team-a", sourceKind: "coolify", baseUrl: "https://coolify.example.com", scopeKey: "team-3" } } });
  });
  it("put creates, then updates and bumps the version; get returns the parsed doc", async () => {
    const { svc } = make();
    expect(await svc.getProfile(sessionA)).toBeNull();
    const first = await svc.putProfile("u1", sessionA, { mapping: doc({ items: { "app:s:a": { name: "x" } } }), label: "prod" });
    expect(first).toMatchObject({ ok: true, version: 1, mappingHash: docHash(doc({ items: { "app:s:a": { name: "x" } } })) });
    const second = await svc.putProfile("u1", sessionA, { mapping: doc({ items: { "app:s:a": { name: "y" } } }) });
    expect(second.version).toBe(2);
    const p = await svc.getProfile(sessionA);
    expect(p?.doc.items["app:s:a"]).toEqual({ name: "y" });
    expect(p?.version).toBe(2);
  });
  it("a stale expectedVersion -> 409 import.mapping_version_conflict; a matching one lands", async () => {
    const { svc } = make();
    await svc.putProfile("u1", sessionA, { mapping: doc() });
    const e = await svc.putProfile("u1", sessionA, { mapping: doc(), expectedVersion: 5 }).catch((x) => x);
    expect(e).toBeInstanceOf(ConflictException);
    expect((e as ConflictException).getResponse()).toMatchObject({ code: "import.mapping_version_conflict" });
    await expect(svc.putProfile("u1", sessionA, { mapping: doc(), expectedVersion: 1 })).resolves.toMatchObject({ version: 2 });
    // creating with an expectedVersion that cannot match is a conflict too
    const fresh = make();
    await expect(fresh.svc.putProfile("u1", sessionA, { mapping: doc(), expectedVersion: 1 })).rejects.toBeInstanceOf(ConflictException);
  });
  it("cross-team IDOR: a profile of team B is invisible to a team-A session, and a delete never touches it", async () => {
    const teamB: MappingSession = { ...sessionA, id: "sB", teamId: "team-b" };
    const { svc, store } = make();
    await svc.putProfile("u2", teamB, { mapping: doc({ items: { "app:s:a": { name: "b-only" } } }) });
    expect(await svc.getProfile(sessionA)).toBeNull();
    expect((await svc.deleteProfile("u1", sessionA)).deleted).toBe(false);
    expect(store).toHaveLength(1);
    expect(await svc.getProfile(teamB)).not.toBeNull();
  });
  it("eight scope labels are eight independent profiles", async () => {
    const { svc, store } = make();
    for (let i = 1; i <= 8; i++) await svc.putProfile("u1", { ...sessionA, scopeKey: `team-${i}` }, { mapping: doc({ acks: [`a${i}`] }) });
    expect(store).toHaveLength(8);
    expect((await svc.getProfile({ ...sessionA, scopeKey: "team-5" }))?.doc.acks).toEqual(["a5"]);
  });
  it("a stored profile that no longer parses is ignored, not thrown", async () => {
    const { svc } = make([{ id: "m1", teamId: "team-a", sourceKind: "coolify", baseUrl: "https://coolify.example.com", scopeKey: "team-3", mapping: { version: 9 }, version: 1 }]);
    expect(await svc.getProfile(sessionA)).toBeNull();
  });
  it("audit rows hold counts only — never names or values", async () => {
    const { svc, audit } = make();
    await svc.putProfile("u1", sessionA, { mapping: doc({ items: { "app:s:a": { name: "SecretCustomerName" } }, acks: ["k"] }), label: "Some Label" });
    await svc.deleteProfile("u1", sessionA);
    const calls = audit.log.mock.calls.map((c: unknown[]) => c[0] as { action: string; meta: Record<string, unknown> });
    expect(calls.map((c) => c.action)).toEqual(["import.mapping.save", "import.mapping.delete"]);
    expect(calls[0].meta).toEqual({ items: 1, projects: 0, gitSources: 0, acks: 1, version: 1 });
    expect(JSON.stringify(calls)).not.toMatch(/SecretCustomerName|Some Label/);
  });
  it("planBlock advertises the feature flag and the editable stored default", async () => {
    const { svc } = make();
    expect(await svc.planBlock(sessionA)).toEqual({ features: ["mapping-v1"], stored: null, storedVersion: null, scopeKey: "team-3" });
  });
  it("the profile table cascades with the team (FK ON DELETE CASCADE in the migration)", () => {
    const sql = readFileSync(path.resolve(__dirname, "../../prisma/migrations/20261120120000_import_mapping/migration.sql"), "utf8");
    expect(sql).toMatch(/ImportMapping_teamId_fkey" FOREIGN KEY \("teamId"\) REFERENCES "Team"\("id"\) ON DELETE CASCADE/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX "ImportMapping_teamId_sourceKind_baseUrl_scopeKey_key"/);
  });
});

describe("ImportMappingService.buildSnapshot", () => {
  it("demands apps:config on the target team BEFORE any query (no name-existence oracle)", async () => {
    const { svc, prisma, access } = make();
    access.requirePermission.mockRejectedValue(new ForbiddenException("insufficient permission for this team"));
    await expect(svc.buildSnapshot("u1", { id: "srv", teamId: "team-z" }, ["app:s:a"])).rejects.toBeInstanceOf(ForbiddenException);
    expect(access.requirePermission).toHaveBeenCalledWith("u1", "team-z", "apps:config");
    for (const m of [prisma.project.findMany, prisma.application.findMany, prisma.database.findMany, prisma.gitSource.findMany, prisma.bulkTask.findMany]) expect(m).not.toHaveBeenCalled();
  });
  it("every query is team-scoped; builds names, aliases, existing and elsewhere maps", async () => {
    const { svc, prisma } = make();
    prisma.project.findMany.mockResolvedValue([{ id: "p1", name: "Shop", isDefault: true, environments: [{ id: "e1", name: "production", isDefault: true }] }]);
    prisma.application.findMany.mockResolvedValue([
      { id: "a1", name: "Web", environmentId: "e1", serverId: "srv", containerAlias: "Front", networkAliases: ["front", "Other"] },
      { id: "a2", name: "Old", environmentId: "e1", serverId: "srv-2", containerAlias: null, networkAliases: ["not-on-this-server"] },
    ]);
    prisma.database.findMany.mockResolvedValue([{ id: "d1", name: "PG", environmentId: "e1" }]);
    prisma.gitSource.findMany.mockResolvedValue([{ appId: "77" }, { appId: null }]);
    prisma.bulkTask.findMany.mockResolvedValue([
      { itemRef: "app:s:a", resourceId: "a1", resourceType: "application", serverId: "srv" },
      { itemRef: "app:s:b", resourceId: "a2", resourceType: "application", serverId: "srv-2" },
      { itemRef: "database:s:c", resourceId: "d1", resourceType: "database", serverId: "srv" },
      { itemRef: "app:s:gone", resourceId: "deleted", resourceType: "application", serverId: "srv" },
    ]);
    prisma.server.findMany.mockResolvedValue([{ id: "srv-2", name: "Second" }]);
    const snap = await svc.buildSnapshot("u1", { id: "srv", teamId: "team-a" }, ["app:s:a", "app:s:b", "database:s:c", "app:s:gone"]);
    expect(prisma.project.findMany.mock.calls[0][0].where).toEqual({ teamId: "team-a" });
    expect(prisma.application.findMany.mock.calls[0][0].where).toEqual({ teamId: "team-a" });
    expect(prisma.database.findMany.mock.calls[0][0].where).toEqual({ teamId: "team-a" });
    expect(prisma.gitSource.findMany.mock.calls[0][0].where).toEqual({ teamId: "team-a" });
    expect(prisma.server.findMany.mock.calls[0][0].where).toMatchObject({ teamId: "team-a" });
    expect(snap.canCreateProjects).toBe(true);
    expect(snap.defaultEnvironmentId).toBe("e1");
    expect(snap.projects.get("Shop")?.envs.get("production")).toBe("e1");
    expect([...snap.aliasesOnServer].sort()).toEqual(["front", "other"]); // only apps ON this server, lowercased
    expect(snap.namesByEnv.get("e1")?.apps.get("web")).toBe("a1");
    expect(snap.existing.get("app:s:a")).toMatchObject({ resourceId: "a1", name: "Web", containerAlias: "Front" });
    expect(snap.existing.get("database:s:c")).toMatchObject({ resourceType: "database", resourceId: "d1" });
    expect(snap.existing.has("app:s:gone")).toBe(false); // a deleted resource is no longer "imported"
    expect(snap.elsewhere.get("app:s:b")).toEqual({ serverId: "srv-2", serverName: "Second" });
    expect(snap.gitSourcesByAppId).toEqual(new Set(["77"]));
  });
  it("multi-host serverMap: existing/elsewhere follow each item's own target, aliases are scanned on every target, a foreign server id is refused", async () => {
    const { svc, prisma } = make();
    prisma.application.findMany.mockResolvedValue([
      { id: "a1", name: "Web", environmentId: "e1", serverId: "srv", containerAlias: "one", networkAliases: [] },
      { id: "a2", name: "Api", environmentId: "e1", serverId: "srv-2", containerAlias: "two", networkAliases: [] },
      { id: "a3", name: "Far", environmentId: "e1", serverId: "srv-9", containerAlias: "far", networkAliases: [] },
    ]);
    prisma.bulkTask.findMany.mockResolvedValue([
      { itemRef: "app:src-a:a", resourceId: "a1", resourceType: "application", serverId: "srv" },
      { itemRef: "app:src-b:b", resourceId: "a2", resourceType: "application", serverId: "srv-2" },
      { itemRef: "app:src-b:c", resourceId: "a3", resourceType: "application", serverId: "srv-9" },
    ]);
    prisma.server.findMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.map((id) => ({ id, name: `name-${id}` })));
    const snap = await svc.buildSnapshot("u1", { id: "srv", teamId: "team-a" }, ["app:src-a:a", "app:src-b:b", "app:src-b:c"], { "src-a": "srv", "src-b": "srv-2" });
    // a lives where it is placed (srv); b lives where it is placed (srv-2): both "existing" even though srv-2 is not the default
    expect(snap.existing.has("app:src-a:a")).toBe(true);
    expect(snap.existing.has("app:src-b:b")).toBe(true);
    // c was imported on srv-9, which is not where src-b places it
    expect(snap.existing.has("app:src-b:c")).toBe(false);
    expect(snap.elsewhere.get("app:src-b:c")).toMatchObject({ serverId: "srv-9" });
    expect([...snap.aliasesOnServer].sort()).toEqual(["one", "two"]);
    prisma.server.findMany.mockResolvedValueOnce([]); // the extra target is not a server of this team
    await expect(svc.buildSnapshot("u1", { id: "srv", teamId: "team-a" }, [], { "src-a": "someone-elses" })).rejects.toMatchObject({ response: { code: "import.server_map_invalid" } });
  });
  it("canCreateProjects follows the caller's projects permission", async () => {
    const { svc, access } = make();
    access.membershipPermissions.mockResolvedValue(new Set(["apps:config"]));
    expect((await svc.buildSnapshot("u1", { id: "srv", teamId: "team-a" }, [])).canCreateProjects).toBe(false);
  });
});
