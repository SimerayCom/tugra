import { join } from "node:path";
import { StepHandlerRegistryService } from "../../core/step-handler.registry";
import { DataSeedHandler } from "./data-seed.handler";
import { MigratorRunner } from "./launcher/migrator-runner.service";
import { OBJECT_PLAN_CODES, OBJECT_PLAN_ID, objectPlanChecks, objectPlanFacts } from "./object-plan-check";
import { SourceHostFake } from "./testing/source-host-fake";
import { FakeCaps, FakeDataPort, FakeObjectPort, answered, inspected, makeCtx, makeRun, makeSnap } from "./testing/fakes";
import type { ObjectStorageFacts, ObjectView } from "./data-contract";

const STORE = { itemRef: "service:s:store", name: "store-a" };
const API = { itemRef: "app:s:api", name: "api" };
const facts = (o: Partial<ObjectStorageFacts> = {}): ObjectStorageFacts => ({ stores: [], dependants: [], unreadable: 0, ...o });
const view = (selected = true): ObjectView => ({ id: "om1", status: "PREFLIGHTED", phase: null, buckets: [{ srcBucket: "media", selected, status: "PENDING", diffMissing: null, diffDiffer: null, diffExtra: null }], blockers: 0, cancelRequested: false });
const run = (policy?: "hold" | "mirror" | "external", source: "request" | "default" = "request") => makeRun({ inputs: policy ? { minioPolicy: { ...answered(policy), source } } : {} });

describe("objectPlanChecks (R33)", () => {
  it("a plan without object storage has nothing to check", () => {
    expect(objectPlanChecks(run("mirror"), { objectStorage: facts() }, [])).toEqual([]);
    expect(objectPlanChecks(run("mirror"), {}, [])).toEqual([]); // a port that cannot say
  });
  it("a MinIO service or an app whose env names an object store counts; so does an env that could not be read (fail closed)", () => {
    for (const f of [facts({ stores: [STORE] }), facts({ dependants: [API] }), facts({ unreadable: 1 })]) {
      expect(objectPlanChecks(run("mirror"), { objectStorage: f }, [])[0]).toMatchObject({ id: OBJECT_PLAN_ID, status: "fail", code: OBJECT_PLAN_CODES.migrationMissing });
    }
    expect(objectPlanFacts({ objectStorage: facts({ stores: [STORE], dependants: [API], unreadable: 2 }) })).toEqual({ stores: 1, dependants: 1, unreadable: 2 });
  });
  it("mirror with no attached object migration fails with the missing-migration code and names the owner question", () => {
    const [c] = objectPlanChecks(run("mirror"), { objectStorage: facts({ stores: [STORE], dependants: [API] }) }, []);
    expect(c).toMatchObject({ status: "fail", code: OBJECT_PLAN_CODES.migrationMissing, ownerInput: "minioPolicy", params: { stores: 1, dependants: 1, attached: 0, selected: 0, policy: "mirror" } });
  });
  it("an attached migration that selects no bucket accounts for nothing", () => {
    expect(objectPlanChecks(run("mirror"), { objectStorage: facts({ stores: [STORE] }) }, [view(false)])[0]).toMatchObject({ status: "fail", code: OBJECT_PLAN_CODES.migrationMissing, params: { attached: 1, selected: 0 } });
  });
  it("an attached migration with a selected bucket passes under any policy that needs one", () => {
    for (const p of ["mirror", "hold"] as const) expect(objectPlanChecks(run(p), { objectStorage: facts({ stores: [STORE] }) }, [view()])[0]).toMatchObject({ status: "pass", code: OBJECT_PLAN_CODES.migrationAttached, params: { attached: 1, selected: 1 } });
  });
  it("external adds no row at all: the store stays where it is", () => {
    expect(objectPlanChecks(run("external"), { objectStorage: facts({ stores: [STORE], dependants: [API] }) }, [])).toEqual([]);
  });
  it("hold the owner never answered (the default) fails and asks the question; an answered hold with no attached migration fails too (only external lets it through)", () => {
    const f = { objectStorage: facts({ dependants: [API] }) };
    expect(objectPlanChecks(run(), f, [])[0]).toMatchObject({ status: "fail", code: OBJECT_PLAN_CODES.policyUnanswered, ownerInput: "minioPolicy" });
    expect(objectPlanChecks(run("hold", "default"), f, [])[0]).toMatchObject({ status: "fail", code: OBJECT_PLAN_CODES.policyUnanswered });
    expect(objectPlanChecks(makeRun({ inputs: { minioPolicy: { ...answered("hold"), value: "unknown" } as never } }), f, [])[0]).toMatchObject({ status: "fail", code: OBJECT_PLAN_CODES.policyUnanswered });
    expect(objectPlanChecks(run("hold"), f, [])[0]).toMatchObject({ status: "fail", code: OBJECT_PLAN_CODES.migrationMissing, ownerInput: "minioPolicy", params: { policy: "hold", attached: 0 } });
    expect(objectPlanChecks(run("hold"), { objectStorage: facts({ stores: [STORE] }) }, [view(false)])[0]).toMatchObject({ status: "fail", code: OBJECT_PLAN_CODES.migrationMissing });
  });
});

