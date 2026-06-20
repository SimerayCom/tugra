import { ForbiddenException } from "@nestjs/common";
import { DatabasesService } from "./databases.service";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { CryptoService } from "../crypto/crypto.service";

const audit = { log: jest.fn() } as unknown as AuditService;
const crypto = {
  encrypt: (s: string) => `enc:${s}`,
  decrypt: (s: string) => s.replace(/^enc:/, ""),
} as unknown as CryptoService;

function make(
  prisma: Partial<PrismaService>,
  access: Partial<TeamAccessService>,
  agentWs: Partial<AgentWsServer> = {},
) {
  return new DatabasesService(
    prisma as PrismaService,
    access as TeamAccessService,
    audit,
    agentWs as AgentWsServer,
    crypto,
  );
}

const db = {
  id: "db1",
  teamId: "t1",
  serverId: "s1",
  name: "main",
  engine: "POSTGRES",
  version: "16",
  image: "postgres:16",
  port: 5432,
  hostPort: null,
  credentials: `enc:${JSON.stringify({ username: "tugra", password: "pw", database: "main" })}`,
  status: "NEW",
  createdAt: new Date(),
};

describe("DatabasesService", () => {
  it("forbids creating a database for a team the user can't write to", async () => {
    const prisma = {
      server: { findUnique: jest.fn().mockResolvedValue({ id: "s1", teamId: "t1" }) },
    } as unknown as PrismaService;
    const access = {
      requireRole: jest.fn().mockRejectedValue(new ForbiddenException("nope")),
    } as unknown as TeamAccessService;
    const svc = make(prisma, access);
    await expect(
      svc.create("u1", { name: "main", serverId: "s1", engine: "POSTGRES" }),
    ).rejects.toThrow(/nope/);
  });

  it("provisions via the agent and records RUNNING on exit 0", async () => {
    const update = jest.fn().mockResolvedValue({ ...db, status: "RUNNING" });
    const prisma = {
      database: { findUnique: jest.fn().mockResolvedValue(db), update },
    } as unknown as PrismaService;
    const access = {
      requireRole: jest.fn().mockResolvedValue(undefined),
      teamRole: jest.fn().mockResolvedValue("OWNER"),
    } as unknown as TeamAccessService;
    const agentWs = {
      sendCommand: jest.fn().mockResolvedValue({ exitCode: 0, output: "Up" }),
    } as unknown as AgentWsServer;

    const svc = make(prisma, access, agentWs);
    const view = await svc.provision("u1", "db1");

    expect(agentWs.sendCommand).toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "RUNNING" } }),
    );
    expect(view.status).toBe("RUNNING");
    // owner (write) sees the connection details
    expect(view.connectionUri).toContain("postgresql://tugra:pw@tugra_db_db1:5432/main");
  });

  it("normalizes and stores tags on setTags", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      database: { findUnique: jest.fn().mockResolvedValue(db), update },
    } as unknown as PrismaService;
    const access = { requireRole: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    await make(prisma, access).setTags("u1", "db1", ["Prod", "prod", " cache "]);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { tags: ["cache", "prod"] } }),
    );
  });

  it("hides connection details from non-write (viewer) members", async () => {
    const prisma = {
      database: { findUnique: jest.fn().mockResolvedValue(db) },
    } as unknown as PrismaService;
    const access = {
      teamRole: jest.fn().mockResolvedValue("VIEWER"),
    } as unknown as TeamAccessService;
    const svc = make(prisma, access);
    const view = await svc.get("u1", "db1");
    expect(view.canWrite).toBe(false);
    expect(view.connectionUri).toBeNull();
    expect(view.password).toBeNull();
  });
});
