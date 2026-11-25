/**
 * Multi-host runs (grup-7 contract extension): the `serverMap` placement, `ctx.targetFor`, the one-live-run-per-server rule over
 * EVERY mapped target, the typed confirmation naming all target servers, the source version capture and the new run-level
 * columns, driven through the real service and engine over the in-memory world.
 */
import { Logger } from "@nestjs/common";
import { ACTOR, RunWorld, SERVER, TEAM, defaultPlan } from "./testing/run-world";
import { confirmMatches } from "./migration-runs.service";
import { MigrationRunSummarySchema, MigrationRunViewSchema, RunReportSchema, type ApprovalBinding } from "./dto";
import type { StepContext } from "./run-contract";

jest.setTimeout(30_000);

beforeAll(() => {
  jest.spyOn(Logger.prototype, "warn").mockImplementation();
  jest.spyOn(Logger.prototype, "error").mockImplementation();
  jest.spyOn(Logger.prototype, "log").mockImplementation();
});

const MAP = { "src-a": "srv2", "src-b": "srv3", "src-c": "srv2" };

/** A world with three more Tugra servers on the team and one on a foreign team. */
function world(opts: ConstructorParameters<typeof RunWorld>[0] = {}): RunWorld {
  const w = new RunWorld(opts);
  // the default plan's items have an unknown source server; with a map those must sit on a mapped server (never the silent default)
  w.port.plan_ = defaultPlan({
    items: [
      { itemRef: "database:src-a:db1", kind: "database", name: "pg-main", proposed: { engine: "POSTGRES" }, risks: [], dependsOn: [] },
      { itemRef: "app:src-b:web", kind: "app", name: "web", proposed: { domain: "web.example.com" }, risks: [], dependsOn: ["database:src-a:db1"] },
      { itemRef: "app:src-c:static", kind: "app", name: "static-site", proposed: { domain: "static.example.com" }, risks: [], dependsOn: [] },
    ],
  });
  for (const [id, name] of [["srv2", "host-2"], ["srv3", "host-3"], ["srv4", "host-4"]] as const) w.env.serversById.set(id, { id, name, teamId: TEAM });
  w.env.serversById.set("srv-foreign", { id: "srv-foreign", name: "host-x", teamId: "t-other" });
  return w;
}

const ponr = (confirm: ApprovalBinding["confirm"]): ApprovalBinding => ({ inputHash: "a".repeat(64), ponr: false, confirm, ttlSec: null, requiresDataRisk: false, ackable: [], requiredAcks: [], review: {} });

