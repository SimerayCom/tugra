import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Test } from "@nestjs/testing";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { ApplicationsService } from "../applications/applications.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { PrismaService } from "../prisma/prisma.service";
import { ProxyOpsService } from "../server-ops/proxy-ops.service";
import { CoolifyInPlaceController } from "./coolify-inplace.controller";
import { CoolifyInPlaceService } from "./coolify-inplace.service";
import { INPLACE_WORLD } from "./inplace-world";
import { InPlaceWorldService } from "./inplace-world.service";

describe("CoolifyInPlaceModule wiring", () => {
  it("resolves the service through Nest DI with the production world bound to the port", async () => {
    const mod = await Test.createTestingModule({
      controllers: [CoolifyInPlaceController],
      providers: [
        CoolifyInPlaceService,
        InPlaceWorldService,
        { provide: INPLACE_WORLD, useExisting: InPlaceWorldService },
        { provide: PrismaService, useValue: {} },
        { provide: TeamAccessService, useValue: {} },
        { provide: AuditService, useValue: {} },
        { provide: AgentWsServer, useValue: {} },
        { provide: ApplicationsService, useValue: {} },
        { provide: ProxyOpsService, useValue: {} },
      ],
    })
      .overrideGuard(ApiAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(ScopesGuard)
      .useValue({ canActivate: () => true })
      .compile();
    expect(mod.get(CoolifyInPlaceService)).toBeInstanceOf(CoolifyInPlaceService);
    expect(mod.get(INPLACE_WORLD)).toBeInstanceOf(InPlaceWorldService);
    await mod.close();
  });
  it("is wired into AppModule", () => {
    expect(readFileSync(join(__dirname, "../app.module.ts"), "utf8").match(/\bCoolifyInPlaceModule\b/g)?.length).toBeGreaterThanOrEqual(2);
  });
  it("every state-changing route needs the write scope, and the ones that touch the box need deploy too", () => {
    const src = readFileSync(join(__dirname, "coolify-inplace.controller.ts"), "utf8");
    const posts = [...src.matchAll(/@Post\("([^"]+)"\)([\s\S]*?)\n  [a-zA-Z]+\(/g)];
    expect(posts.map((p) => p[1])).toEqual(["plan", ":id/test", ":id/swap", ":id/verify", ":id/give-back"]);
    for (const p of posts) expect(p[2]).toContain('@RequireScopes("write"');
    for (const p of posts.filter((x) => x[1] !== "plan")) expect(p[2]).toContain('"deploy"');
  });
});
