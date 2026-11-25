import { Test } from "@nestjs/testing";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { CryptoService } from "../crypto/crypto.service";
import { PrismaService } from "../prisma/prisma.service";
import { ServersService } from "../servers/servers.service";
import { CoolifyCleanupController } from "./coolify-cleanup.controller";
import { CoolifyCleanupModule } from "./coolify-cleanup.module";
import { CoolifyCleanupService } from "./coolify-cleanup.service";
import { ConfirmSchema } from "./dto";

describe("CoolifyCleanupModule dependency graph", () => {
  it("resolves the service", async () => {
    const providers = [...(Reflect.getMetadata("providers", CoolifyCleanupModule) as unknown[]), ...[PrismaService, TeamAccessService, AuditService, AgentWsServer, ServersService, CryptoService].map((p) => ({ provide: p, useValue: {} }))];
    const mod = await Test.createTestingModule({ providers: providers as never }).compile();
    expect(mod.get(CoolifyCleanupService)).toBeInstanceOf(CoolifyCleanupService);
    await mod.close();
  });
  it("registers the controller and exports the service", () => {
    expect(Reflect.getMetadata("controllers", CoolifyCleanupModule)).toContain(CoolifyCleanupController);
    expect(Reflect.getMetadata("exports", CoolifyCleanupModule)).toContain(CoolifyCleanupService);
  });
});

describe("ConfirmSchema", () => {
  const hash = "a".repeat(64);
  it("takes the server name and a 64-hex list fingerprint, nothing else", () => {
    expect(ConfirmSchema.safeParse({ confirm: "box", listHash: hash }).success).toBe(true);
    expect(ConfirmSchema.safeParse({ confirm: "box", listHash: "short" }).success).toBe(false);
    expect(ConfirmSchema.safeParse({ confirm: "", listHash: hash }).success).toBe(false);
    expect(ConfirmSchema.safeParse({ confirm: "box", listHash: hash, force: true }).success).toBe(false);
  });
});
