import { Test } from "@nestjs/testing";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { ApplicationsService } from "../applications/applications.service";
import { DeployLeaseService } from "../applications/deploy-lease.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { DatabasesService } from "../databases/databases.service";
import { DnsAutomationService } from "../dns/dns-automation.service";
import { ImportExecutorService } from "../importer/import-executor.service";
import { ImporterService } from "../importer/importer.service";
import { PrismaService } from "../prisma/prisma.service";
import { ProxyConfigService } from "../proxy-config/proxy-config.service";
import { MigrationRunsService } from "./core/migration-runs.service";
import { MIGRATION_RUNS_FACADE, STEP_HANDLERS, type StepHandlerRegistry } from "./core/run-contract";
import { RunEngineService } from "./core/run-engine.service";
import { RunRecoveryService } from "./core/run-recovery.service";
import { StepRegistryModule } from "./core/step-registry.module";
import { MigrationRunsModule } from "./migration-runs.module";
import { RunImportStepsModule } from "./steps/import/run-import-steps.module";

/** The real provider graph of the two modules, with every outside collaborator replaced by an empty stand-in. */
describe("MigrationRunsModule dependency graph", () => {
  it("resolves, binds the real service to the facade token and registers lane A's four handlers on init", async () => {
    const providers = [
      ...(Reflect.getMetadata("providers", MigrationRunsModule) as unknown[]),
      ...(Reflect.getMetadata("providers", RunImportStepsModule) as unknown[]),
      ...[PrismaService, TeamAccessService, ImporterService, AuditService, ImportExecutorService, ApplicationsService, DatabasesService, AgentWsServer, ProxyConfigService, DnsAutomationService].map((p) => ({ provide: p, useValue: {} })),
      { provide: DeployLeaseService, useValue: { bootId: "boot-test" } },
    ];
    const mod = await Test.createTestingModule({ imports: [StepRegistryModule], providers: providers as never }).compile();
    await mod.init();
    expect(mod.get(MIGRATION_RUNS_FACADE)).toBeInstanceOf(MigrationRunsService);
    expect(mod.get(RunEngineService).bootId).toBe("boot-test");
    expect(mod.get(RunEngineService).terminalHook).toBeDefined();
    expect(mod.get(RunRecoveryService)).toBeDefined();
    const reg = mod.get<StepHandlerRegistry>(STEP_HANDLERS);
    expect(reg.list().map((h) => h.key)).toEqual(["PREFLIGHT", "IMPORT", "REMAP_ENV", "DEPLOY_DARK"]);
    // lanes B and C fill the other nine; until they do a REAL run is refused at start
    expect(reg.missing("copy")).toEqual(["DNS_PREPARE", "DATA_SEED", "FREEZE", "DATA_FINAL", "TLS_PREISSUE", "VERIFY", "CUTOVER", "OBSERVE", "FINALIZE"]);
    expect(reg.missing("takeover")).toContain("DECOMMISSION");
    await mod.close();
  });
});
