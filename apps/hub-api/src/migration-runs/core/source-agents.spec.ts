/**
 * "A move starts only when both ends have an agent" (Coolify hub takeover, lane C), through the real service over the in-memory world.
 * The target end is the run's own readiness check (multi-host.spec); this file covers the source end.
 */
import { Logger } from "@nestjs/common";
import { ACTOR, RunWorld, TEAM, defaultPlan } from "./testing/run-world";

jest.setTimeout(30_000);

beforeAll(() => {
  jest.spyOn(Logger.prototype, "warn").mockImplementation();
  jest.spyOn(Logger.prototype, "error").mockImplementation();
  jest.spyOn(Logger.prototype, "log").mockImplementation();
});

const GAP = { ref: "src-a", name: "Edge A", state: "no_agent" as const };

describe("a real run needs an agent on every source server it moves from", () => {
  it("refuses a real run while a source server has no agent, naming it, and creates nothing", async () => {
    const w = new RunWorld();
    w.port.agentGaps = { gaps: [GAP, { ref: "src-b", name: "Edge B", state: "offline" }], unverified: false };
    const err = await w.create({ dryRun: false }).catch((e: unknown) => e as { getResponse(): Record<string, unknown> });
    expect((err as { getResponse(): unknown }).getResponse()).toMatchObject({
      statusCode: 422,
      code: "source-agent-missing",
      hosts: [GAP, { ref: "src-b", name: "Edge B", state: "offline" }],
    });
    expect(w.store.runs.size).toBe(0);
  });

  it("refuses a real run it cannot verify (fail closed)", async () => {
    const w = new RunWorld();
    w.port.agentGaps = { gaps: [], unverified: true };
    await expect(w.create({ dryRun: false })).rejects.toThrow(/source-agents-unverified/);
    expect(w.store.runs.size).toBe(0);
  });

  it("starts a real run once every source server is covered", async () => {
    const w = new RunWorld();
    await expect(w.create({ dryRun: false })).resolves.toBeTruthy();
    expect(w.port.agentGapCalls).toHaveLength(1);
  });

  it("does not refuse a dry run: it writes nothing and is where the owner sees what is missing", async () => {
    const w = new RunWorld();
    w.port.agentGaps = { gaps: [GAP], unverified: false };
    await expect(w.create({ dryRun: true })).resolves.toBeTruthy();
    expect(w.port.agentGapCalls).toHaveLength(0);
  });

  it("passes the run's frozen mapping, so an item the run leaves out takes no part", async () => {
    const w = new RunWorld();
    w.port.plan_ = defaultPlan({
      items: [
        { itemRef: "database:src-a:db1", kind: "database", name: "pg-main", proposed: { engine: "POSTGRES" }, risks: [], dependsOn: [] },
        { itemRef: "app:src-b:web", kind: "app", name: "web", proposed: { domain: "web.example.com" }, risks: [], dependsOn: [] },
      ],
    });
    for (const [id, name] of [["srv2", "host-2"], ["srv3", "host-3"]] as const) w.env.serversById.set(id, { id, name, teamId: TEAM });
    await w.create({ dryRun: false, serverMap: { "src-a": "srv2", "src-b": "srv3" }, scope: { sourceServers: ["src-a", "src-b"], exclude: ["database:src-a:db1"] } });
    const call = w.port.agentGapCalls[0];
    expect(call?.mapping?.items["database:src-a:db1"]).toMatchObject({ include: false });
  });

  it("checks again when a finished dry run is promoted to a real one", async () => {
    const w = new RunWorld();
    const d = await w.create({ dryRun: true });
    await w.settle(d);
    await w.acceptWarnings(d);
    w.port.agentGaps = { gaps: [GAP], unverified: false };
    await expect(w.service.start(ACTOR, d, {})).rejects.toMatchObject({ response: { code: "source-agent-missing" } });
    expect(w.status(d)).toBe("DRY_RUN_DONE"); // nothing was created
    w.port.agentGaps = { gaps: [], unverified: false };
    const promoted = await w.service.start(ACTOR, d, {});
    expect(promoted.promotedFromId).toBe(d);
  });
});

describe("the same gap is said on a finished dry run before the promotion is tried", () => {
  it("lists the source servers without an online agent, and nothing once they all have one", async () => {
    const w = new RunWorld();
    const d = await w.create({ dryRun: true });
    await w.settle(d);
    w.port.agentGaps = { gaps: [GAP, { ref: "src-b", name: "Edge B", state: "offline" }], unverified: false };
    expect(await w.service.sourceAgents(ACTOR, d, {})).toEqual({ gaps: [GAP, { ref: "src-b", name: "Edge B", state: "offline" }], unverified: false });
    w.port.agentGaps = { gaps: [], unverified: false };
    expect(await w.service.sourceAgents(ACTOR, d, {})).toEqual({ gaps: [], unverified: false });
  });

  it("reads on the renewed session the screen made, and says unverified, not empty, when the session ended or the source cannot be read", async () => {
    const w = new RunWorld();
    const d = await w.create({ dryRun: true });
    await w.settle(d);
    w.env.sessions.get("s1")!.state = "expired";
    expect(await w.service.sourceAgents(ACTOR, d, {})).toEqual({ gaps: [], unverified: true });
    const renewed = await w.service.sourceSession(ACTOR, d, { token: "t" });
    w.port.agentGaps = { gaps: [GAP], unverified: false };
    expect((await w.service.sourceAgents(ACTOR, d, { sessionId: renewed.sessionId })).gaps).toEqual([GAP]);
    expect(w.port.agentGapCalls.at(-1)?.sessionId).toBe(renewed.sessionId);
    w.env.sessions.get("s1")!.state = "active";
    w.port.agentGaps = { gaps: [], unverified: true };
    expect(await w.service.sourceAgents(ACTOR, d, {})).toEqual({ gaps: [], unverified: true });
    jest.spyOn(w.port, "sourceAgentGaps").mockRejectedValueOnce(new Error("down"));
    expect(await w.service.sourceAgents(ACTOR, d, {})).toEqual({ gaps: [], unverified: true });
  });

  it("is only for a finished dry run, and only for its creator", async () => {
    const w = new RunWorld();
    const real = await w.create({ dryRun: false });
    await expect(w.service.sourceAgents(ACTOR, real, {})).rejects.toThrow(/not-a-finished-dry-run/);
    await expect(w.service.sourceAgents({ ...ACTOR, userId: "someone-else" }, real, {})).rejects.toThrow(/run-not-found/);
  });
});
