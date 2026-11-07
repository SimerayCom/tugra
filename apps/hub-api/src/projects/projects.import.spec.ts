import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ProjectsService } from "./projects.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { TeamAccessService } from "../common/team-access.service";
import type { AuditService } from "../audit/audit.service";
import type { TemplateCatalogService } from "../catalog/template-catalog.service";
import type { ApplicationsService } from "../applications/applications.service";
import type { DatabasesService } from "../databases/databases.service";

interface P { id: string; teamId: string; name: string; description: string | null; tags: string[]; isDefault: boolean; createdAt: Date }
interface E { id: string; projectId: string; name: string; isDefault: boolean; createdAt: Date }

/** A tiny in-memory Prisma double covering exactly what findOrCreateForImport touches. */
function fakeDb(seed: { projects?: P[]; envs?: E[] } = {}) {
  const projects: P[] = [...(seed.projects ?? [])];
  const envs: E[] = [...(seed.envs ?? [])];
  let n = 0;
  const executeRaw = jest.fn().mockResolvedValue(1);
  const withEnvs = (p: P) => ({ ...p, environments: envs.filter((e) => e.projectId === p.id).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()) });
  const tx = {
    $executeRaw: executeRaw,
    project: {
      findFirst: jest.fn(async ({ where }: { where: { teamId: string; name: string } }) => {
        const p = projects.find((x) => x.teamId === where.teamId && x.name === where.name);
        return p ? withEnvs(p) : null;
      }),
      create: jest.fn(async ({ data }: { data: { teamId: string; name: string; description: string | null; tags: string[] } }) => {
        const p: P = { id: `p${++n}`, isDefault: false, createdAt: new Date(1000 + n), ...data };
        projects.push(p);
        return withEnvs(p);
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<P> }) => Object.assign(projects.find((x) => x.id === where.id)!, data)),
    },
    environment: {
      create: jest.fn(async ({ data }: { data: { projectId: string; name: string; isDefault: boolean } }) => {
        const e: E = { id: `e${++n}`, createdAt: new Date(1000 + n), ...data };
        envs.push(e);
        return e;
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<E> }) => Object.assign(envs.find((x) => x.id === where.id)!, data)),
    },
  };
  const prisma = { $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) };
  return { prisma, tx, projects, envs, executeRaw };
}

function make(db: ReturnType<typeof fakeDb>, over: Partial<TeamAccessService> = {}) {
  const access = { requirePermission: jest.fn().mockResolvedValue(undefined), grantProjectAccess: jest.fn().mockResolvedValue(undefined), ...over };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const svc = new ProjectsService(db.prisma as unknown as PrismaService, access as unknown as TeamAccessService, audit as unknown as AuditService, {} as TemplateCatalogService, {} as ApplicationsService, {} as DatabasesService);
  return { svc, access, audit };
}

const SPEC = { name: "DiesDigital", description: "agency", tags: ["web", "client"], environments: [{ name: "production", isDefault: true }, { name: "staging", isDefault: false }] };

