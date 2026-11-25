import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Test } from "@nestjs/testing";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { TeamAccessService } from "../common/team-access.service";
import { PrismaService } from "../prisma/prisma.service";
import { CoolifyCleanupService } from "../coolify-cleanup/coolify-cleanup.service";
import { CoolifyInPlaceService } from "../coolify-inplace/coolify-inplace.service";
import { CoolifyHostGrantService } from "../coolify-takeover/coolify-host-grant.service";
import { CoolifySshInstallService } from "../coolify-takeover/coolify-ssh-install.service";
import { HostMatchService } from "../coolify-takeover/host-match.service";
import { CoolifyTakeoverService } from "../coolify-takeover/coolify-takeover.service";
import { MigrationCampaignsService } from "../migration-campaigns/migration-campaigns.service";
import { ProjectMovesService } from "../project-moves/project-moves.service";
import { CoolifyMoveController } from "./coolify-move.controller";
import { CoolifyMoveModule } from "./coolify-move.module";
import { CoolifyMoveService } from "./coolify-move.service";
import { StatusQuerySchema } from "./dto";

describe("CoolifyMoveModule", () => {
  it("resolves the service and the controller through Nest DI", async () => {
    const mod = await Test.createTestingModule({
      controllers: [CoolifyMoveController],
      providers: [
        CoolifyMoveService,
        ...[PrismaService, TeamAccessService, CoolifyTakeoverService, CoolifyHostGrantService, CoolifySshInstallService, CoolifyInPlaceService, MigrationCampaignsService, CoolifyCleanupService, ProjectMovesService, HostMatchService].map((p) => ({ provide: p, useValue: {} })),
      ],
    })
      .overrideGuard(ApiAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(ScopesGuard)
      .useValue({ canActivate: () => true })
      .compile();
    expect(mod.get(CoolifyMoveService)).toBeInstanceOf(CoolifyMoveService);
    expect(mod.get(CoolifyMoveController)).toBeInstanceOf(CoolifyMoveController);
    await mod.close();
  });

  it("is wired into AppModule and the MCP module, and every service it needs is exported by its module", () => {
    const app = readFileSync(join(__dirname, "../app.module.ts"), "utf8");
    expect(app.match(/\bCoolifyMoveModule\b/g)?.length).toBeGreaterThanOrEqual(2);
    expect(Reflect.getMetadata("imports", require("../mcp/mcp.module").McpModule)).toContain(CoolifyMoveModule);
    expect(Reflect.getMetadata("exports", CoolifyMoveModule)).toContain(CoolifyMoveService);
  });

  it("the controller only reads: one GET route, no write route, no body", () => {
    const src = readFileSync(join(__dirname, "coolify-move.controller.ts"), "utf8");
    expect([...src.matchAll(/@(Get|Post|Put|Patch|Delete)\(/g)].map((m) => m[1])).toEqual(["Get"]);
    expect(src).not.toContain("@Body(");
    expect(src).toContain("@UseGuards(ApiAuthGuard, ScopesGuard)");
  });
});

describe("StatusQuerySchema", () => {
  it("takes a team id and nothing else", () => {
    expect(StatusQuerySchema.safeParse({ teamId: "t1" }).success).toBe(true);
    expect(StatusQuerySchema.safeParse({}).success).toBe(false);
    expect(StatusQuerySchema.safeParse({ teamId: "" }).success).toBe(false);
    expect(StatusQuerySchema.safeParse({ teamId: "t1", serverId: "s" }).success).toBe(false);
  });
});
