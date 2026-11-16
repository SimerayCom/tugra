import { Test } from "@nestjs/testing";
import { STEP_HANDLERS, STEP_KEYS, STEP_MANIFEST, type StepHandlerRegistry } from "../../core/run-contract";
import { StepRegistryModule } from "../../core/step-registry.module";
import { CAPABILITY_PORT, CHECK_STORE, DATA_PORT, DB_STATS_PORT, DRIFT_PORT, FLIP_PLAN_PORT, OBJECT_PORT, RUNTIME_PORT, SOURCE_API_PORT, SOURCE_HOST_PORT } from "./data-contract";
import { DataFinalHandler } from "./data-final.handler";
import { DataSeedHandler } from "./data-seed.handler";
import { FreezeHandler } from "./freeze.handler";
import { MigratorRunner } from "./launcher/migrator-runner.service";
import { MemoryCheckStore } from "./verify/check-store";
import { VerifyHandler } from "./verify.handler";
import { FakeCaps, FakeDataPort, FakeDrift, FakeFlip, FakeObjectPort, FakeRuntime, FakeSourceApi, FakeStats } from "./testing/fakes";
import { SourceHostFake } from "./testing/source-host-fake";

describe("RunDataStepsModule wiring (real Nest DI, fake ports)", () => {
  it("every lane-B handler registers itself with the global registry at init, matching the manifest", async () => {
    const host = new SourceHostFake({ containers: [] });
    const moduleRef = await Test.createTestingModule({
      imports: [StepRegistryModule],
      providers: [
        MigratorRunner,
        DataSeedHandler,
        FreezeHandler,
        DataFinalHandler,
        VerifyHandler,
        { provide: DATA_PORT, useValue: new FakeDataPort() },
        { provide: OBJECT_PORT, useValue: new FakeObjectPort() },
        { provide: SOURCE_HOST_PORT, useValue: host },
        { provide: SOURCE_API_PORT, useValue: new FakeSourceApi() },
        { provide: CAPABILITY_PORT, useValue: new FakeCaps() },
        { provide: CHECK_STORE, useValue: new MemoryCheckStore() },
        { provide: DB_STATS_PORT, useValue: new FakeStats() },
        { provide: RUNTIME_PORT, useValue: new FakeRuntime() },
        { provide: FLIP_PLAN_PORT, useValue: new FakeFlip() },
        { provide: DRIFT_PORT, useValue: new FakeDrift() },
      ],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    const registry = app.get<StepHandlerRegistry>(STEP_HANDLERS);

    const mine = STEP_KEYS.filter((k) => STEP_MANIFEST[k].lane === "B");
    expect(mine).toEqual(["DATA_SEED", "FREEZE", "DATA_FINAL", "VERIFY"]);
    for (const k of mine) {
      const h = registry.get(k);
      expect(h).toBeDefined();
      expect(h).toMatchObject({ key: k, kind: STEP_MANIFEST[k].kind, rollback: STEP_MANIFEST[k].rollback });
      expect(h!.skippable ?? false).toBe(STEP_MANIFEST[k].skippable ?? false);
    }
    // lanes A and C have not registered here: the engine refuses a REAL run until they have
    expect(registry.missing("copy")).toEqual(STEP_KEYS.filter((k) => STEP_MANIFEST[k].lane !== "B" && k !== "DECOMMISSION"));
    await app.close();
    host.dispose();
  });
});
