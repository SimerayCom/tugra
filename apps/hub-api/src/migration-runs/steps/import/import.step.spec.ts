import { ConflictException, ForbiddenException, Logger } from "@nestjs/common";
import { ACTOR, RunWorld, defaultPlan } from "../../core/testing/run-world";
import { CLEANUP_REQUEST_KEY } from "../../core/run-engine.service";

beforeAll(() => {
  jest.spyOn(Logger.prototype, "warn").mockImplementation();
  jest.spyOn(Logger.prototype, "error").mockImplementation();
  jest.spyOn(Logger.prototype, "log").mockImplementation();
});

const importStep = async (w: RunWorld, id: string) => (await w.view(id)).steps.find((s) => s.key === "IMPORT")!;

describe("IMPORT", () => {
  it("applies the frozen secret-free input exactly once and records the op on the run", async () => {
    const w = new RunWorld();
    const id = await w.create({ environmentId: "env1", acks: [{ code: "app.env.unresolved" }], dbDataModes: { "database:_:db1": "volume" } });
    const seen: unknown[] = [];
    const orig = w.port.apply.bind(w.port);
    w.port.apply = async (u, input) => {
      seen.push(input);
      return orig(u, input);
    };
    await w.start(id);
    await w.settle(id);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ sourceKind: "coolify", sessionId: "s1", targetServerId: "srv1", environmentId: "env1", dbDataModes: { "database:_:db1": "volume" } });
    expect(JSON.stringify(seen[0])).not.toMatch(/token|password|secret/i);
    expect(w.store.row(id).opId).toBe("op-1");
    expect((await importStep(w, id)).progress).toMatchObject({ unit: "item" });
    expect(w.store.step(id, "IMPORT").compensation).toMatchObject({ applyDone: true });
  });

  it("an op that is still fanning out is polled, not re-applied", async () => {
    const w = new RunWorld();
    const id = await w.run();
    expect(w.port.calls.filter((c) => c === "apply")).toHaveLength(1);
    expect(w.clock.sleeps).toBeGreaterThan(0);
    expect(w.status(id)).toBe("COMPLETED");
  });

  it("a hub restart with the fan-out dead cancels, waits for the stale tasks, rolls back and re-applies (recover trigger)", async () => {
    const w = new RunWorld({ stubs: { DATA_SEED: { blocked: (x) => !x.done.has("go") } } });
    // freeze the fan-out right after the apply: a settled-op test needs the process to die mid-import
    const id = await w.create();
    await w.start(id);
    const real = w.port.apply.bind(w.port);
    w.port.apply = async (u, i) => {
      const r = await real(u, i);
      w.port.killProcess(); // the in-process fan-out dies with the "process"
      return r;
    };
    await w.engine.drive(id);
    // alive=false and tasks PENDING: IMPORT keeps polling until the hub is restarted
    w.restart();
    await w.tick(10);
    w.clock.advance(60_000);
    await w.tick(10);
    expect(w.port.calls.filter((c) => c === "apply" || c.startsWith("cancel:") || c.startsWith("rollback:"))).toEqual(["apply", "cancel:op-1", "rollback:op-1", "apply"]);
    expect(w.store.row(id).opHistory).toEqual(["op-1"]);
    expect(w.store.codes(id)).toEqual(expect.arrayContaining(["import.redo", "run.recovered"]));
  });

  it("a rollback that finds leftovers fails with import.rollback-incomplete (no silent duplicate on re-apply)", async () => {
    const w = new RunWorld();
    w.port.failItems.add("app:_:web");
    const orig = w.port.rollbackOp.bind(w.port);
    w.port.rollbackOp = async (u, op, o) => {
      await orig(u, op, o);
      const t = w.port.ops.get(op)!.tasks.find((x) => x.status === "ROLLED_BACK" || x.status === "DONE");
      if (t) t.status = "DONE"; // the importer skipped one resource ("rollback skipped: ...")
    };
    const id = await w.run();
    await w.service.retry(ACTOR, id, "IMPORT", {});
    await w.settle(id, "retry");
    expect(w.store.row(id).failureCode).toBe("import.rollback-incomplete");
    expect((await importStep(w, id)).allowed.retry).toBe(false);
  });

  it("apply refusals become deterministic codes: plan-changed is final, a coded conflict keeps its code", async () => {
    const w = new RunWorld();
    w.port.failApplyWith = new ConflictException("the plan changed since it was previewed - re-run the plan and review again");
    const id = await w.run();
    expect(w.store.row(id).failureCode).toBe("import.plan-changed");
    expect((await importStep(w, id)).allowed.retry).toBe(false);

    const w2 = new RunWorld();
    w2.port.failApplyWith = new ConflictException({ statusCode: 409, message: "x", code: "import.mapping_required" });
    const id2 = await w2.run();
    expect(w2.store.row(id2).failureCode).toBe("import.apply.mapping-required");
    expect(w2.store.step(id2, "IMPORT").compensation).toMatchObject({ applyStartedAt: null }); // the service answered: no op was created

    const w3 = new RunWorld();
    w3.port.failApplyWith = new ForbiddenException("insufficient permission for this team");
    const id3 = await w3.run();
    expect(w3.store.row(id3).failureCode).toBe("import.apply.http-403");
    expect(w3.store.step(id3, "IMPORT").compensation).toMatchObject({ applyStartedAt: null }); // a definitive refusal created no op

    // an UNKNOWN failure (not an HTTP answer) may have created the op: the marker stays so a retry adopts it
    const w4 = new RunWorld();
    w4.port.failApplyWith = new Error("socket hang up") as never;
    const id4 = await w4.run();
    expect(w4.store.row(id4).failureCode).toBe("import.apply.failed");
    expect(w4.store.step(id4, "IMPORT").compensation).toMatchObject({ applyStartedAt: expect.any(String) });
  });

  it("a git app that still needs a source is a warning, not a failure", async () => {
    const w = new RunWorld();
    w.port.gitStatus.set("app:_:web", "needs_source");
    const id = await w.run();
    const g = (await importStep(w, id)).gate!;
    expect(g.passed).toBe(true);
    expect(g.checks.find((c) => c.code === "import.git-needs-source")).toMatchObject({ status: "warn", params: { count: 1 } });
  });

  it("earlyStateless deploys only the apps that depend on nothing, right after the import; DEPLOY_DARK then skips them", async () => {
    const w = new RunWorld();
    const id = await w.run({ options: { ...w.createBody().options, deployWaves: "earlyStateless" } });
    expect(w.status(id)).toBe("COMPLETED");
    const deploys = w.port.calls.filter((c) => c.startsWith("deploy:"));
    expect(deploys).toHaveLength(2); // one per app, each exactly once overall
    const staticApp = [...w.port.ops.get("op-1")!.tasks].find((t) => t.name === "static-site")!.resourceId!;
    expect(deploys[0].startsWith(`deploy:${staticApp}:`)).toBe(true); // the stateless one went first, during IMPORT
    expect(w.store.step(id, "IMPORT").compensation).toMatchObject({ earlyAppIds: [staticApp] });
  });

  it("dry-run projects counts and unacked blockers without touching the importer", async () => {
    const w = new RunWorld();
    w.port.plan_ = defaultPlan({ items: [{ itemRef: "app:_:web", kind: "app", name: "web", proposed: {}, risks: [{ level: "blocker", code: "db.engine.noImport", message: "x" }], dependsOn: [] }] });
    const id = await w.create({ dryRun: true });
    await w.settle(id);
    const items = (await importStep(w, id)).progress!.dryRun!;
    expect(items.map((i) => i.code)).toEqual(expect.arrayContaining(["import.projection", "import.plan-fresh", "import.item-skipped"]));
    expect(w.port.calls).toEqual([]);
  });
});

