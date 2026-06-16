import { ForbiddenException } from "@nestjs/common";
import { DestinationsService } from "./destinations.service";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";
import { CryptoService } from "../crypto/crypto.service";

const audit = { log: jest.fn() } as unknown as AuditService;
const crypto = {
  encrypt: (s: string) => `enc:${s}`,
  decrypt: (s: string) => s.replace(/^enc:/, ""),
} as unknown as CryptoService;

function make(prisma: Partial<PrismaService>, access: Partial<TeamAccessService>) {
  return new DestinationsService(
    prisma as PrismaService,
    access as TeamAccessService,
    audit,
    crypto,
  );
}

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