describe("create with a serverMap", () => {
  it("persists the map and the campaign, exposes the placement in the view and keeps targetServerId as the default", async () => {
    const w = world();
    const id = await w.create({ serverMap: MAP, campaign: "wave-1" });
    const row = w.store.row(id);
    expect(row).toMatchObject({ targetServerId: SERVER, serverMap: MAP, campaign: "wave-1" });
    // the map is a run-level column: the frozen apply input is unchanged
    expect(row.applyInput).toEqual({ sourceKind: "coolify", targetServerId: SERVER, planHash: "d".repeat(32) });
    const v = await w.view(id);
    expect(v.serverMap).toEqual(MAP);
    expect(v.campaign).toBe("wave-1");
    expect(v.targetServers).toEqual([
      { serverId: SERVER, serverName: "tugra-box", primary: true },
      { serverId: "srv2", serverName: "host-2", primary: false },
      { serverId: "srv3", serverName: "host-3", primary: false },
    ]);
    expect(MigrationRunViewSchema.parse(JSON.parse(JSON.stringify(v))).targetServers).toHaveLength(3);
    const [s] = await w.service.list(ACTOR, { limit: 5 });
    expect(s).toMatchObject({ targetServerCount: 3, campaign: "wave-1" });
    expect(MigrationRunSummarySchema.parse(JSON.parse(JSON.stringify(s))).targetServerCount).toBe(3);
    expect(w.sink.audits.find((a) => a.action === "migration.run.create")?.meta).toMatchObject({ serverIds: [SERVER, "srv2", "srv3"], campaign: "wave-1" });
  });

  it("a run without a map is a single-target run, exactly as before", async () => {
    const w = world();
    const id = await w.create();
    expect(w.store.row(id).serverMap).toBeNull();
    const v = await w.view(id);
    expect(v.serverMap).toEqual({});
    expect(v.targetServers).toEqual([{ serverId: SERVER, serverName: "tugra-box", primary: true }]);
    expect(v.campaign).toBeNull();
    expect([...w.store.serverLocks.keys()]).toEqual([SERVER]);
  });

  it("every mapped target must exist on the run's team: unknown and foreign servers are 404 server-not-found, and nothing is created", async () => {
    const w = world();
    await expect(w.create({ serverMap: { "src-a": "ghost" } })).rejects.toThrow(/server-not-found/);
    await expect(w.create({ serverMap: { "src-a": "srv-foreign" } })).rejects.toThrow(/server-not-found/);
    expect(w.store.runs.size).toBe(0);
    expect(w.store.serverLocks.size).toBe(0);
  });

  it("a target that is offline, still waiting for its agent or without the deploy grant is refused up front with a code, and nothing is created", async () => {
    const w = world();
    w.env.serversById.set("srv-off", { id: "srv-off", name: "off", teamId: TEAM, status: "OFFLINE", capabilities: ["deploy"] });
    w.env.serversById.set("srv-new", { id: "srv-new", name: "new", teamId: TEAM, status: "PENDING", capabilities: ["deploy"] });
    w.env.serversById.set("srv-nocap", { id: "srv-nocap", name: "nocap", teamId: TEAM, status: "ONLINE", capabilities: ["backup"] });
    w.env.serversById.set("srv-ok", { id: "srv-ok", name: "ok", teamId: TEAM, status: "ONLINE", capabilities: ["deploy"] });
    await expect(w.create({ serverMap: { "src-a": "srv-off" } })).rejects.toThrow(/target-offline/);
    await expect(w.create({ serverMap: { "src-a": "srv-new" } })).rejects.toThrow(/target-agent-pending/);
    await expect(w.create({ serverMap: { "src-a": "srv-nocap" } })).rejects.toThrow(/target-capability/);
    expect(w.store.runs.size).toBe(0);
    await expect(w.create({ serverMap: { "src-a": "srv-ok" } })).resolves.toBeTruthy();
  });

  it("a proxy swap cannot span several servers or a source other than Coolify: refused at create, not at cutover", async () => {
    const w = world();
    await expect(w.create({ topology: "swap-proxy", serverMap: MAP })).rejects.toThrow(/swap-multi-target/);
    await expect(w.create({ topology: "swap-proxy", sourceKind: "dokploy" })).rejects.toThrow(/swap-unsupported-source/);
    expect(w.store.runs.size).toBe(0);
    await expect(w.create({ topology: "swap-proxy", serverMap: { "src-a": SERVER, "src-b": SERVER } })).resolves.toBeTruthy();
  });

  it("the report and its markdown list every target server", async () => {
    const w = world();
    const id = await w.run({ serverMap: MAP, campaign: "wave-1" });
    const rep = await w.service.report(ACTOR, id);
    expect(rep.targets.map((t) => t.serverName)).toEqual(["tugra-box", "host-2", "host-3"]);
    expect(rep.campaign).toBe("wave-1");
    expect(RunReportSchema.parse(JSON.parse(JSON.stringify(rep))).targets).toHaveLength(3);
    expect(await w.service.reportMarkdown(ACTOR, id)).toContain("Target servers (default first): tugra-box, host-2, host-3");
  });

  it("campaign filters the list", async () => {
    const w = world();
    const a = await w.create({ campaign: "wave-1", dryRun: true });
    await w.create({ campaign: "wave-2", dryRun: true });
    await w.create({ dryRun: true });
    expect((await w.service.list(ACTOR, { limit: 10, campaign: "wave-1" })).map((r) => r.id)).toEqual([a]);
    expect(await w.service.list(ACTOR, { limit: 10, campaign: "nope" })).toEqual([]);
  });
});

