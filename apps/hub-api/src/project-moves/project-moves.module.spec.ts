import { Test } from "@nestjs/testing";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { AppMovesService } from "../app-moves/app-moves.service";
import { PartTransferService } from "../app-moves/part-transfer.service";
import { AppDatabaseLinksService } from "../applications/app-database-links.service";
import { ApplicationsService } from "../applications/applications.service";
import { DeployLeaseService } from "../applications/deploy-lease.service";
import { AuditService } from "../audit/audit.service";
import { BackupsService } from "../backups/backups.service";
import { TeamAccessService } from "../common/team-access.service";
import { DatabasesService } from "../databases/databases.service";
import { PrismaService } from "../prisma/prisma.service";
import { ProjectMovesController } from "./project-moves.controller";
import { ProjectMovesModule } from "./project-moves.module";
import { ProjectMoveRecoveryService } from "./project-move-recovery.service";
import { ProjectMoveRunnerService } from "./project-move-runner.service";
import { ProjectMovesService } from "./project-moves.service";

/** The real provider graph of the module, with every outside collaborator replaced by an empty stand-in. */
describe("ProjectMovesModule dependency graph", () => {
  const providers = [
    ...(Reflect.getMetadata("providers", ProjectMovesModule) as unknown[]),
    ...[PrismaService, TeamAccessService, AuditService, AgentWsServer, ApplicationsService, AppDatabaseLinksService, AppMovesService, DatabasesService, BackupsService, PartTransferService].map((p) => ({ provide: p, useValue: {} })),
    { provide: DeployLeaseService, useValue: { bootId: "boot-test" } },
  ];

  it("resolves every provider", async () => {
    const mod = await Test.createTestingModule({ providers: providers as never }).compile();
    expect(mod.get(ProjectMovesService)).toBeInstanceOf(ProjectMovesService);
    expect(mod.get(ProjectMoveRunnerService)).toBeInstanceOf(ProjectMoveRunnerService);
    expect(mod.get(ProjectMoveRecoveryService)).toBeInstanceOf(ProjectMoveRecoveryService);
    await mod.close();
  });

  it("registers the controller and exports the service", () => {
    expect(Reflect.getMetadata("controllers", ProjectMovesModule)).toContain(ProjectMovesController);
    expect(Reflect.getMetadata("exports", ProjectMovesModule)).toContain(ProjectMovesService);
  });
});

describe("ProjectMoveRecoveryService", () => {
  function make(rows: Array<Record<string, unknown>>) {
    const prisma = { projectMove: { findMany: jest.fn(async () => rows), updateMany: jest.fn(async () => ({ count: 1 })) } };
    const runner = { run: jest.fn(async () => undefined) };
    const moves = { purgeDue: jest.fn(async () => []) };
    const svc = new ProjectMoveRecoveryService(prisma as never, { bootId: "boot-new" } as never, runner as never, moves as never);
    return { svc, prisma, runner };
  }

  it("hands every unowned or stale-owned move to the runner, releasing another boot's claim first", async () => {
    const { svc, prisma, runner } = make([{ id: "m1", ownerId: null }, { id: "m2", ownerId: "boot-old" }]);
    expect(await svc.recover(Date.now())).toEqual(["m1", "m2"]);
    expect(prisma.projectMove.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.projectMove.updateMany).toHaveBeenCalledWith({ where: { id: "m2", ownerId: "boot-old" }, data: { ownerId: null } });
    expect(runner.run).toHaveBeenCalledWith("m1");
    expect(runner.run).toHaveBeenCalledWith("m2");
  });

  it("only looks at moves that are not over, and not at ones this process drives or another process beat recently", async () => {
    const { svc, prisma } = make([]);
    const now = Date.now();
    await svc.recover(now);
    const where = (prisma.projectMove.findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where;
    expect(where.phase).toEqual({ notIn: ["COMPLETED", "ROLLED_BACK", "FAILED"] });
    expect(JSON.stringify(where.OR)).toContain('"ownerId":{"not":"boot-new"');
    expect(JSON.stringify(where.OR)).toContain("heartbeatAt");
  });
});
