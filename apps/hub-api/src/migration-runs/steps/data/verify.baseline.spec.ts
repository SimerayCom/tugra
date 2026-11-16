import { StepHandlerRegistryService } from "../../core/step-handler.registry";
import type { SourceBaseline } from "../../core/dto";
import { SOURCE_STATS_CHECK } from "./data-contract";
import { VerifyHandler } from "./verify.handler";
import { BASELINE_CODES, judgeAgainstBaseline } from "./verify/baseline-judge";
import { classifySuite, type SuiteCheck } from "./verify/verify-suite";
import { MemoryCheckStore } from "./verify/check-store";
import { FakeDataPort, FakeDrift, FakeFlip, FakeObjectPort, FakeRuntime, FakeStats, copied, database, makeCtx, makeRun, makeSnap, measured } from "./testing/fakes";

const baseline = (entries: SourceBaseline["entries"]): SourceBaseline => ({ capturedAt: "2026-11-19T10:00:00.000Z", entries });
const entry = (kind: "app" | "database", ref: string, health: "healthy" | "unhealthy" | "unknown" | "exited", restartCount: number | null = 0, serverRef = "s") => ({ kind, ref, serverRef, health, restartCount });

const check = (checkId: string, subject: string, status: SuiteCheck["status"], over: Partial<SuiteCheck> = {}): SuiteCheck => ({
  id: `${checkId}:${subject}`,
  checkId,
  subject,
  status,
  code: checkId === "app-running" ? "verify.app-running" : "verify.database-running",
  params: { status: "STOPPED", name: subject },
  ackable: true,
  evidence: "hub-verified",
  ...over,
});

describe("judgeAgainstBaseline (R52): VERIFY judges against the source, not against perfection", () => {
  it("an app that does not run on Tugra but was already unhealthy at the source is a pre-existing WARNING, not a block and not an acknowledgement", () => {
    const suite = [check("app-running", "app:s:a", "fail")];
    const out = judgeAgainstBaseline(suite, baseline([entry("app", "a", "unhealthy")]));
    expect(out.preExisting).toBe(1);
    expect(out.suite[0]).toMatchObject({ status: "warn", code: BASELINE_CODES.preExisting, ackable: false, evidence: "source-api-reported", params: { name: "app:s:a", status: "STOPPED", kind: "app", sourceHealth: "unhealthy", sourceRestarts: 0 } });
    expect(classifySuite(out.suite)).toEqual({ blocked: [], pending: [], acked: [] });
  });

  it("an exited container and a crash loop at the source are pre-existing too; so is a database", () => {
    const suite = [check("app-running", "app:s:a", "fail"), check("app-running", "app:s:b", "fail"), check("database-running", "database:s:d", "fail", { ackable: false })];
    const out = judgeAgainstBaseline(suite, baseline([entry("app", "a", "exited"), entry("app", "b", "unknown", 90_000), entry("database", "d", "unhealthy")]));
    expect(out.suite.map((c) => c.status)).toEqual(["warn", "warn", "warn"]);
    expect(out.preExisting).toBe(3);
  });

  it("a NEW failure still fails: healthy at the source, unchecked at the source, or not in the baseline at all", () => {
    const suite = [check("app-running", "app:s:healthy", "fail"), check("app-running", "app:s:unknown", "fail"), check("app-running", "app:s:unseen", "fail")];
    const out = judgeAgainstBaseline(suite, baseline([entry("app", "healthy", "healthy"), entry("app", "unknown", "unknown", 2)]));
    expect(out.suite.map((c) => c.status)).toEqual(["fail", "fail", "fail"]);
    expect(out.suite.map((c) => c.code)).toEqual(["verify.app-running", "verify.app-running", "verify.app-running"]);
    expect(out.preExisting).toBe(0);
    // no baseline at all: nothing is excused
    expect(judgeAgainstBaseline([check("app-running", "app:s:a", "fail")], null).suite[0].status).toBe("fail");
    expect(judgeAgainstBaseline([check("app-running", "app:s:a", "fail")], undefined).preExisting).toBe(0);
  });

  it("a baseline entry of another server or kind does not excuse an item with the same uuid", () => {
    const suite = [check("app-running", "app:s:a", "fail")];
    expect(judgeAgainstBaseline(suite, baseline([entry("app", "a", "unhealthy", 0, "other-host")])).suite[0].status).toBe("fail");
    expect(judgeAgainstBaseline(suite, baseline([entry("database", "a", "unhealthy")])).suite[0].status).toBe("fail");
  });

  it("only the running checks are judged; a passing check, a lost-data check and an unrelated check are left alone", () => {
    const suite = [check("app-running", "app:s:a", "pass"), check("volume-parity", "app:s:a", "fail", { ackable: false }), check("db-logical-parity", "app:s:a", "fail", { ackable: false })];
    const out = judgeAgainstBaseline(suite, baseline([entry("app", "a", "unhealthy")]));
    expect(out.suite).toEqual(suite);
    expect(out.preExisting).toBe(0);
  });
});

