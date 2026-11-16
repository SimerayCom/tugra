import { join } from "node:path";
import { StepHandlerRegistryService } from "../../core/step-handler.registry";
import { DataSeedHandler } from "./data-seed.handler";
import { MigratorRunner } from "./launcher/migrator-runner.service";
import { SourceHostFake } from "./testing/source-host-fake";
import { FakeCaps, FakeDataPort, FakeObjectPort, answered, inspected, makeCtx, makeRun, makeSnap, database, volume, type CtxHarness } from "./testing/fakes";
import { FakeHostReports } from "./inventory/testing/fake-host-reports";
import { INVENTORY_ATTEST, INVENTORY_CODES } from "./inventory/cross-check";
import { HOST_LOOP_CODES } from "./inventory/host-codes";
import type { HostInventory } from "./inventory/host-protocol";
import type { RunSnapshot } from "../../core/run-contract";

const RUN = "cmrun00000001";
const UDB = "dbaaaaaaaaaaaaaaaaaaaaaa";
const GHOST = "dbghostgggggggggggggggggg";
const id = (c: string) => c.repeat(64);

const loopRun = (over: Parameters<typeof makeRun>[0] = {}): RunSnapshot => makeRun({ ...over, options: { sourceRunner: "coolify-host-loop", ...(over.options ?? {}) }, serverMap: { "srv-a": "tgt-1", "srv-b": "tgt-2" } });

const inventoryOf = (ref: string, over: Partial<HostInventory> = {}): HostInventory => ({
  ref,
  host: { name: ref, docker: "27", os: "" },
  containers: ref === "srv-a" ? [{ id: id("a"), name: UDB, image: "postgres:16", state: "running" }] : [],
  mounts: [],
  volumes: [],
  binds: [],
  complete: true,
  rejected: 0,
  ...over,
});

function build(run: RunSnapshot = loopRun()) {
  const registry = new StepHandlerRegistryService();
  const data = new FakeDataPort(
    makeSnap({
      databases: [database(`database:srv-a:${UDB}`, { plane: "volume" })],
      volumes: [volume(`volume:srv-a:${UDB}:data`)], // not inspected yet
      apps: [{ itemRef: "app:srv-b:appbbbbbbbbbbbbbbbbbbbbb", name: "web" }],
    }),
  );
  const host = new SourceHostFake({ containers: [] });
  const reports = new FakeHostReports();
  const handler = new DataSeedHandler(registry, data, new FakeObjectPort(), new MigratorRunner(host, data, new FakeCaps(), join(host.dir, "runs")), reports);
  handler.onModuleInit();
  const ctx = (extra: Partial<Parameters<typeof makeCtx>[0]> = {}): CtxHarness => makeCtx({ key: "DATA_SEED", run, ...extra });
  const takeInventories = (refs: string[] = ["srv-a", "srv-b"], reachOk = true) => {
    for (const r of refs) {
      reports.set(RUN, { stepKey: "", sourceServerRef: r, kind: "inventory", state: "complete", payload: inventoryOf(r) as unknown as Record<string, unknown> });
      if (reachOk) reports.set(RUN, { stepKey: "", sourceServerRef: r, kind: "reach", state: "ok", payload: { ref: r, pingCode: 200, hubPartMiB: 128, maxPassedMiB: 128, failedAtMiB: null, seconds: 1 } });
    }
  };
  return { handler, data, reports, ctx, takeInventories, host };
}

afterEach(() => undefined);

