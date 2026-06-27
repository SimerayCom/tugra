import { ForbiddenException } from "@nestjs/common";
import { DestinationsService } from "./destinations.service";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";
import { CryptoService } from "../crypto/crypto.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";

const audit = { log: jest.fn() } as unknown as AuditService;
const crypto = {
  encrypt: (s: string) => `enc:${s}`,
  decrypt: (s: string) => s.replace(/^enc:/, ""),
} as unknown as CryptoService;

function make(prisma: Partial<PrismaService>, access: Partial<TeamAccessService>, agentWs: Partial<AgentWsServer> = {}) {
  return new DestinationsService(
    prisma as PrismaService,
    access as TeamAccessService,
    audit,
    crypto,
    agentWs as AgentWsServer,
  );
}

const writeAccess = { requireRole: jest.fn().mockResolvedValue(undefined), teamRole: jest.fn().mockResolvedValue("OWNER") } as unknown as TeamAccessService;
const s3Dest = { id: "d1", teamId: "t1", type: "S3", s3Bucket: "b", s3Region: "r", s3Endpoint: "s3.x", s3AccessKey: "enc:AKIA", s3SecretKey: "enc:sek", s3Prefix: "tugra" };

const s3Input = {
  teamId: "t1",
  name: "prod-s3",
  type: "S3" as const,
  s3Bucket: "b",
  s3Region: "us-east-1",
  s3Endpoint: "s3.amazonaws.com",
  s3AccessKey: "AKIA",
  s3SecretKey: "supersecret",
  s3Prefix: "tugra",
  encryptionEnabled: true,
};

describe("DestinationsService", () => {
  it("forbids creating a destination for a team the user can't write to", async () => {
    const access = {
      requireRole: jest.fn().mockRejectedValue(new ForbiddenException("nope")),
    } as unknown as TeamAccessService;
    const svc = make({}, access);
    await expect(svc.create("u1", s3Input)).rejects.toThrow(/nope/);
  });

  it("stores S3 credentials encrypted and never returns secrets", async () => {
    let saved: Record<string, unknown> = {};
    const prisma = {
      backupDestination: {
        create: jest.fn().mockImplementation(({ data }) => {
          saved = data;
          return Promise.resolve({ id: "d1", createdAt: new Date(), ...data });
        }),
      },
    } as unknown as PrismaService;
    const access = {
      requireRole: jest.fn().mockResolvedValue(undefined),
      teamRole: jest.fn().mockResolvedValue("OWNER"),
    } as unknown as TeamAccessService;
    const svc = make(prisma, access);
    const view = await svc.create("u1", s3Input);

    // credentials encrypted at rest
    expect(saved.s3AccessKey).toBe("enc:AKIA");
    expect(saved.s3SecretKey).toBe("enc:supersecret");
    expect(typeof saved.encryptionKey).toBe("string"); // generated + encrypted
    // view exposes no secrets
    expect(view).not.toHaveProperty("s3SecretKey");
    expect(view.hasCredentials).toBe(true);
    expect(view.encryptionEnabled).toBe(true);
    expect(view.s3Bucket).toBe("b");
  });
});

describe("DestinationsService.testConnection", () => {
  it("returns ok without running a command for a LOCAL destination", async () => {
    const sendCommand = jest.fn();
    const prisma = { backupDestination: { findUnique: jest.fn().mockResolvedValue({ id: "d1", teamId: "t1", type: "LOCAL" }) } } as unknown as PrismaService;
    const res = await make(prisma, writeAccess, { sendCommand }).testConnection("u1", "d1");
    expect(res.ok).toBe(true);
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("fails when no online server is available to run the test", async () => {
    const prisma = {
      backupDestination: { findUnique: jest.fn().mockResolvedValue(s3Dest) },
      server: { findFirst: jest.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    const res = await make(prisma, writeAccess, { sendCommand: jest.fn() }).testConnection("u1", "d1");
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/online server/);
  });

  it("reports OK when mc ls exits zero on an online server", async () => {
    const prisma = {
      backupDestination: { findUnique: jest.fn().mockResolvedValue(s3Dest) },
      server: { findFirst: jest.fn().mockResolvedValue({ id: "s1" }) },
    } as unknown as PrismaService;
    const sendCommand = jest.fn().mockResolvedValue({ exitCode: 0, output: "" });
    const res = await make(prisma, writeAccess, { sendCommand }).testConnection("u1", "d1");
    expect(res.ok).toBe(true);
    expect(sendCommand).toHaveBeenCalledWith("s1", expect.stringContaining("mc ls"), "backup", 30_000);
  });

  it("reports failure with the command output when mc ls exits non-zero", async () => {
    const prisma = {
      backupDestination: { findUnique: jest.fn().mockResolvedValue(s3Dest) },
      server: { findFirst: jest.fn().mockResolvedValue({ id: "s1" }) },
    } as unknown as PrismaService;
    const sendCommand = jest.fn().mockResolvedValue({ exitCode: 1, output: "AccessDenied" });
    const res = await make(prisma, writeAccess, { sendCommand }).testConnection("u1", "d1");
    expect(res.ok).toBe(false);
    expect(res.message).toContain("AccessDenied");
  });
});
