import { join } from "node:path";
import { StepHandlerRegistryService } from "../../core/step-handler.registry";
import { DataSeedHandler } from "./data-seed.handler";
import { MigratorRunner } from "./launcher/migrator-runner.service";
import { SourceHostFake } from "./testing/source-host-fake";
import { FakeCaps, FakeDataPort, FakeObjectPort, answered, inspected, makeCtx, makeRun, makeSnap, database } from "./testing/fakes";
import { FakeHostReports } from "./inventory/testing/fake-host-reports";
import { CARRY_REFUSED_CODES, INVENTORY_ATTEST, INVENTORY_CODES } from "./inventory/cross-check";
import { DATA_CODES } from "./data-contract";
import type { HostInventory } from "./inventory/host-protocol";
import type { RunSnapshot } from "../../core/run-contract";

/** R2: `unlistedDbPolicy: carry` is a real carry. The DATA_SEED step binds every carryable unlisted database container to a NEW database item. */

const RUN = "cmrun00000001";
const UDB = "dbaaaaaaaaaaaaaaaaaaaaaa";
const GHOST = "dbghostgggggggggggggggggg";
const id = (c: string) => c.repeat(64);

const carryRun = (policy: "carry" | "skip" | "block" = "carry"): RunSnapshot =>
  makeRun({ options: { sourceRunner: "coolify-host-loop" }, serverMap: { "srv-a": "tgt-1" }, inputs: { unlistedDbPolicy: answered(policy) } });

const inv = (ghost: Record<string, unknown> | null): HostInventory => ({
  ref: "srv-a",
  host: { name: "srv-a", docker: "27", os: "" },
  containers: [{ id: id("a"), name: UDB, image: "postgres:16", state: "running" }, ...(ghost ? [{ id: id("f"), name: GHOST, state: "running", ...ghost } as never] : [])],
  mounts: [],
  volumes: [],
  binds: [],
  complete: true,
  rejected: 0,
});

const PG17 = { image: "postgres:17-alpine", db: { user: "appuser", database: "appdb", cred: "env", version: null } };

function build(run: RunSnapshot, ghost: Record<string, unknown> | null) {
  const registry = new StepHandlerRegistryService();
  const data = new FakeDataPort(makeSnap({ databases: [database(`database:srv-a:${UDB}`, { plane: "logical", task: "done" })], volumes: [inspected(`volume:srv-a:${UDB}:data`)], apps: [{ itemRef: "app:srv-a:appbbbbbbbbbbbbbbbbbbbbb", name: "web" }] }));
  const host = new SourceHostFake({ containers: [] });
  const reports = new FakeHostReports();
  const handler = new DataSeedHandler(registry, data, new FakeObjectPort(), new MigratorRunner(host, data, new FakeCaps(), join(host.dir, "runs")), reports);
  handler.onModuleInit();
  const put = (g: Record<string, unknown> | null) => {
    reports.set(RUN, { stepKey: "", sourceServerRef: "srv-a", kind: "inventory", state: "complete", payload: inv(g) as unknown as Record<string, unknown> });
    reports.set(RUN, { stepKey: "", sourceServerRef: "srv-a", kind: "reach", state: "ok", payload: { ref: "srv-a", pingCode: 200, hubPartMiB: 128, maxPassedMiB: 128, failedAtMiB: null, seconds: 1 } });
  };
  put(ghost);
  const ctx = (extra: Partial<Parameters<typeof makeCtx>[0]> = {}) => makeCtx({ key: "DATA_SEED", run, ...extra });
  return { handler, data, reports, ctx, put };
}