describe("VERIFY wires the baseline into its suite", () => {
  function build(sourceBaseline: SourceBaseline | null, appStatus = "STOPPED") {
    const registry = new StepHandlerRegistryService();
    const run = makeRun({ sourceBaseline });
    const data = new FakeDataPort(makeSnap({ volumes: [copied("volume:s:abc:data")], databases: [database("database:s:pg", { task: "done" })] }));
    const runtime = new FakeRuntime();
    runtime.rt = {
      apps: [{ itemRef: "app:s:abc", name: "web", status: appStatus, envUnresolved: 0, envDropped: 0 }],
      databases: [{ itemRef: "database:s:pg", name: "pg", status: "RUNNING" }],
      hosts: [{ hostname: "a.example.com", state: "READY", stateful: true, blockReason: null }],
      incomplete: [],
    };
    const stats = new FakeStats();
    stats.byRef.set("database:s:pg", measured("database:s:pg", [["public.t", 5]]));
    const checks = new MemoryCheckStore();
    const handler = new VerifyHandler(registry, data, new FakeObjectPort(), runtime, stats, new FakeFlip(), new FakeDrift(), checks);
    handler.onModuleInit();
    return { handler, run, checks, ctx: () => makeCtx({ key: "VERIFY", run }) };
  }

  it("a source-degraded app that is stopped on Tugra: warned as pre-existing, the gate has nothing to acknowledge for it", async () => {
    const { handler, ctx, checks, run } = build(baseline([entry("app", "abc", "unhealthy", 12)]));
    await checks.upsert({ runId: run.id, stepKey: "VERIFY", checkId: SOURCE_STATS_CHECK, subject: "database:s:pg", status: "unknown", evidenceKind: "migrator-reported", evidence: measured("database:s:pg", [["public.t", 5]]) as never });
    const h = ctx();
    const obs = await handler.observe(h.ctx);
    expect(obs.suite.find((c) => c.checkId === "app-running")).toMatchObject({ status: "warn", code: BASELINE_CODES.preExisting });
    const binding = (await handler.approvalBinding(h.ctx, obs))!;
    expect(binding.ackable).not.toContain(obs.suite.find((c) => c.checkId === "app-running")!.id);
    expect(handler.preGate(h.ctx, obs).passed).toBe(true);
  });

  it("the same app with no baseline (or a healthy one) is a new failure the approval must acknowledge", async () => {
    for (const b of [null, baseline([entry("app", "abc", "healthy")])]) {
      const { handler, ctx, checks, run } = build(b);
      await checks.upsert({ runId: run.id, stepKey: "VERIFY", checkId: SOURCE_STATS_CHECK, subject: "database:s:pg", status: "unknown", evidenceKind: "migrator-reported", evidence: measured("database:s:pg", [["public.t", 5]]) as never });
      const h = ctx();
      const obs = await handler.observe(h.ctx);
      const c = obs.suite.find((x) => x.checkId === "app-running")!;
      expect(c).toMatchObject({ status: "fail", code: "verify.app-running", ackable: true });
      expect((await handler.approvalBinding(h.ctx, obs))!.ackable).toContain(c.id);
    }
  });
});
