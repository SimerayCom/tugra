import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { ClustersService } from "./clusters.service";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";

const CLUSTER = { id: "c1", teamId: "t1", name: "eu-west", description: null, swarmStatus: "NONE", createdAt: new Date() };

function p2002() {
  return new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "6" });
}

function make(over: {
  cluster?: Record<string, jest.Mock>;
  server?: Record<string, jest.Mock>;
  application?: Record<string, jest.Mock>;
  access?: Partial<TeamAccessService>;
} = {}) {
  const audit = { log: jest.fn() } as unknown as AuditService;
  const prisma = {
    cluster: {
      create: jest.fn().mockResolvedValue(CLUSTER),
      findUnique: jest.fn().mockResolvedValue(CLUSTER),
      findMany: jest.fn().mockResolvedValue([{ ...CLUSTER, _count: { servers: 2 } }]),
      update: jest.fn().mockResolvedValue(CLUSTER),
      delete: jest.fn().mockResolvedValue(CLUSTER),
      ...over.cluster,
    },
    server: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      ...over.server,
    },
    application: { findMany: jest.fn().mockResolvedValue([]), ...over.application },
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  } as unknown as PrismaService;
  const access = {
    requirePermission: jest.fn().mockResolvedValue(undefined),
    teamIds: jest.fn().mockResolvedValue(["t1"]),
    membershipPermissions: jest.fn().mockResolvedValue(new Set(["servers:manage"])),
    permissionsByTeam: jest.fn().mockResolvedValue(new Map([["t1", new Set(["servers:manage"])]])),
    ...over.access,
  } as unknown as TeamAccessService;
  return { svc: new ClustersService(prisma, access, audit), prisma, access, audit };
}

describe("ClustersService", () => {
  it("create requires servers:manage, persists, and returns the view", async () => {
    const { svc, prisma, access } = make();
    const v = await svc.create("u1", { teamId: "t1", name: "eu-west" });
    expect(access.requirePermission).toHaveBeenCalledWith("u1", "t1", "servers:manage");
    expect(prisma.cluster!.create).toHaveBeenCalled();
    expect(v).toMatchObject({ id: "c1", name: "eu-west", nodeCount: 0, canWrite: true });
  });

  it("create maps a duplicate name to 409", async () => {
    const { svc } = make({ cluster: { create: jest.fn().mockRejectedValue(p2002()) } });
    await expect(svc.create("u1", { teamId: "t1", name: "dup" })).rejects.toBeInstanceOf(ConflictException);
  });

  it("create is forbidden without permission (and never persists)", async () => {
    const { svc, prisma } = make({ access: { requirePermission: jest.fn().mockRejectedValue(new ForbiddenException()) } });
    await expect(svc.create("u1", { teamId: "t1", name: "x" })).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.cluster!.create).not.toHaveBeenCalled();
  });

  it("get returns the detail with a node + app health rollup", async () => {
    const { svc } = make({
      server: {
        findMany: jest.fn().mockResolvedValue([
          { id: "s1", name: "a", status: "ONLINE", hostname: null, publicIp: "1.1.1.1" },
          { id: "s2", name: "b", status: "OFFLINE", hostname: null, publicIp: null },
          { id: "s3", name: "c", status: "PENDING", hostname: null, publicIp: null },
        ]),
      },
      application: {
        findMany: jest.fn().mockResolvedValue([{ status: "RUNNING" }, { status: "RUNNING" }, { status: "FAILED" }, { status: "NEW" }]),
      },
    });
    const d = await svc.get("u1", "c1");
    expect(d.health.nodes).toEqual({ online: 1, offline: 1, pending: 1, total: 3 });
    expect(d.health.apps).toEqual({ running: 2, stopped: 0, failed: 1, new: 1, total: 4 });
    expect(d.servers).toHaveLength(3);
    expect(d.canWrite).toBe(true);
  });

  it("get is 404 for a non-member (does not reveal the cluster)", async () => {
    const { svc } = make({ access: { teamIds: jest.fn().mockResolvedValue(["other"]) } });
    await expect(svc.get("u1", "c1")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("setServers assigns the selected servers and releases the rest", async () => {
    const { svc, prisma } = make({ server: { count: jest.fn().mockResolvedValue(2), findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn().mockResolvedValue({ count: 0 }) } });
    await svc.setServers("u1", "c1", { serverIds: ["s1", "s2"] });
    const calls = (prisma.server!.updateMany as jest.Mock).mock.calls;
    // release: clusterId=null for members NOT in the new set
    expect(calls[0][0]).toMatchObject({ where: { clusterId: "c1", id: { notIn: ["s1", "s2"] } }, data: { clusterId: null } });
    // assign: clusterId=c1 for the selected servers, scoped to the team
    expect(calls[1][0]).toMatchObject({ where: { id: { in: ["s1", "s2"] }, teamId: "t1" }, data: { clusterId: "c1" } });
  });

  it("setServers rejects a server from another team (tenancy guard) and assigns nothing", async () => {
    const { svc, prisma } = make({ server: { count: jest.fn().mockResolvedValue(1), updateMany: jest.fn() } }); // only 1 of 2 owned
    await expect(svc.setServers("u1", "c1", { serverIds: ["s1", "foreign"] })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.server!.updateMany).not.toHaveBeenCalled();
  });

  it("setServers refuses to drop a swarm-joined node while a swarm is formed (409), assigns nothing", async () => {
    const { svc, prisma } = make({
      cluster: { findUnique: jest.fn().mockResolvedValue({ ...CLUSTER, swarmStatus: "ACTIVE" }) },
      server: {
        count: jest.fn().mockResolvedValue(1),
        findMany: jest.fn().mockResolvedValue([{ id: "joined1" }]), // a still-joined member being dropped
        updateMany: jest.fn(),
      },
    });
    await expect(svc.setServers("u1", "c1", { serverIds: ["other"] })).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.server!.updateMany).not.toHaveBeenCalled();
  });

  it("remove deletes the cluster (members freed via SetNull)", async () => {
    const { svc, prisma } = make();
    await svc.remove("u1", "c1");
    expect(prisma.cluster!.delete).toHaveBeenCalledWith({ where: { id: "c1" } });
  });

  it("remove refuses (409) while a swarm is still formed, and never deletes", async () => {
    const { svc, prisma } = make({ cluster: { findUnique: jest.fn().mockResolvedValue({ ...CLUSTER, swarmStatus: "ACTIVE" }), delete: jest.fn() } });
    await expect(svc.remove("u1", "c1")).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.cluster!.delete).not.toHaveBeenCalled();
  });

  it("list is scoped to the user's teams", async () => {
    const { svc, prisma } = make();
    const rows = await svc.list("u1");
    expect(prisma.cluster!.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { teamId: { in: ["t1"] } } }));
    expect(rows[0]).toMatchObject({ id: "c1", nodeCount: 2, canWrite: true });
  });
});