describe("one live run per target server covers every mapped server", () => {
  it("a real run locks the default AND each mapped target", async () => {
    const w = world();
    await w.create({ serverMap: MAP });
    expect([...w.store.serverLocks.keys()].sort()).toEqual([SERVER, "srv2", "srv3"]);
  });

  it("a second run is refused when ANY of its targets is held (default vs mapped, mapped vs mapped, mapped vs default)", async () => {
    const w = world();
    await w.create({ serverMap: MAP }); // holds srv1, srv2, srv3
    await expect(w.create({ targetServerId: "srv2" })).rejects.toThrow(/server-has-live-run/); // default of B is a mapped target of A
    await expect(w.create({ targetServerId: "srv4", serverMap: { "src-z": "srv3" } })).rejects.toThrow(/server-has-live-run/); // mapped of B is mapped of A
    await expect(w.create({ targetServerId: "srv4", serverMap: { "src-z": SERVER } })).rejects.toThrow(/server-has-live-run/); // mapped of B is default of A
    // nothing leaked from the refused creates: srv4 stays free
    expect(w.store.serverLocks.has("srv4")).toBe(false);
    expect(w.store.runs.size).toBe(1);
    const free = await w.create({ targetServerId: "srv4" });
    expect(w.store.row(free).status).toBe("QUEUED");
  });

  it("dry-runs hold no lock and never conflict", async () => {
    const w = world();
    await w.create({ serverMap: MAP, dryRun: true });
    await w.create({ serverMap: MAP, dryRun: true });
    expect(w.store.serverLocks.size).toBe(0);
    await w.create({ serverMap: MAP });
    expect(w.store.serverLocks.size).toBe(3);
  });

  it("every lock is released when the run completes, so the servers are free again", async () => {
    const w = world();
    const id = await w.run({ serverMap: MAP });
    expect(w.status(id)).toBe("COMPLETED");
    expect(w.store.serverLocks.size).toBe(0);
    expect(w.store.row(id).activeKey).toBeNull();
    await w.create({ targetServerId: "srv3" });
  });

  it("an abort frees every target; a cleanup re-arms them all (and is refused while another run holds one of them)", async () => {
    const w = world({ stubs: { DATA_FINAL: { blocked: () => true } } });
    const id = await w.run({ serverMap: MAP });
    expect(w.status(id)).toBe("WAITING");
    expect(w.store.serverLocks.size).toBe(3);
    await w.service.abort(ACTOR, id, { confirmName: id });
    await w.settle(id);
    expect(w.status(id)).toBe("ABORTED");
    expect(w.store.serverLocks.size).toBe(0);

    // another run takes one of the freed servers: the cleanup cannot re-arm
    const other = await w.create({ targetServerId: "srv3" });
    await expect(w.service.cleanup(ACTOR, id, { confirmName: id, includeData: false, dataConfirmNames: [] })).rejects.toThrow(/server-has-live-run/);
    expect(w.status(id)).toBe("ABORTED");
    expect([...w.store.serverLocks.entries()]).toEqual([["srv3", other]]); // the failed re-arm changed nothing

    await w.service.abort(ACTOR, other, { confirmName: other });
    await w.settle(other);
    await w.service.cleanup(ACTOR, id, { confirmName: id, includeData: false, dataConfirmNames: [] });
    expect([...w.store.serverLocks.keys()].sort()).toEqual([SERVER, "srv2", "srv3"]);
    await w.settle(id);
    expect(w.status(id)).toBe("ROLLED_BACK");
    expect(w.store.serverLocks.size).toBe(0);
  });

  it("promoting a dry-run into a real run locks every mapped target and copies the map and campaign", async () => {
    const w = world();
    const d = await w.create({ serverMap: MAP, campaign: "wave-1", dryRun: true });
    await w.settle(d);
    await w.acceptWarnings(d);
    const real = await w.service.start(ACTOR, d, {});
    expect(w.store.row(real.id)).toMatchObject({ serverMap: MAP, campaign: "wave-1", promotedFromId: d });
    expect([...w.store.serverLocks.keys()].sort()).toEqual([SERVER, "srv2", "srv3"]);
  });
});

describe("ctx.targetFor and ctx.targetServerIds", () => {
  it("handlers resolve the target of a source server through the map; unmapped sources fall back to the default", async () => {
    const seen: Array<{ a: string; b: string; z: string; none: string; all: readonly string[] }> = [];
    const probe = async (x: RunWorld, ctx: StepContext) => {
      seen.push({ a: ctx.targetFor("src-a"), b: ctx.targetFor("src-b"), z: ctx.targetFor("src-z"), none: ctx.targetFor(null), all: ctx.targetServerIds });
      x.done.add("FREEZE");
      return { outcome: "done" as const };
    };
    const w = world({ stubs: { FREEZE: { act: probe } } });
    await w.run({ serverMap: MAP });
    expect(seen[0]).toEqual({ a: "srv2", b: "srv3", z: SERVER, none: SERVER, all: [SERVER, "srv2", "srv3"] });
  });

  it("a single-target run resolves everything to the default", async () => {
    const seen: string[][] = [];
    const w = world({
      stubs: {
        FREEZE: {
          act: async (x, ctx) => {
            seen.push([ctx.targetFor("src-a"), ...ctx.targetServerIds]);
            x.done.add("FREEZE");
            return { outcome: "done" };
          },
        },
      },
    });
    await w.run();
    expect(seen[0]).toEqual([SERVER, SERVER]);
  });

  it("the snapshot carries the map, the version, the campaign and a null baseline until one is captured", async () => {
    let snap: StepContext["run"] | undefined;
    const w = world({ stubs: { FREEZE: { act: async (x, ctx) => ((snap = ctx.run), x.done.add("FREEZE"), { outcome: "done" }) } } });
    w.port.version_ = "4.1.2";
    await w.run({ serverMap: MAP, campaign: "wave-1" });
    expect(snap).toMatchObject({ serverMap: MAP, sourceVersion: "4.1.2", campaign: "wave-1", sourceBaseline: null, targetServerId: SERVER });
  });
});

