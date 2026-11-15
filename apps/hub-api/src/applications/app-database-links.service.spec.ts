import { BadRequestException, ConflictException } from "@nestjs/common";
import type { Application } from "@prisma/client";
import { AppDatabaseLinksService } from "./app-database-links.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { TeamAccessService } from "../common/team-access.service";
import type { AuditService } from "../audit/audit.service";
import type { DatabasesService } from "../databases/databases.service";
import type { CryptoService } from "../crypto/crypto.service";

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
    { encrypt: (s: string) => s, decrypt: (s: string) => s } as unknown as CryptoService,
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

describe("AppDatabaseLinksService.create — adoptEnv keeps the flag column in step", () => {
  const meta = (flags: Record<string, unknown>) => JSON.stringify({ v: 1, flags });
  function adoptDeps(row: Record<string, unknown>) {
    const txUpdate = jest.fn().mockResolvedValue({});
    const tx = { application: { update: txUpdate }, appDatabaseLink: { create: jest.fn().mockResolvedValue({}) } };
    const prisma = {
      appMove: { findFirst: jest.fn().mockResolvedValue(null) },
      database: { findFirst: jest.fn().mockResolvedValue(dbRow()) },
      appDatabaseLink: {
        findUnique: jest.fn().mockResolvedValueOnce(null).mockResolvedValue({ id: "l1", envVar: "DATABASE_URL", createdAt: new Date() }),
        findMany: jest.fn().mockResolvedValue([]),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ id: "l1", envVar: "DATABASE_URL", createdAt: new Date() }),
      },
      $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined), requireResourceAccess: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const audit = { log: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
    const svc = new AppDatabaseLinksService(prisma, access, audit, { internalConnectionUri: jest.fn() } as unknown as DatabasesService, { encrypt: (s: string) => `enc(${s})`, decrypt: (s: string) => s } as unknown as CryptoService);
    const full = { ...app, environmentId: "e1", dbNetwork: true, ...row } as unknown as Application;
    jest.spyOn(svc as unknown as { loadApp: () => Promise<Application> }, "loadApp").mockResolvedValue(full);
    jest.spyOn(svc as unknown as { requireDbAccess: () => Promise<void> }, "requireDbAccess").mockResolvedValue(undefined);
    return { svc, txUpdate };
  }

  it("prunes the adopted key's flags in the SAME update", async () => {
    const d = adoptDeps({ envEnc: JSON.stringify({ DATABASE_URL: "x\ny", KEEP: "1" }), envMetaEnc: meta({ DATABASE_URL: { multiline: true }, KEEP: { literal: true } }) });
    await d.svc.create("u1", "app1", { databaseId: "db1", envVar: "DATABASE_URL", adoptEnv: true });
    expect(d.txUpdate).toHaveBeenCalledWith({ where: { id: "app1" }, data: { envEnc: 'enc({"KEEP":"1"})', envMetaEnc: 'enc({"v":1,"flags":{"KEEP":{"literal":true}}})' } });
  });

  it("leaves a null flag column null, and aborts (409) on an unreadable blob", async () => {
    const plain = adoptDeps({ envEnc: JSON.stringify({ DATABASE_URL: "x" }), envMetaEnc: null });
    await plain.svc.create("u1", "app1", { databaseId: "db1", envVar: "DATABASE_URL", adoptEnv: true });
    expect(plain.txUpdate.mock.calls[0][0].data.envMetaEnc).toBeNull();
    const bad = adoptDeps({ envEnc: JSON.stringify({ DATABASE_URL: "x" }), envMetaEnc: "garbage" });
    await expect(bad.svc.create("u1", "app1", { databaseId: "db1", envVar: "DATABASE_URL", adoptEnv: true })).rejects.toThrow(/stored variable flags are unreadable; reset them in the app.s Environment tab before adopting/);
  });
});

describe("AppDatabaseLinksService — the app-move lock", () => {
  function lockedDeps(live: boolean) {
    const prisma = {
      appMove: { findFirst: jest.fn().mockResolvedValue(live ? { id: "mv1", phase: "TRANSFERRING" } : null) },
      database: { findFirst: jest.fn().mockResolvedValue(dbRow()) },
      appDatabaseLink: { findFirst: jest.fn().mockResolvedValue({ id: "l1", databaseId: "db1", envVar: "DATABASE_URL" }), delete: jest.fn().mockResolvedValue({}), findUnique: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn(),
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined), requireResourceAccess: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const svc = new AppDatabaseLinksService(prisma, access, { log: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService, {} as DatabasesService, {} as CryptoService);
    jest.spyOn(svc as unknown as { loadApp: () => Promise<Application> }, "loadApp").mockResolvedValue({ ...app, environmentId: "e1" } as unknown as Application);
    jest.spyOn(svc as unknown as { requireDbAccess: () => Promise<void> }, "requireDbAccess").mockResolvedValue(undefined);
    return { svc, prisma };
  }

  it("linking and unlinking are refused with 409 app_move_in_progress while the app is being moved (nothing is written)", async () => {
    const t = lockedDeps(true);
    const e1 = await t.svc.create("u1", "app1", { databaseId: "db1" }).catch((x: unknown) => x);
    expect(e1).toBeInstanceOf(ConflictException);
    expect((e1 as ConflictException).getResponse()).toMatchObject({ code: "app_move_in_progress" });
    await expect(t.svc.remove("u1", "app1", "l1")).rejects.toBeInstanceOf(ConflictException);
    expect(t.prisma.$transaction as jest.Mock).not.toHaveBeenCalled();
    expect(t.prisma.appDatabaseLink.delete as jest.Mock).not.toHaveBeenCalled();
  });

  it("with no live move, unlinking proceeds", async () => {
    const t = lockedDeps(false);
    await t.svc.remove("u1", "app1", "l1");
    expect(t.prisma.appDatabaseLink.delete as jest.Mock).toHaveBeenCalled();
  });
});
