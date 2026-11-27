import "reflect-metadata";
import { MODULE_METADATA } from "@nestjs/common/constants";
import { ImporterModule } from "./importer.module";
import { AgentSecretsAdapter } from "./agent-secrets.adapter";
import { ImportSourceFactory } from "./sources/import-source.factory";
import { AgentCoolifyReader } from "./agent-coolify.reader";
import { CaproverClientFactory } from "./sources/caprover-client.factory";
import { CoolifyTakeoverModule } from "../coolify-takeover/coolify-takeover.module";
import { CoolifySecretsService } from "../coolify-takeover/coolify-secrets.service";
import { CoolifyHostGrantService } from "../coolify-takeover/coolify-host-grant.service";
import { CryptoModule } from "../crypto/crypto.module";
import { CryptoService } from "../crypto/crypto.service";

/** The sealed secrets of an agent session: the wiring that breaks silently at boot (an undefined token, a provider no module makes available). */
describe("agent secrets dependency-injection wiring", () => {
  const params = (cls: unknown): unknown[] => Reflect.getMetadata("design:paramtypes", cls as object) ?? [];

  it("the adapter and the factory have no undefined constructor token, and the factory takes the adapter after the reader", () => {
    for (const cls of [AgentSecretsAdapter, ImportSourceFactory]) expect(params(cls).every((p) => typeof p === "function")).toBe(true);
    expect(params(AgentSecretsAdapter)).toEqual([CoolifySecretsService, CoolifyHostGrantService, CryptoService]);
    expect(params(ImportSourceFactory).slice(2)).toEqual([AgentCoolifyReader, AgentSecretsAdapter, CaproverClientFactory]);
  });

  it("the importer module provides the adapter, and imports the modules that export what it needs", () => {
    expect(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ImporterModule)).toContain(AgentSecretsAdapter);
    const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, ImporterModule) as unknown[];
    expect(imports).toContain(CoolifyTakeoverModule);
    expect(imports).toContain(CryptoModule);
    const exported = Reflect.getMetadata(MODULE_METADATA.EXPORTS, CoolifyTakeoverModule) as unknown[];
    expect(exported).toContain(CoolifySecretsService);
    expect(exported).toContain(CoolifyHostGrantService);
    expect(Reflect.getMetadata(MODULE_METADATA.EXPORTS, CryptoModule)).toContain(CryptoService);
  });
});