describe("the typed confirmation names every target server", () => {
  it("confirmMatches: a multi-server run needs the sorted, comma-joined names; the single-server kind is read as the multi-server one", () => {
    const ctx = { runId: "r1", serverName: "host-b", serverNames: ["host-b", "host-a", "host-c"], sourceHost: "src.example.test" };
    expect(confirmMatches("target-servers", "host-a, host-b, host-c", ctx)).toBe(true);
    expect(confirmMatches("target-servers", "host-b", ctx)).toBe(false);
    expect(confirmMatches("target-servers", "host-b, host-a, host-c", ctx)).toBe(false); // order is canonical, not map order
    expect(confirmMatches("target-server", "host-b", ctx)).toBe(false); // upgraded: naming only the default is no longer enough
    expect(confirmMatches("target-server", "host-a, host-b, host-c", ctx)).toBe(true);
    expect(confirmMatches("target-servers+source-host", "host-a, host-b, host-c src.example.test", ctx)).toBe(true);
    expect(confirmMatches("target-server+source-host", "host-b src.example.test", ctx)).toBe(false);
    expect(confirmMatches("target-server+source-host", "host-a, host-b, host-c src.example.test", ctx)).toBe(true);
    expect(confirmMatches("target-servers", "host-a, host-b, host-c", { ...ctx, serverNames: ["host-a", "", "host-c"] })).toBe(false); // an unnamed server can never be confirmed
  });

  it("a single-server run keeps the classic confirmation text", () => {
    const ctx = { runId: "r1", serverName: "box", sourceHost: "src.example.test" };
    expect(confirmMatches("target-server", "box", ctx)).toBe(true);
    expect(confirmMatches("target-server", "box", { ...ctx, serverNames: ["box"] })).toBe(true);
    expect(confirmMatches("target-servers", "box", { ...ctx, serverNames: ["box"] })).toBe(true);
    expect(confirmMatches("target-server+source-host", "box src.example.test", ctx)).toBe(true);
  });

  it("a handler asking for `target-server` is upgraded in the view and the approval only accepts all the names", async () => {
    const w = world({ stubs: { FREEZE: { binding: () => ponr("target-server") } } });
    const id = await w.run({ serverMap: MAP });
    const view = await w.view(id);
    expect(view.nextAction.approval?.confirm).toBe("target-servers");
    const ok = { boundHash: "a".repeat(64), acks: [] };
    await expect(w.service.approve(ACTOR, id, "FREEZE", { ...ok, confirmName: "tugra-box" })).rejects.toThrow(/bad-confirmation/);
    await expect(w.service.approve(ACTOR, id, "FREEZE", { ...ok, confirmName: "host-2, host-3" })).rejects.toThrow(/bad-confirmation/);
    await w.service.approve(ACTOR, id, "FREEZE", { ...ok, confirmName: "host-2, host-3, tugra-box" });
    expect((w.store.step(id, "FREEZE").approval as { confirmedName: string }).confirmedName).toBe("host-2, host-3, tugra-box");
  });

  it("a single-target run is not upgraded", async () => {
    const w = world({ stubs: { FREEZE: { binding: () => ponr("target-server") } } });
    const id = await w.run();
    expect((await w.view(id)).nextAction.approval?.confirm).toBe("target-server");
    await w.service.approve(ACTOR, id, "FREEZE", { boundHash: "a".repeat(64), acks: [], confirmName: "tugra-box" });
  });

  it("the takeover form names every server and the source host", async () => {
    const w = world({ stubs: { FREEZE: { binding: () => ponr("target-server+source-host") } } });
    const id = await w.run({ serverMap: MAP, mode: "takeover" });
    expect((await w.view(id)).nextAction.approval?.confirm).toBe("target-servers+source-host");
    await expect(w.service.approve(ACTOR, id, "FREEZE", { boundHash: "a".repeat(64), acks: [], confirmName: "tugra-box coolify.example.com" })).rejects.toThrow(/bad-confirmation/);
    await w.service.approve(ACTOR, id, "FREEZE", { boundHash: "a".repeat(64), acks: [], confirmName: "host-2, host-3, tugra-box coolify.example.com" });
  });
});