describe("DATA_SEED gate with object storage in the plan", () => {
  function build(storage: ObjectStorageFacts, r = run("mirror")) {
    const registry = new StepHandlerRegistryService();
    const data = new FakeDataPort(makeSnap({ volumes: [inspected("volume:s:a:data")], objectStorage: storage }));
    const objects = new FakeObjectPort();
    const host = new SourceHostFake({ containers: [] });
    const handler = new DataSeedHandler(registry, data, objects, new MigratorRunner(host, data, new FakeCaps(), join(host.dir, "runs")));
    handler.onModuleInit();
    return { handler, objects, ctx: (extra: Partial<Parameters<typeof makeCtx>[0]> = {}) => makeCtx({ key: "DATA_SEED", run: r, ...extra }) };
  }
  const attach = (id: string) => ({ DATA_SEED: { evidence: { attestations: [], attachments: [{ kind: "object-migration" as const, resourceId: id, byUserId: "user1", at: "2026-11-20T09:00:00Z" }] } } });

  it("parks BEFORE anything is launched while the plan has a MinIO and no migration is attached", async () => {
    const { handler, ctx } = build(facts({ stores: [STORE] }));
    const h = ctx();
    const obs = await handler.observe(h.ctx);
    const pre = handler.preGate(h.ctx, obs);
    expect(pre.passed).toBe(false);
    expect(pre.checks.map((c) => c.code)).toContain(OBJECT_PLAN_CODES.migrationMissing);
    expect(handler.postGate(h.ctx, obs).passed).toBe(false);
  });
  it("the same plan passes the gate once a migration with a selected bucket is attached", async () => {
    const { handler, objects, ctx } = build(facts({ stores: [STORE] }));
    objects.add({ id: "om1", status: "SEEDED", buckets: [{ srcBucket: "media", selected: true, status: "SEEDED", diffMissing: null, diffDiffer: null, diffExtra: null }] });
    const h = ctx({ steps: attach("om1") });
    const obs = await handler.observe(h.ctx);
    expect(handler.preGate(h.ctx, obs).passed).toBe(true);
    expect(handler.postGate(h.ctx, obs).checks.find((c) => c.id === OBJECT_PLAN_ID)).toMatchObject({ status: "pass", code: OBJECT_PLAN_CODES.migrationAttached });
  });
  it("minioPolicy external lets the same plan through with no migration", async () => {
    const { handler, ctx } = build(facts({ stores: [STORE], dependants: [API] }), run("external"));
    const h = ctx();
    const obs = await handler.observe(h.ctx);
    expect(handler.preGate(h.ctx, obs).passed).toBe(true);
    expect(handler.postGate(h.ctx, obs).checks.some((c) => c.id === OBJECT_PLAN_ID)).toBe(false);
  });
  it("an answered hold with no migration parks the gate before anything moves, like mirror", async () => {
    const { handler, ctx } = build(facts({ stores: [STORE] }), run("hold"));
    const h = ctx();
    const obs = await handler.observe(h.ctx);
    const pre = handler.preGate(h.ctx, obs);
    expect(pre.passed).toBe(false);
    expect(pre.checks.map((c) => c.code)).toContain(OBJECT_PLAN_CODES.migrationMissing);
  });
  it("the dry run reports the verdict as a block item", async () => {
    const { handler, ctx } = build(facts({ stores: [STORE] }));
    const items = await handler.dryRun(ctx().ctx);
    expect(items.find((i) => i.code === OBJECT_PLAN_CODES.migrationMissing)).toMatchObject({ level: "block" });
  });
});
