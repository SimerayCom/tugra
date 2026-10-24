import { BadRequestException } from "@nestjs/common";
import type { Application } from "@prisma/client";
import { AppDatabaseLinksService } from "./app-database-links.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { TeamAccessService } from "../common/team-access.service";
import type { AuditService } from "../audit/audit.service";
import type { DatabasesService } from "../databases/databases.service";

const app = {
  id: "app1",
  teamId: "t1",
  serverId: "s1",
  clusterId: null,
  source: "IMAGE",
  dockerOptions: null,
  isPreview: false,
} as unknown as Application;

function dbRow(over: Record<string, unknown> = {}) {
  return { id: "db1", name: "pg", teamId: "t1", serverId: "s1", engine: "POSTGRES", ...over };
}

function make(links: unknown[], uri: string | (() => string) = "postgresql://u:p@tugra_db_db1:5432/appdb") {
  const prisma = {
    appDatabaseLink: { findMany: jest.fn().mockResolvedValue(links) },
  } as unknown as PrismaService;
  const databases = {
    internalConnectionUri: jest.fn(() => (typeof uri === "function" ? uri() : uri)),
  } as unknown as DatabasesService;
  const svc = new AppDatabaseLinksService(
    prisma,
    {} as TeamAccessService,
    {} as AuditService,
    databases,
  );
  return { svc, prisma, databases };
}

describe("AppDatabaseLinksService.resolveLinkedEnv", () => {
  it("injects the internal connection URI under the link's envVar", async () => {
    const { svc } = make([{ envVar: "DATABASE_URL", database: dbRow() }]);
    const env = await svc.resolveLinkedEnv(app, new Set());
    expect(env).toEqual({ DATABASE_URL: "postgresql://u:p@tugra_db_db1:5432/appdb" });
  });

  it("merges multiple links by their own envVar", async () => {
    const { svc } = make([
      { envVar: "DATABASE_URL", database: dbRow() },
      { envVar: "CACHE_URL", database: dbRow({ id: "db2", name: "redis", engine: "REDIS" }) },
    ]);
    const env = await svc.resolveLinkedEnv(app, new Set());
    expect(Object.keys(env).sort()).toEqual(["CACHE_URL", "DATABASE_URL"]);
  });

  it("skips a link whose key the app sets explicitly (even if that link would be broken)", async () => {
    // DB moved off-server would normally throw; shadowed -> skipped instead, no throw, not injected
    const { svc } = make([{ envVar: "DATABASE_URL", database: dbRow({ serverId: "s2" }) }]);
    const env = await svc.resolveLinkedEnv(app, new Set(["DATABASE_URL"]));
    expect(env).toEqual({});
  });

  it("returns {} for a preview app without querying links", async () => {
    const { svc, prisma } = make([{ envVar: "DATABASE_URL", database: dbRow() }]);
    const env = await svc.resolveLinkedEnv({ ...app, isPreview: true } as Application, new Set());
    expect(env).toEqual({});
    expect((prisma.appDatabaseLink.findMany as jest.Mock)).not.toHaveBeenCalled();
  });

  it("fails the deploy (throws) when a non-shadowed link is unreachable: cross-server", async () => {
    const { svc } = make([{ envVar: "DATABASE_URL", database: dbRow({ serverId: "s2" }) }]);
    await expect(svc.resolveLinkedEnv(app, new Set())).rejects.toBeInstanceOf(BadRequestException);
  });

  it("throws for a swarm app, a compose app and a custom-network app", async () => {
    const link = [{ envVar: "DATABASE_URL", database: dbRow() }];
    await expect(make(link).svc.resolveLinkedEnv({ ...app, clusterId: "c1" } as Application, new Set())).rejects.toBeInstanceOf(BadRequestException);
    await expect(make(link).svc.resolveLinkedEnv({ ...app, source: "COMPOSE" } as Application, new Set())).rejects.toBeInstanceOf(BadRequestException);
    await expect(make(link).svc.resolveLinkedEnv({ ...app, dockerOptions: "--network host" } as Application, new Set())).rejects.toBeInstanceOf(BadRequestException);
  });

  it("throws when the linked database row is gone", async () => {
    const { svc } = make([{ envVar: "DATABASE_URL", database: null }]);
    await expect(svc.resolveLinkedEnv(app, new Set())).rejects.toBeInstanceOf(BadRequestException);
  });

  it("throws when the linked database is in another team", async () => {
    const { svc } = make([{ envVar: "DATABASE_URL", database: dbRow({ teamId: "other" }) }]);
    await expect(svc.resolveLinkedEnv(app, new Set())).rejects.toBeInstanceOf(BadRequestException);
  });

  it("throws (not partial) when building the URI fails for one link", async () => {
    const { svc } = make(
      [{ envVar: "DATABASE_URL", database: dbRow() }],
      () => { throw new Error("decrypt failed"); },
    );
    await expect(svc.resolveLinkedEnv(app, new Set())).rejects.toBeInstanceOf(BadRequestException);
  });

  it("never leaks the password/scheme in the thrown message", async () => {
    const { svc } = make([{ envVar: "DATABASE_URL", database: dbRow({ serverId: "s2" }) }]);
    await expect(svc.resolveLinkedEnv(app, new Set())).rejects.toThrow(/^(?!.*(postgresql:\/\/|:p@)).*$/);
  });
});
