import { ConflictException } from "@nestjs/common";
import { DestinationsService } from "./destinations.service";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";
import { CryptoService } from "../crypto/crypto.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";

/** A destination pinned by a PITR-enabled database cannot be deleted (the WAL chain + bases live there). */
function make(pinnedCount: number) {
  const dest = { id: "d1", teamId: "t1", name: "s3", type: "S3" };
  const del = jest.fn().mockResolvedValue(dest);
  const updateMany = jest.fn().mockResolvedValue({ count: 0 });
  const prisma = {
    backupDestination: { findUnique: jest.fn().mockResolvedValue(dest), delete: del },
    database: { count: jest.fn().mockResolvedValue(pinnedCount), updateMany },
  } as unknown as PrismaService;
  const access = {
    requirePermission: jest.fn().mockResolvedValue(undefined),
    teamRole: jest.fn().mockResolvedValue("OWNER"),
    permissionsByTeam: jest.fn().mockResolvedValue(new Map([["t1", new Set(["integrations", "backups"])]])),
    requireResourceAccess: jest.fn().mockResolvedValue(undefined),
  } as unknown as TeamAccessService;
  const svc = new DestinationsService(prisma, access, { log: jest.fn() } as unknown as AuditService, {} as CryptoService, {} as AgentWsServer);
  return { svc, del, updateMany };
}

describe("DestinationsService.remove — refused while a PITR database is pinned to it", () => {
  it("409 when any pitrEnabled database uses the destination; nothing is detached or deleted", async () => {
    const { svc, del, updateMany } = make(2);
    await expect(svc.remove("u1", "d1")).rejects.toBeInstanceOf(ConflictException);
    expect(del).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("deletes normally (detaching non-PITR databases to LOCAL) when nothing is pinned", async () => {
    const { svc, del, updateMany } = make(0);
    await svc.remove("u1", "d1");
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { backupDestinationId: null } }));
    expect(del).toHaveBeenCalled();
  });
});