describe("ProjectsService.findOrCreateForImport (L5)", () => {
  it("creates the project (never the team default) with its environments; the flagged one is the project default", async () => {
    const db = fakeDb();
    const { svc, access } = make(db);
    const r = await svc.findOrCreateForImport("u1", "t1", SPEC);
    expect(access.requirePermission).toHaveBeenCalledWith("u1", "t1", "projects");
    expect(r.created).toBe(true);
    expect(db.projects).toHaveLength(1);
    expect(db.projects[0]).toMatchObject({ name: "DiesDigital", description: "agency", tags: ["web", "client"], isDefault: false });
    expect(db.envs.map((e) => [e.name, e.isDefault])).toEqual([["production", true], ["staging", false]]);
    expect(r.environments).toEqual({ production: db.envs[0].id, staging: db.envs[1].id });
    expect(r.createdEnvironments).toEqual(["production", "staging"]);
    expect(access.grantProjectAccess).toHaveBeenCalledWith("u1", "t1", r.projectId);
    expect(db.executeRaw).toHaveBeenCalledTimes(1); // advisory lock taken
  });

  it("is IDEMPOTENT: a second call reuses the same project + environments and creates nothing", async () => {
    const db = fakeDb();
    const { svc, access } = make(db);
    const first = await svc.findOrCreateForImport("u1", "t1", SPEC);
    const second = await svc.findOrCreateForImport("u1", "t1", SPEC);
    expect(second.created).toBe(false);
    expect(second.projectId).toBe(first.projectId);
    expect(second.environments).toEqual(first.environments);
    expect(second.createdEnvironments).toEqual([]);
    expect(db.projects).toHaveLength(1);
    expect(db.envs).toHaveLength(2);
    expect(access.grantProjectAccess).toHaveBeenCalledTimes(1); // only on create
  });

  it("never steals the team default: an existing default project of the same name keeps isDefault and is reused", async () => {
    const db = fakeDb({
      projects: [{ id: "pd", teamId: "t1", name: "Default", description: null, tags: [], isDefault: true, createdAt: new Date(1) }],
      envs: [{ id: "ed", projectId: "pd", name: "production", isDefault: true, createdAt: new Date(1) }],
    });
    const { svc } = make(db);
    const r = await svc.findOrCreateForImport("u1", "t1", { name: "Default", environments: [{ name: "production", isDefault: true }, { name: "qa", isDefault: true }] });
    expect(r.projectId).toBe("pd");
    expect(db.projects).toHaveLength(1);
    expect(db.projects[0].isDefault).toBe(true);
    expect(r.environments.production).toBe("ed");
    // the source flagged "qa" default too, but the project already has a default → exactly one default env stays
    expect(db.envs.filter((e) => e.isDefault).map((e) => e.name)).toEqual(["production"]);
  });

  it("honors isDefault only when the project has no default env yet; otherwise promotes the oldest (exactly one default)", async () => {
    const db = fakeDb();
    const { svc } = make(db);
    await svc.findOrCreateForImport("u1", "t1", { name: "NoFlag", environments: [{ name: "a" }, { name: "b" }] });
    expect(db.envs.filter((e) => e.isDefault).map((e) => e.name)).toEqual(["a"]);
  });

  it("scopes by team: the same name on another team is a separate project", async () => {
    const db = fakeDb();
    const { svc } = make(db);
    const a = await svc.findOrCreateForImport("u1", "t1", SPEC);
    const b = await svc.findOrCreateForImport("u1", "t2", SPEC);
    expect(a.projectId).not.toBe(b.projectId);
    expect(db.projects).toHaveLength(2);
  });

  it("a re-import fills a missing description and unions tags but never overwrites an operator's description", async () => {
    const db = fakeDb({ projects: [{ id: "p0", teamId: "t1", name: "DiesDigital", description: "my own words", tags: ["mine"], isDefault: false, createdAt: new Date(1) }] });
    const { svc } = make(db);
    await svc.findOrCreateForImport("u1", "t1", SPEC);
    expect(db.projects[0].description).toBe("my own words");
    expect(db.projects[0].tags.sort()).toEqual(["client", "mine", "web"]);
  });

  it("a project with no source environments gets a default 'production'", async () => {
    const db = fakeDb();
    const { svc } = make(db);
    const r = await svc.findOrCreateForImport("u1", "t1", { name: "Empty", environments: [] });
    expect(db.envs.map((e) => [e.name, e.isDefault])).toEqual([["production", true]]);
    expect(Object.keys(r.environments)).toEqual(["production"]);
  });

  it("requires the projects permission (rejects without creating anything)", async () => {
    const db = fakeDb();
    const { svc } = make(db, { requirePermission: jest.fn().mockRejectedValue(new Error("forbidden")) });
    await expect(svc.findOrCreateForImport("u1", "t1", SPEC)).rejects.toThrow("forbidden");
    expect(db.projects).toHaveLength(0);
  });
});

describe("migration 20261107213000_project_description_tags", () => {
  const sql = readFileSync(join(__dirname, "../../prisma/migrations/20261107213000_project_description_tags/migration.sql"), "utf8");
  const schema = readFileSync(join(__dirname, "../../prisma/schema.prisma"), "utf8");

  it("adds Project.description (nullable) and Project.tags (NOT NULL DEFAULT '{}') — backward-compatible ALTERs only", () => {
    expect(sql).toMatch(/ALTER TABLE "Project" ADD COLUMN "description" TEXT;/);
    expect(sql).toMatch(/ALTER TABLE "Project" ADD COLUMN "tags" TEXT\[\] NOT NULL DEFAULT '\{\}';/);
    expect(sql).not.toMatch(/DROP|RENAME|SET NOT NULL/i);
  });

  it("matches the Prisma schema fields", () => {
    const model = schema.slice(schema.indexOf("model Project {"), schema.indexOf("model ProjectIcon"));
    expect(model).toMatch(/description\s+String\?/);
    expect(model).toMatch(/tags\s+String\[\]\s+@default\(\[\]\)/);
  });
});
