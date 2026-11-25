import { join } from "node:path";
import { DATA_CODES, type CapabilityPort, type SourceHostPort } from "./data-contract";
import { agentRunnerHost, seedChecks } from "./data-logic";
import { MigratorRunner } from "./launcher/migrator-runner.service";
import { SourceHostFake } from "./testing/source-host-fake";
import { FakeDataPort, makeCtx, makeRun, makeSnap, volume } from "./testing/fakes";

const twoBox = (sourceHostServers?: Record<string, string>) => makeRun({ topology: "two-box", options: { sourceRunner: "agent", ...(sourceHostServers ? { sourceHostServers } : {}) } });

describe("agentRunnerHost", () => {
  it("a same-host swap runs on its target", () => {
    expect(agentRunnerHost(makeRun({ topology: "swap-proxy", options: { sourceRunner: "agent" } }))).toEqual({ ok: true, serverId: "srv-target" });
  });
  it("a two-box run runs on the one source host the hub recorded, never on the target", () => {
    expect(agentRunnerHost(twoBox({ a: "srv-src" }))).toEqual({ ok: true, serverId: "srv-src" });
  });
  it("several source servers on the same machine are one host", () => {
    expect(agentRunnerHost(twoBox({ a: "srv-src", b: "srv-src" }))).toEqual({ ok: true, serverId: "srv-src" });
  });
  it("no recorded source host keeps the old refusal", () => {
    expect(agentRunnerHost(twoBox())).toEqual({ ok: false, code: DATA_CODES.agentNeedsSameHost });
    expect(agentRunnerHost(twoBox({}))).toEqual({ ok: false, code: DATA_CODES.agentNeedsSameHost });
  });
  it("several machines are refused by their own code (one launch record per host is not kept)", () => {
    expect(agentRunnerHost(twoBox({ a: "srv-1", b: "srv-2" }))).toEqual({ ok: false, code: DATA_CODES.agentMultiSourceHost });
  });
});

describe("the DATA_SEED gate", () => {
  const snap = makeSnap({ volumes: [volume("volume:s:a:data")] });
  const codes = (run: ReturnType<typeof makeRun>) => seedChecks(run, snap, []).filter((c) => c.id === "agent-same-host").map((c) => c.code);
  it("no longer blocks a two-box run whose source host has an agent", () => {
    expect(codes(twoBox({ a: "srv-src" }))).toEqual([]);
  });
  it("still blocks one without, and names the multi-host case apart", () => {
    expect(codes(twoBox())).toEqual([DATA_CODES.agentNeedsSameHost]);
    expect(codes(twoBox({ a: "x", b: "y" }))).toEqual([DATA_CODES.agentMultiSourceHost]);
  });
  it("the operator runner is not judged", () => {
    expect(codes(makeRun({ topology: "two-box", options: { sourceRunner: "operator" } }))).toEqual([]);
  });
});

describe("MigratorRunner on a two-box run", () => {
  function rig(run: ReturnType<typeof makeRun>) {
    const fake = new SourceHostFake({ containers: [] });
    const hostCalls: string[] = [];
    const host: SourceHostPort = {
      run: async (serverId, script, cap, timeout) => {
        hostCalls.push(serverId);
        return fake.run(serverId, script, cap, timeout);
      },
    } as SourceHostPort;
    const capCalls: string[] = [];
    const caps: CapabilityPort = {
      ensureMigrate: async (_u, serverId) => {
        capCalls.push(`ensure:${serverId}`);
        return { ok: true, added: true };
      },
      releaseMigrate: async (_u, serverId) => {
        capCalls.push(`release:${serverId}`);
      },
    };
    const data = new FakeDataPort(makeSnap({ volumes: [volume("volume:s:a:data")] }));
    const runner = new MigratorRunner(host, data, caps, join(fake.dir, "runs"));
    return { fake, hostCalls, capCalls, data, runner, run };
  }

  it("launches, observes and stops on the source host's agent, and grants and releases the capability there", async () => {
    const r = rig(twoBox({ a: "srv-src" }));
    const ctx = makeCtx({ run: r.run, key: "DATA_SEED" });
    expect(MigratorRunner.available(r.run)).toBe(true);
    expect(await r.runner.launch(ctx.ctx, "inspect", await r.data.snapshot())).toEqual({ ok: true });
    await r.runner.status(r.run, ctx.comp.launch as never);
    await r.runner.stop(ctx.ctx);
    expect(r.hostCalls.length).toBeGreaterThanOrEqual(3);
    expect(new Set(r.hostCalls)).toEqual(new Set(["srv-src"]));
    expect(r.capCalls.every((c) => c.endsWith(":srv-src"))).toBe(true);
    expect(r.capCalls.some((c) => c.includes("srv-target"))).toBe(false);
    r.fake.dispose();
  });
  it("dispatches nothing when no source host is recorded, with the old code", async () => {
    const r = rig(twoBox());
    const ctx = makeCtx({ run: r.run, key: "DATA_SEED" });
    expect(MigratorRunner.available(r.run)).toBe(false);
    expect(await r.runner.launch(ctx.ctx, "inspect", await r.data.snapshot())).toMatchObject({ ok: false, code: DATA_CODES.agentNeedsSameHost, retryable: false });
    expect(await r.runner.status(r.run, { seq: 1, phase: "inspect", at: "x", tag: "seed" })).toBeNull();
    expect(await r.runner.stop(ctx.ctx)).toBe(true);
    expect(r.hostCalls).toEqual([]);
    expect(r.capCalls).toEqual([]);
    r.fake.dispose();
  });
  it("refuses several source machines with their own code and dispatches nothing", async () => {
    const r = rig(twoBox({ a: "srv-1", b: "srv-2" }));
    const ctx = makeCtx({ run: r.run, key: "DATA_SEED" });
    expect(await r.runner.launch(ctx.ctx, "inspect", await r.data.snapshot())).toMatchObject({ ok: false, code: DATA_CODES.agentMultiSourceHost });
    expect(r.hostCalls).toEqual([]);
    r.fake.dispose();
  });
  it("a run on a runner other than agent never launches here", async () => {
    const r = rig(makeRun({ topology: "two-box", options: { sourceRunner: "operator", sourceHostServers: { a: "srv-src" } } }));
    const ctx = makeCtx({ run: r.run, key: "DATA_SEED" });
    expect(MigratorRunner.available(r.run)).toBe(false);
    expect(await r.runner.launch(ctx.ctx, "inspect", await r.data.snapshot())).toMatchObject({ ok: false });
    expect(r.hostCalls).toEqual([]);
    r.fake.dispose();
  });
});
