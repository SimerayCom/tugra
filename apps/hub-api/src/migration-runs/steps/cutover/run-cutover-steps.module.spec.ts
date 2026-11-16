import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { AgentWsServer } from "../../../agent-gateway/agent-ws.server";
import { APPLICATIONS_SERVICE } from "../../../applications/applications.tokens";
import { AuditService } from "../../../audit/audit.service";
import { CryptoService } from "../../../crypto/crypto.service";
import { CutoverCertService } from "../../../cutover/cutover-cert.service";
import { CutoverService } from "../../../cutover/cutover.service";
import { NetProbe } from "../../../cutover/net-probe";
import { InstanceSettingsService } from "../../../instance/instance-settings.service";
import { PrismaService } from "../../../prisma/prisma.service";
import { ProxyOpsService } from "../../../server-ops/proxy-ops.service";
import { StepHandlerRegistryService } from "../../core/step-handler.registry";
import { StepRegistryModule } from "../../core/step-registry.module";
import { STEP_HANDLERS, STEP_MANIFEST, STEP_KEYS, type StepHandlerRegistry, type StepKey } from "../../core/run-contract";
import { CutoverHandler } from "./cutover.handler";
import { CutoverPlanService } from "./cutover-plan.service";
import { CutoverWorld } from "./cutover-world.service";
import { DecommissionHandler } from "./decommission.handler";
import { DnsPrepareHandler } from "./dns-prepare.handler";
import { FinalizeHandler } from "./finalize.handler";
import { ObserveHandler } from "./observe.handler";
import { TlsPreissueHandler } from "./tls-preissue.handler";
import { makeRig } from "./testing/cutover-rig";

const LANE_C: StepKey[] = STEP_KEYS.filter((k) => STEP_MANIFEST[k].lane === "C");

describe("lane C registration", () => {
  it("lane C owns exactly the six cutover-side steps", () => {
    expect(LANE_C).toEqual(["DNS_PREPARE", "TLS_PREISSUE", "CUTOVER", "OBSERVE", "FINALIZE", "DECOMMISSION"]);
  });

  it("every handler matches the manifest (kind / rollback class / skippable) and registers exactly once", () => {
    const rig = makeRig();
    const registry = new StepHandlerRegistryService();
    const hs = [rig.handlers.dns, rig.handlers.tls, rig.handlers.cut, rig.handlers.obs, rig.handlers.fin, rig.handlers.dec];
    for (const h of hs) registry.register(h as never);
    expect(registry.list().map((h) => h.key)).toEqual(LANE_C);
    expect(registry.missing("takeover").filter((k) => LANE_C.includes(k))).toEqual([]);
    expect(() => registry.register(rig.handlers.cut as never)).toThrow(/registered twice/);
    for (const h of hs) {
      expect(h.kind).toBe(STEP_MANIFEST[h.key].kind);
      expect(h.rollback).toBe(STEP_MANIFEST[h.key].rollback);
    }
  });

  it("a copy-mode run does not need DECOMMISSION (the registry only demands it for takeover)", () => {
    const registry = new StepHandlerRegistryService();
    const rig = makeRig();
    for (const h of [rig.handlers.dns, rig.handlers.tls, rig.handlers.cut, rig.handlers.obs, rig.handlers.fin]) registry.register(h as never);
    expect(registry.missing("copy").filter((k) => LANE_C.includes(k))).toEqual([]);
    expect(registry.missing("takeover").filter((k) => LANE_C.includes(k))).toEqual(["DECOMMISSION"]);
  });

  it("the CUTOVER handler is the only one that may mark the point of no return", () => {
    expect(LANE_C.filter((k) => STEP_MANIFEST[k].ponr)).toEqual(["CUTOVER"]);
    expect(STEP_MANIFEST.DECOMMISSION.manual).toBe(true);
  });
});

describe("RunCutoverStepsModule wiring", () => {
  it("resolves every provider through Nest DI and each handler self-registers on module init", async () => {
    const mod = await Test.createTestingModule({
      imports: [StepRegistryModule],
      providers: [
        CutoverWorld,
        CutoverPlanService,
        DnsPrepareHandler,
        TlsPreissueHandler,
        CutoverHandler,
        ObserveHandler,
        FinalizeHandler,
        DecommissionHandler,
        { provide: CutoverService, useValue: {} },
        { provide: CutoverCertService, useValue: {} },
        { provide: ProxyOpsService, useValue: {} },
        { provide: NetProbe, useValue: {} },
        { provide: APPLICATIONS_SERVICE, useValue: {} },
        { provide: PrismaService, useValue: {} },
        { provide: AgentWsServer, useValue: {} },
        { provide: InstanceSettingsService, useValue: {} },
        { provide: ConfigService, useValue: {} },
        { provide: AuditService, useValue: {} },
        { provide: CryptoService, useValue: {} },
      ],
    }).compile();
    await mod.init();
    const registry = mod.get<StepHandlerRegistry>(STEP_HANDLERS);
    expect(registry.list().map((h) => h.key)).toEqual(LANE_C);
    expect(mod.get(CutoverPlanService)).toBeInstanceOf(CutoverPlanService);
    await mod.close();
  });
});