describe("DATA_SEED with the coolify-host-loop runner", () => {
  it("R2: asks for the host inventory FIRST, offering the inventory command, before any migrator work", async () => {
    const { handler, ctx } = build();
    const h = ctx();
    const res = await handler.act(h.ctx, await handler.observe(h.ctx));
    expect(res).toMatchObject({ outcome: "wait", wait: { kind: "operator", code: HOST_LOOP_CODES.inventoryRun, offersCommand: true, commandKind: "inventory", params: { hosts: 2, missing: 2, failing: 0 } } });
  });

  it("once every host reported, it offers the host-loop script for the inspect phase with the host and pending counts", async () => {
    const { handler, ctx, takeInventories } = build();
    takeInventories();
    const h = ctx();
    const res = await handler.act(h.ctx, await handler.observe(h.ctx));
    expect(res).toMatchObject({
      outcome: "wait",
      wait: { kind: "operator", code: HOST_LOOP_CODES.seedRun, offersCommand: true, commandKind: "host-loop", params: { phase: "inspect", flags: ["--arms", "all", "--dry-run"], hosts: 1, failing: 0 } },
    });
  });

  it("a host whose loop run failed is named, the wait changes code, and the gate carries a host-loop-reported failure until a later run overwrites it", async () => {
    const { handler, ctx, takeInventories, reports } = build();
    takeInventories();
    reports.set(RUN, { stepKey: "DATA_SEED", sourceServerRef: "srv-a", kind: "loop", state: "unreachable", payload: { code: "ssh-failed", rc: null } });
    const h = ctx();
    const obs = await handler.observe(h.ctx);
    expect(await handler.act(h.ctx, obs)).toMatchObject({ outcome: "wait", wait: { code: HOST_LOOP_CODES.seedHostFailed, commandKind: "host-loop", params: { failing: 1, names: ["srv-a"] } } });
    expect(handler.postGate(h.ctx, obs).checks).toContainEqual(expect.objectContaining({ code: HOST_LOOP_CODES.hostFailed, status: "fail", subject: "srv-a", evidence: "host-loop-reported" }));
    // the next run of the script succeeded for that host
    reports.set(RUN, { stepKey: "DATA_SEED", sourceServerRef: "srv-a", kind: "loop", state: "finished", payload: { code: "ok", rc: 0 } });
    const again = await handler.observe(h.ctx);
    expect(handler.postGate(h.ctx, again).checks).toContainEqual(expect.objectContaining({ code: HOST_LOOP_CODES.hostOk, status: "pass" }));
    expect(await handler.act(h.ctx, again)).toMatchObject({ wait: { code: HOST_LOOP_CODES.seedRun } });
  });

  it("a host whose inventory could not be taken is reported by name in the inventory wait", async () => {
    const { handler, ctx, reports } = build();
    reports.set(RUN, { stepKey: "INVENTORY", sourceServerRef: "srv-b", kind: "loop", state: "failed", payload: { code: "hub-unreachable-from-host", rc: null } });
    const h = ctx();
    expect(await handler.act(h.ctx, await handler.observe(h.ctx))).toMatchObject({ wait: { code: HOST_LOOP_CODES.inventoryRun, params: { missing: 2, failing: 1, names: ["srv-b"] } } });
  });

  it("R2/C6: an unlisted database container blocks the step; the wait offers the attestations; an attestation or the owner's policy settles it", async () => {
    const { handler, data, ctx, takeInventories, reports } = build();
    data.snap.volumes = [inspected(`volume:srv-a:${UDB}:data`)];
    takeInventories();
    reports.set(RUN, { stepKey: "", sourceServerRef: "srv-a", kind: "inventory", state: "complete", payload: inventoryOf("srv-a", { containers: [{ id: id("a"), name: UDB, image: "postgres:16", state: "running" }, { id: id("f"), name: GHOST, image: "mariadb:11", state: "running" }] }) as unknown as Record<string, unknown> });
    const h = ctx();
    const obs = await handler.observe(h.ctx);
    const gate = handler.postGate(h.ctx, obs);
    expect(gate.passed).toBe(false);
    expect(gate.checks).toContainEqual(expect.objectContaining({ code: INVENTORY_CODES.unlistedDb, status: "fail", subject: `srv-a/${GHOST}`, ownerInput: "unlistedDbPolicy" }));
    expect(await handler.act(h.ctx, obs)).toMatchObject({ outcome: "wait", wait: { kind: "operator", code: INVENTORY_CODES.unlistedDb, attest: [INVENTORY_ATTEST.excluded, INVENTORY_ATTEST.mapped] } });

    // an operator attests it as excluded (exact subject)
    const attested = ctx({ steps: { DATA_SEED: { evidence: { attestations: [{ checkId: INVENTORY_ATTEST.excluded, subject: `srv-a/${GHOST}`, byUserId: "user1", at: "2026-11-20T10:00:00.000Z" }], attachments: [] } } } });
    const g2 = handler.postGate(attested.ctx, await handler.observe(attested.ctx));
    expect(g2.passed).toBe(true);
    expect(g2.checks).toContainEqual(expect.objectContaining({ code: INVENTORY_CODES.unlistedDbExcluded, status: "warn" }));

    // or the owner decided for every unlisted database
    const skip = build(loopRun({ inputs: { unlistedDbPolicy: answered("skip") } }));
    skip.data.snap.volumes = [inspected(`volume:srv-a:${UDB}:data`)];
    skip.takeInventories();
    skip.reports.set(RUN, { stepKey: "", sourceServerRef: "srv-a", kind: "inventory", state: "complete", payload: inventoryOf("srv-a", { containers: [{ id: id("f"), name: GHOST, image: "mariadb:11", state: "running" }, { id: id("a"), name: UDB, image: "postgres:16", state: "running" }] }) as unknown as Record<string, unknown> });
    const sh = skip.ctx();
    const g3 = skip.handler.postGate(sh.ctx, await skip.handler.observe(sh.ctx));
    expect(g3.passed).toBe(true);
    expect(g3.checks).toContainEqual(expect.objectContaining({ code: INVENTORY_CODES.unlistedDbSkipped }));
  });

  it("R8: a path to the hub with a body cap below the part size blocks with the recommended part size", async () => {
    const { handler, data, ctx, takeInventories, reports } = build();
    data.snap.volumes = [inspected(`volume:srv-a:${UDB}:data`)];
    takeInventories();
    reports.set(RUN, { stepKey: "", sourceServerRef: "srv-b", kind: "reach", state: "ok", payload: { ref: "srv-b", pingCode: 200, hubPartMiB: 128, maxPassedMiB: 64, failedAtMiB: 128, seconds: 2 } });
    const h = ctx();
    const gate = handler.postGate(h.ctx, await handler.observe(h.ctx));
    expect(gate.passed).toBe(false);
    expect(gate.checks).toContainEqual(expect.objectContaining({ code: INVENTORY_CODES.partSizeExceedsCap, status: "fail", params: expect.objectContaining({ host: "srv-b", acceptedMiB: 64, recommendMiB: 64 }) }));
  });

  it("a plan that names no source host cannot loop: the dry-run blocks and the step fails with a fixed code", async () => {
    const { handler, data, ctx } = build(makeRun({ options: { sourceRunner: "coolify-host-loop" } }));
    data.snap.apps = [{ itemRef: "app:_:appbbbbbbbbbbbbbbbbbbbbb", name: "web" }];
    data.snap.databases = [];
    data.snap.volumes = [];
    const h = ctx({ run: makeRun({ options: { sourceRunner: "coolify-host-loop" } }) });
    expect(await handler.dryRun(h.ctx)).toContainEqual({ code: HOST_LOOP_CODES.noHosts, level: "block" });
    expect(await handler.act(h.ctx, await handler.observe(h.ctx))).toMatchObject({ outcome: "fail", code: HOST_LOOP_CODES.noHosts, retryable: false });
  });

  it("the dry-run shows the loop plan and the cross-check findings as blocks/warnings", async () => {
    const { handler, ctx, takeInventories, reports } = build();
    takeInventories();
    reports.set(RUN, { stepKey: "", sourceServerRef: "srv-a", kind: "inventory", state: "complete", payload: inventoryOf("srv-a", { volumes: [{ name: "forgotten", mountpoint: "/v/forgotten/_data", sizeKiB: null, links: 0 }] }) as unknown as Record<string, unknown> });
    const items = await handler.dryRun(ctx().ctx);
    expect(items).toContainEqual({ code: HOST_LOOP_CODES.dryPlan, level: "info", params: { hosts: 2, keyDir: "/data/coolify/ssh/keys", parallel: 1 } });
    expect(items).toContainEqual(expect.objectContaining({ code: INVENTORY_CODES.orphanVolume, level: "block", subject: "srv-a/volume:forgotten" }));
  });

  it("C8: running sources are the normal case; the step says so (a warning, never a block) unless stop-source or a freeze controller covers it", async () => {
    const { handler, data, ctx, takeInventories } = build();
    data.snap.volumes = [inspected(`volume:srv-a:${UDB}:data`)]; // inspected() reports a running source
    takeInventories();
    const h = ctx();
    const gate = handler.postGate(h.ctx, await handler.observe(h.ctx));
    expect(gate.passed).toBe(true);
    expect(gate.checks).toContainEqual(expect.objectContaining({ code: HOST_LOOP_CODES.sourceRunning, status: "warn", params: { count: 1, names: ["web"] } }));

    const covered = build(loopRun({ options: { stopSource: true } }));
    covered.data.snap.volumes = [inspected(`volume:srv-a:${UDB}:data`)];
    covered.takeInventories();
    const c = covered.ctx();
    expect(covered.handler.postGate(c.ctx, await covered.handler.observe(c.ctx)).checks.map((x) => x.code)).not.toContain(HOST_LOOP_CODES.sourceRunning);
  });

  it("abort names the hosts that may still run a migrator (the hub cannot stop what it did not start) and still revokes the token", async () => {
    const { handler, data, ctx, reports } = build();
    reports.set(RUN, { stepKey: "DATA_SEED", sourceServerRef: "srv-a", kind: "loop", state: "running", payload: { code: "migrating", rc: null } });
    reports.set(RUN, { stepKey: "DATA_SEED", sourceServerRef: "srv-b", kind: "loop", state: "finished", payload: { code: "ok", rc: 0 } });
    const h = ctx();
    expect(await handler.compensate(h.ctx, "abort")).toEqual({ outcome: "manual", manual: [{ code: HOST_LOOP_CODES.stopMigrators, params: { hosts: ["srv-a"], count: 1 } }] });
    expect(data.revoked).toBe(1);
    // nothing live: a clean abort
    reports.set(RUN, { stepKey: "DATA_SEED", sourceServerRef: "srv-a", kind: "loop", state: "finished", payload: { code: "ok", rc: 0 } });
    expect(await handler.compensate(ctx().ctx, "abort")).toEqual({ outcome: "done" });
  });

  it("the operator and agent runners are unchanged: no inventory wait, and an inventory that arrived is still cross-checked but never required", async () => {
    const { handler, data, ctx, reports } = build(makeRun());
    const h = ctx();
    expect(await handler.act(h.ctx, await handler.observe(h.ctx))).toMatchObject({ wait: { code: "data.run-migrator" } });
    expect((await handler.act(h.ctx, await handler.observe(h.ctx))) as { wait: { commandKind?: string } }).not.toMatchObject({ wait: { commandKind: expect.anything() } });
    data.snap.volumes = [inspected(`volume:srv-a:${UDB}:data`)];
    expect(handler.postGate(h.ctx, await handler.observe(h.ctx)).passed).toBe(true); // no inventory: nothing required
    reports.set(RUN, { stepKey: "", sourceServerRef: "srv-a", kind: "inventory", state: "complete", payload: inventoryOf("srv-a", { containers: [{ id: id("f"), name: GHOST, image: "redis:7", state: "running" }] }) as unknown as Record<string, unknown> });
    expect(handler.postGate(h.ctx, await handler.observe(h.ctx)).passed).toBe(false); // but a finding that arrived blocks
  });
});