describe("DATA_SEED: unlistedDbPolicy carry (R2)", () => {
  it("binds a carryable unlisted database to a NEW database item on the target server of its host, before any data moves, and the item is then part of the run", async () => {
    const { handler, data, ctx } = build(carryRun(), PG17);
    const h = ctx();
    const obs = await handler.observe(h.ctx);
    const pre = handler.preGate(h.ctx, obs);
    expect(handler.postGate(h.ctx, obs).checks).toContainEqual(expect.objectContaining({ code: INVENTORY_CODES.unlistedDbCarry, status: "warn", subject: `srv-a/${GHOST}`, params: expect.objectContaining({ name: `unlisted-postgres-${GHOST.slice(0, 8)}`, version: "17" }) }));
    expect(pre.passed).toBe(true); // a carry is not a block

    expect(await handler.act(h.ctx, obs)).toEqual({ outcome: "continue", pollAfterMs: 1_000 });
    expect(data.carried).toEqual([{ itemRef: `database:srv-a:${GHOST}`, engine: "POSTGRES", serverId: "tgt-1" }]);
    expect(h.events).toContainEqual(expect.objectContaining({ code: "data-seed.db-carried", params: expect.objectContaining({ engine: "POSTGRES", container: GHOST, host: "srv-a" }) }));
    expect(JSON.stringify(h.events)).not.toMatch(/appuser|appdb/); // no identity beyond the container and the new name

    // the next read: the plan accounts for the container, so there is no finding any more and the database is a normal item of the lane
    const again = await handler.observe(h.ctx);
    expect(again.snap.databases.map((d) => d.itemRef)).toContain(`database:srv-a:${GHOST}`);
    expect(handler.postGate(h.ctx, again).checks.some((c) => c.subject === `srv-a/${GHOST}`)).toBe(false);
    expect(await handler.act(h.ctx, again)).not.toEqual({ outcome: "continue", pollAfterMs: 1_000 }); // nothing is carried twice
    expect(data.carried).toHaveLength(1);
  });

  it("a carry that cannot be made in full is REFUSED with its reason: the gate fails, the step parks on it and nothing is created", async () => {
    for (const [ghost, reason] of [
      [{ image: "mongo:7" }, "engine-unsupported"],
      [{ ...PG17, db: { user: "u", database: "d", cred: "file", version: null } }, "secret-file-unsupported"],
      [{ image: "redis:7", db: { user: null, database: null, cred: "none", version: null } }, "credentials-not-discoverable"],
      [{ image: "postgres:16" }, "meta-missing"],
    ] as const) {
      const { handler, data, ctx } = build(carryRun(), ghost as never);
      const h = ctx();
      const obs = await handler.observe(h.ctx);
      const pre = handler.preGate(h.ctx, obs);
      expect(pre.passed).toBe(false);
      expect(pre.checks).toContainEqual(expect.objectContaining({ status: "fail", code: CARRY_REFUSED_CODES[reason], subject: `srv-a/${GHOST}`, attestable: [INVENTORY_ATTEST.excluded, INVENTORY_ATTEST.mapped] }));
      expect(pre.wait).toMatchObject({ kind: "operator", code: CARRY_REFUSED_CODES[reason], attest: [INVENTORY_ATTEST.excluded, INVENTORY_ATTEST.mapped] });
      expect(data.carried).toEqual([]);
    }
  });

  it("excluding the refused container settles it; the other policies and an operator's exclusion never carry", async () => {
    const refused = build(carryRun(), { image: "mongo:7" });
    const settled = refused.ctx({ steps: { DATA_SEED: { evidence: { attestations: [{ checkId: INVENTORY_ATTEST.excluded, subject: `srv-a/${GHOST}`, byUserId: "user1", at: "2026-11-20T10:00:00.000Z" }], attachments: [] } } } });
    expect(refused.handler.preGate(settled.ctx, await refused.handler.observe(settled.ctx)).passed).toBe(true);

    for (const policy of ["skip", "block"] as const) {
      const w = build(carryRun(policy), PG17);
      const h = w.ctx();
      await w.handler.act(h.ctx, await w.handler.observe(h.ctx));
      expect(w.data.carried).toEqual([]);
    }
    const excluded = build(carryRun(), PG17);
    const ex = excluded.ctx({ steps: { DATA_SEED: { evidence: { attestations: [{ checkId: INVENTORY_ATTEST.excluded, subject: `srv-a/${GHOST}`, byUserId: "user1", at: "2026-11-20T10:00:00.000Z" }], attachments: [] } } } });
    await excluded.handler.act(ex.ctx, await excluded.handler.observe(ex.ctx));
    expect(excluded.data.carried).toEqual([]);
  });

  it("an item that already exists while the container is still a finding fails the step instead of looping", async () => {
    const { handler, data, ctx } = build(carryRun(), PG17);
    data.carryUnlistedDb = async (_run, spec) => ({ itemRef: `database:${spec.host}:${spec.container}`, created: false }); // the port says it was there, the snapshot disagrees
    const h = ctx();
    expect(await handler.act(h.ctx, await handler.observe(h.ctx))).toEqual({ outcome: "fail", code: DATA_CODES.seedCarryFailed, params: { count: 1 }, retryable: true });
  });

  it("a database the target refuses to create fails the step with a retryable code naming the count, never silently skipping the container", async () => {
    const { handler, data, ctx } = build(carryRun(), PG17);
    data.carryFails = true;
    const h = ctx();
    expect(await handler.act(h.ctx, await handler.observe(h.ctx))).toEqual({ outcome: "fail", code: DATA_CODES.seedCarryFailed, params: { count: 1 }, retryable: true });
    expect(data.carried).toEqual([]);
    data.carryFails = false; // a retry carries it
    expect(await handler.act(h.ctx, await handler.observe(h.ctx))).toEqual({ outcome: "continue", pollAfterMs: 1_000 });
    expect(data.carried).toHaveLength(1);
  });
});
