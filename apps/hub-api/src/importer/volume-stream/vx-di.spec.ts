import "reflect-metadata";
import { MODULE_METADATA } from "@nestjs/common/constants";
import { ImporterModule } from "../importer.module";
import { ImportExecutorService } from "../import-executor.service";
import { MigrationIngestService } from "../migration-ingest.service";
import { MigrationVolumeController } from "./vx.controller";
import { VxService } from "./vx.service";
import { VxApplyService } from "./vx-apply.service";
import { VxRecoveryService } from "./vx-recovery.service";
import { VxPartRegistry } from "./vx-part-registry";
import { AppMovesModule } from "../../app-moves/app-moves.module";
import { AgentGatewayModule } from "../../agent-gateway/agent-gateway.module";
import { VolumeRelayService } from "../../app-moves/volume-relay.service";
import { AgentWsServer } from "../../agent-gateway/agent-ws.server";

/**
 * Cheap guard against the two ways Nest wiring breaks silently at BOOT (not in unit tests): an `undefined` injection token
 * (a circular import evaluated in the wrong order) and a provider that no module makes available.
 */
describe("volume stream dependency-injection wiring", () => {
  const params = (cls: unknown): unknown[] => Reflect.getMetadata("design:paramtypes", cls as object) ?? [];

  it.each([
    ["VxService", VxService],
    ["VxApplyService", VxApplyService],
    ["VxRecoveryService", VxRecoveryService],
    ["MigrationVolumeController", MigrationVolumeController],
    ["MigrationIngestService", MigrationIngestService],
    ["ImportExecutorService", ImportExecutorService],
  ])("%s has no undefined constructor token (no circular-import hole)", (_n, cls) => {
    const ps = params(cls);
    expect(ps.length).toBeGreaterThan(0);
    expect(ps.map((p, i) => (typeof p === "function" ? null : `${_n} param ${i}`)).filter(Boolean)).toEqual([]);
  });

  it("the importer module provides the stream's services and controller, and imports the modules that export the relay and the agent gateway", () => {
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ImporterModule) as unknown[];
    const controllers = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, ImporterModule) as unknown[];
    const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, ImporterModule) as unknown[];
    for (const c of [VxService, VxApplyService, VxRecoveryService, VxPartRegistry]) expect(providers).toContain(c);
    expect(controllers).toContain(MigrationVolumeController);
    expect(imports).toContain(AppMovesModule);
    expect(imports).toContain(AgentGatewayModule);
    expect(Reflect.getMetadata(MODULE_METADATA.EXPORTS, AppMovesModule)).toContain(VolumeRelayService);
    expect(Reflect.getMetadata(MODULE_METADATA.EXPORTS, AgentGatewayModule)).toContain(AgentWsServer);
  });

  it("every constructor dependency of the new services is a known provider of the importer module or an exported one", () => {
    const local = new Set(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ImporterModule) as unknown[]);
    const exported = new Set<unknown>([VolumeRelayService, AgentWsServer]);
    const globalish = new Set(["PrismaService", "TeamAccessService", "AuditService", "ConfigService", "DatabasesService"]);
    const unknown: string[] = [];
    for (const cls of [VxService, VxApplyService, VxRecoveryService]) {
      for (const p of params(cls) as Array<{ name: string }>) if (!(local.has(p) || exported.has(p) || globalish.has(p.name))) unknown.push(`${cls.name} <- ${p.name}`);
    }
    expect(unknown).toEqual([]);
  });
});