describe("IMPORT abort and cleanup", () => {
  async function abortedWorld() {
    const w = new RunWorld({ stubs: { TLS_PREISSUE: { blocked: (x) => !x.done.has("go") } } });
    const id = await w.run();
    expect(w.status(id)).toBe("WAITING");
    await w.service.abort(ACTOR, id, { confirmName: id });
    await w.settle(id);
    expect(w.status(id)).toBe("ABORTED");
    return { w, id };
  }

  it("abort cancels the op (revoking its token) but deletes nothing; the Tugra copies stay, stopped", async () => {
    const { w } = await abortedWorld();
    expect(w.port.calls).toContain("cancel:op-1");
    expect(w.port.calls.some((c) => c.startsWith("rollback:"))).toBe(false);
    expect([...w.port.apps.values()].every((a) => a.status === "STOPPED")).toBe(true);
    expect([...w.port.dbs.values()].every((d) => d.status === "STOPPED")).toBe(true);
    expect(w.port.apps.size + w.port.dbs.size).toBe(3);
  });

  it("cleanup needs admin scope + the typed run id, records the request for IMPORT and rolls back with the run-owned allowance", async () => {
    const { w, id } = await abortedWorld();
    await expect(w.service.cleanup({ ...ACTOR, scopes: ["deploy"] }, id, { confirmName: id, includeData: false, dataConfirmNames: [] })).rejects.toThrow(/insufficient-scope/);
    await expect(w.service.cleanup(ACTOR, id, { confirmName: "x", includeData: false, dataConfirmNames: [] })).rejects.toThrow(/bad-confirmation/);
    const v = await w.service.cleanup(ACTOR, id, { confirmName: id, includeData: false, dataConfirmNames: ["ignored"] });
    expect(v.status).toBe("ROLLING_BACK");
    expect(w.store.row(id).activeKey).toBe("srv:srv1"); // cleanup re-takes the server
    expect((w.store.step(id, "IMPORT").compensation as Record<string, unknown>)[CLEANUP_REQUEST_KEY]).toEqual({ includeData: false, dataConfirmNames: [] });
    await w.settle(id);
    // the started DB holds data: without includeData + its typed name it is kept and reported for manual removal
    expect(w.status(id)).toBe("ROLLED_BACK");
    expect(w.port.calls).toContain("rollback:op-1:run-owned");
    expect(w.port.apps.size).toBe(0);
    expect(w.port.dbs.size).toBe(1);
    expect((await w.service.report(ACTOR, id)).manual).toEqual([{ code: "import.cleanup-kept", params: { name: "pg-main", kind: "database" } }]);
    expect(w.store.row(id).activeKey).toBeNull();
  });

  it("includeData with the typed name removes the data-bearing database too", async () => {
    const { w, id } = await abortedWorld();
    await w.service.cleanup(ACTOR, id, { confirmName: id, includeData: true, dataConfirmNames: ["pg-main"] });
    await w.settle(id);
    expect(w.status(id)).toBe("ROLLED_BACK");
    expect(w.port.calls).toContain("rollback:op-1:run-owned:data");
    expect(w.port.dbs.size).toBe(0);
    expect((await w.service.report(ACTOR, id)).manual).toEqual([]);
  });

  it("cleanup is refused when another live run holds the server, and for a run that was not aborted", async () => {
    const { w, id } = await abortedWorld();
    const other = await w.create();
    await expect(w.service.cleanup(ACTOR, id, { confirmName: id, includeData: false, dataConfirmNames: [] })).rejects.toThrow(/server-has-live-run/);
    expect(w.status(id)).toBe("ABORTED");
    await w.service.abort(ACTOR, other, { confirmName: other });
    await w.settle(other);
    const fresh = await w.create();
    await expect(w.service.cleanup(ACTOR, fresh, { confirmName: fresh, includeData: false, dataConfirmNames: [] })).rejects.toThrow(/run-not-cleanable/);
  });
});