describe("source version, baseline and run patches", () => {
  it("captures the version at create, judges it in the view and emits one event (a warning outside the supported range)", async () => {
    const w = world();
    w.port.version_ = "4.1.2";
    const ok = await w.create();
    expect(w.store.row(ok).sourceVersion).toBe("4.1.2");
    expect((await w.view(ok)).sourceVersionVerdict).toBe("supported");
    expect(w.store.eventRows.find((e) => e.runId === ok && e.code === "run.source-version")).toMatchObject({ level: "info", params: { version: "4.1.2", verdict: "supported" } });

    w.env.serversById.set("srv9", { id: "srv9", name: "host-9", teamId: TEAM });
    w.port.version_ = "4.0.0-beta.442";
    const old = await w.create({ targetServerId: "srv9" });
    expect((await w.view(old)).sourceVersionVerdict).toBe("too-old");
    expect(w.store.eventRows.find((e) => e.runId === old && e.code === "run.source-version")).toMatchObject({ level: "warn", params: { verdict: "too-old" } });
  });

  it("an unreadable or absent version leaves it unknown without failing the create (no event, verdict unknown)", async () => {
    const w = world();
    w.port.throwVersion = true;
    const a = await w.create();
    expect(w.store.row(a).sourceVersion).toBeNull();
    expect((await w.view(a)).sourceVersionVerdict).toBe("unknown");
    w.port.throwVersion = false;
    w.port.version_ = null;
    w.env.serversById.set("srv9", { id: "srv9", name: "host-9", teamId: TEAM });
    const b = await w.create({ targetServerId: "srv9" });
    expect(w.store.row(b).sourceVersion).toBeNull();
    expect(w.store.eventRows.some((e) => e.code === "run.source-version")).toBe(false);
    w.env.serversById.set("srv8", { id: "srv8", name: "host-8", teamId: TEAM });
    w.port.version_ = "not a version at all, with spaces";
    const c = await w.create({ targetServerId: "srv8" });
    expect(w.store.row(c).sourceVersion).toBeNull(); // not a short printable token: never stored
  });

  it("a handler refreshes the version and records the baseline with patchRun; the baseline is ignored once FREEZE opened the window", async () => {
    const baseline = { capturedAt: "2026-11-23T08:00:00.000Z", entries: [{ kind: "app" as const, ref: "app-a", health: "unhealthy" as const, restartCount: 126 }] };
    const w = world({
      stubs: {
        FREEZE: {
          act: async (x, ctx) => {
            await ctx.patchRun({ sourceVersion: " 4.7.5 ", sourceBaseline: baseline });
            x.done.add("FREEZE");
            return { outcome: "done" };
          },
        },
        DATA_FINAL: {
          act: async (x, ctx) => {
            await ctx.patchRun({ freezeStartedAt: ctx.now() });
            await ctx.patchRun({ sourceBaseline: { capturedAt: "2026-11-23T09:00:00.000Z", entries: [] }, sourceVersion: "bad version" });
            x.done.add("DATA_FINAL");
            return { outcome: "done" };
          },
        },
      },
    });
    const id = await w.run();
    const row = w.store.row(id);
    expect(row.sourceVersion).toBe("4.7.5");
    expect(row.sourceBaseline).toEqual(baseline); // the later (post-freeze) baseline was dropped, the invalid version too
    const v = await w.view(id);
    expect(v.baselineAt).toBe(baseline.capturedAt);
    expect(JSON.stringify(v)).not.toContain("app-a"); // the baseline itself is not in the view
  });

  it("promoting keeps (or re-reads) the source version", async () => {
    const w = world();
    w.port.version_ = "4.2.0";
    const d = await w.create({ dryRun: true });
    await w.settle(d);
    await w.acceptWarnings(d);
    w.port.version_ = null;
    const real = await w.service.start(ACTOR, d, {});
    expect(real.sourceVersion).toBe("4.2.0");
  });
});

describe("campaign and command kinds on the service", () => {
  it("only the classic migrator command exists in the core; the other kinds are 409 until their lane mints them", async () => {
    const w = world({ stubs: { DATA_FINAL: { blocked: () => true } } });
    const id = await w.run();
    await expect(w.service.command(ACTOR, id, "DATA_FINAL", { reissue: false, kind: "host-loop" }, "https://hub.example.test")).rejects.toThrow(/command-kind-unavailable/);
  });
});
