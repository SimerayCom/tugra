import { Test } from "@nestjs/testing";
import { ApiAuthGuard } from "../../../api-tokens/api-auth.guard";
import { ScopesGuard } from "../../../api-tokens/scopes.guard";
import { TeamAccessService } from "../../../common/team-access.service";
import { PrismaService } from "../../../prisma/prisma.service";
import { StepRegistryModule } from "../../core/step-registry.module";
import { STEP_HANDLERS, type StepHandlerRegistry } from "../../core/run-contract";
import { PostPonrRelease } from "./baseline/post-ponr";
import { PrismaRunHints, RUN_HINTS } from "./baseline/run-hints";
import { RunSafetyController } from "./baseline/safety.controller";
import { IMPORT_STEPS_PORT } from "./import-ports";
import { DeployDarkStep } from "./deploy-dark.step";
import { ImportStep } from "./import.step";
import { PreflightStep } from "./preflight.step";
import { RemapEnvStep } from "./remap-env.step";
import { RunImportStepsModule } from "./run-import-steps.module";

describe("RunImportStepsModule wiring (safety lane)", () => {
  it("declares the safety controller and exports the hint store and the release for the cutover steps", () => {
    expect(Reflect.getMetadata("controllers", RunImportStepsModule)).toEqual([RunSafetyController]);
    const exports = Reflect.getMetadata("exports", RunImportStepsModule) as unknown[];
    expect(exports).toEqual(expect.arrayContaining([RUN_HINTS, PostPonrRelease, IMPORT_STEPS_PORT]));
  });

  it("resolves through Nest DI: one hint store shared by the steps, the release and the controller", async () => {
    const mod = await Test.createTestingModule({
      imports: [StepRegistryModule],
      controllers: [RunSafetyController],
      providers: [
        PrismaRunHints,
        { provide: RUN_HINTS, useExisting: PrismaRunHints },
        PostPonrRelease,
        PreflightStep,
        ImportStep,
        RemapEnvStep,
        DeployDarkStep,
        { provide: IMPORT_STEPS_PORT, useValue: {} },
        { provide: PrismaService, useValue: {} },
        { provide: TeamAccessService, useValue: {} },
      ],
    })
      .overrideGuard(ApiAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(ScopesGuard)
      .useValue({ canActivate: () => true })
      .compile();
    await mod.init();
    const hints = mod.get(RUN_HINTS);
    expect(hints).toBeInstanceOf(PrismaRunHints);
    for (const h of [PreflightStep, ImportStep, DeployDarkStep]) expect((mod.get(h) as unknown as { hintStore: unknown }).hintStore).toBe(hints);
    expect((mod.get(PostPonrRelease) as unknown as { hints: unknown }).hints).toBe(hints);
    expect((mod.get(RunSafetyController) as unknown as { hints: unknown }).hints).toBe(hints);
    expect(mod.get<StepHandlerRegistry>(STEP_HANDLERS).list().map((h) => h.key)).toEqual(["PREFLIGHT", "IMPORT", "REMAP_ENV", "DEPLOY_DARK"]);
    await mod.close();
  });
});
