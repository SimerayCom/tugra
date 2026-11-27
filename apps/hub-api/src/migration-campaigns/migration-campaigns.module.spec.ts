import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Test } from "@nestjs/testing";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { CoolifyInPlaceService } from "../coolify-inplace/coolify-inplace.service";
import { ImporterService } from "../importer/importer.service";
import { MIGRATION_RUNS_FACADE } from "../migration-runs/core/run-contract";
import { PrismaService } from "../prisma/prisma.service";
import { CampaignFactsService } from "./campaign-facts.service";
import { MigrationCampaignsController } from "./migration-campaigns.controller";
import { MigrationCampaignsService } from "./migration-campaigns.service";

describe("MigrationCampaignsModule wiring", () => {
  it("resolves the service and its controller through Nest DI", async () => {
    const mod = await Test.createTestingModule({
      controllers: [MigrationCampaignsController],
      providers: [
        MigrationCampaignsService,
        CampaignFactsService,
        { provide: PrismaService, useValue: {} },
        { provide: TeamAccessService, useValue: {} },
        { provide: AuditService, useValue: {} },
        { provide: ImporterService, useValue: {} },
        { provide: MIGRATION_RUNS_FACADE, useValue: {} },
        { provide: CoolifyInPlaceService, useValue: {} },
      ],
    })
      .overrideGuard(ApiAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(ScopesGuard)
      .useValue({ canActivate: () => true })
      .compile();
    expect(mod.get(MigrationCampaignsService)).toBeInstanceOf(MigrationCampaignsService);
    expect(mod.get(MigrationCampaignsController)).toBeInstanceOf(MigrationCampaignsController);
    await mod.close();
  });
  it("the routes that create or cancel runs need the deploy scope (create also read:secrets, like a run create)", () => {
    const src = readFileSync(join(__dirname, "migration-campaigns.controller.ts"), "utf8");
    expect(src).toMatch(/@Post\(\)\s+@RequireScopes\("deploy", "read:secrets"\)/);
    expect(src).toMatch(/@Post\(":id\/cancel"\)\s+@HttpCode\(200\)\s+@RequireScopes\("deploy"\)/);
  });
});
