import { Logger } from "@nestjs/common";
import { ACTOR, RunWorld, TEAM } from "./testing/run-world";

jest.setTimeout(30_000);

beforeAll(() => {
  jest.spyOn(Logger.prototype, "warn").mockImplementation();
  jest.spyOn(Logger.prototype, "error").mockImplementation();
  jest.spyOn(Logger.prototype, "log").mockImplementation();
});

const MIN = 60_000;

describe("the run keeper: an open run keeps its import session alive", () => {
  it("a queued run's session is still live after hours of ticks with no browser open, so a late wave finds it", async () => {
    const w = new RunWorld();
    const id = await w.create(); // QUEUED: a later wave of a campaign
    expect(w.status(id)).toBe("QUEUED");
    for (let i = 0; i < 12 * 4; i++) {
      w.clock.advance(15 * MIN);
      await w.tick();
    }
    // 12 hours later the session is still there (it was created for one hour)
    expect((await w.env.session("u1", "s1"))?.state).toBe("active");
    await expect(w.service.start(ACTOR, id, {})).resolves.toBeDefined();
  });

  it("without any open run the session runs out as before: nothing keeps an abandoned session alive", async () => {
    const w = new RunWorld();
    await w.tick();
    expect(w.env.renewals).toHaveLength(0);
    w.clock.advance(90 * MIN);
    await w.tick();
    expect((await w.env.session("u1", "s1"))?.state).toBe("expired");
  });

  it("renews only the sessions that open runs are bound to", async () => {
    const w = new RunWorld();
    w.env.sessions.set("other", w.env.session0("other"));
    await w.create();
    w.env.renewals.length = 0;
    await w.tick();
    expect(w.env.renewals).toEqual([["s1"]]);
  });

  it("a finished run no longer keeps its session", async () => {
    const w = new RunWorld();
    const id = await w.create();
    w.store.force(id, { status: "COMPLETED" });
    w.env.renewals.length = 0;
    await w.tick();
    expect(w.env.renewals).toHaveLength(0);
  });

  it("a failing keeper never stops the recovery pass", async () => {
    const w = new RunWorld();
    w.env.renewSessions = async () => {
      throw new Error("db down");
    };
    await w.create();
    await expect(w.tick()).resolves.toBeUndefined();
  });
});

describe("an action on a run is an action on its session", () => {
  it("create and start each move the session's end", async () => {
    const w = new RunWorld();
    const id = await w.create();
    expect(w.env.renewals).toContainEqual(["s1"]);
    w.env.renewals.length = 0;
    await w.start(id);
    expect(w.env.renewals).toContainEqual(["s1"]);
  });

  it("so does the promotion of a dry run", async () => {
    const w = new RunWorld();
    const d = await w.create({ dryRun: true });
    await w.settle(d);
    await w.acceptWarnings(d);
    w.env.renewals.length = 0;
    await w.service.start(ACTOR, d, {});
    expect(w.env.renewals).toContainEqual(["s1"]);
  });

  it("an ended session is not brought back by an action (the renewal only moves a live one)", async () => {
    const w = new RunWorld();
    const id = await w.create();
    w.clock.advance(2 * 60 * MIN);
    await expect(w.service.start(ACTOR, id, {})).resolves.toBeDefined(); // start leaves an ended session to the steps' own wait
    expect((await w.env.session("u1", "s1"))?.state).toBe("expired");
  });
});

describe("a run re-binds to a renewed session of the same source through the agent", () => {
  const agentWorld = async () => {
    const w = new RunWorld();
    const s = w.env.sessions.get("s1")!;
    s.baseUrl = "agent://srv-agent";
    s.sourceTeamRef = "team-ref";
    s.scopeKey = "coolify-main";
    const id = await w.create();
    return { w, id, s };
  };

  it("reconnects through the run's own agent and Coolify team, binds the new session and kicks the run", async () => {
    const { w, id, s } = await agentWorld();
    s.state = "expired";
    const r = await w.service.sourceSession(ACTOR, id, { agent: true });
    expect(w.env.agentConnects).toEqual([{ teamId: TEAM, serverId: "srv-agent", sourceTeamRef: "team-ref", scopeLabel: "coolify-main" }]);
    expect(w.store.row(id).sessionId).toBe(r.sessionId);
    expect(r.sessionId).not.toBe("s1");
    expect(w.store.codes(id)).toContain("run.session.refreshed");
    expect(w.env.connects).toHaveLength(0); // no token path
    expect(JSON.stringify(w.sink.audits)).not.toMatch(/token/i);
  });

  it("a run parked on its ended session says where the session reads from, so the screen offers the reconnect that fits; a run that is not, carries nothing", async () => {
    const w = new RunWorld();
    const s = w.env.sessions.get("s1")!;
    s.baseUrl = "agent://srv-agent";
    s.sourceTeamRef = "team-ref";
    const quiet = await w.create();
    expect((await w.view(quiet)).sourceSession).toBeUndefined();
    const w2 = new RunWorld();
    const s2 = w2.env.sessions.get("s1")!;
    s2.baseUrl = "agent://srv-agent";
    s2.sourceTeamRef = "team-ref";
    w2.port.session = "expired";
    const id = await w2.run();
    const v = await w2.view(id);
    expect(v.nextAction.kind).toBe("session");
    expect(v.sourceSession).toMatchObject({ viaAgent: true, agentServerId: "srv-agent", sourceTeamRef: "team-ref" });
  });

  it("works when the old session row is gone: the run stored the agent server and the team", async () => {
    const { w, id } = await agentWorld();
    w.env.sessions.delete("s1");
    await w.service.sourceSession(ACTOR, id, { agent: true });
    expect(w.env.agentConnects[0]).toMatchObject({ serverId: "srv-agent", sourceTeamRef: "team-ref" });
  });

  it("binds nothing when the source changed since the run was planned (409 plan-changed) and gives the new session back", async () => {
    const { w, id } = await agentWorld();
    w.port.plan_ = { ...w.port.plan_, planHash: "e".repeat(32) };
    await expect(w.service.sourceSession(ACTOR, id, { agent: true })).rejects.toThrow(/plan-changed/);
    expect(w.store.row(id).sessionId).toBe("s1");
    expect(w.env.endedSessions).toHaveLength(1);
  });

  it("a token session is not reconnected through an agent, and an agent session is not asked for a token", async () => {
    const w = new RunWorld();
    const id = await w.create();
    await expect(w.service.sourceSession(ACTOR, id, { agent: true })).rejects.toThrow(/source-not-agent/);
    expect(w.env.agentConnects).toHaveLength(0);
    const { w: aw, id: aid } = await agentWorld();
    await expect(aw.service.sourceSession(ACTOR, aid, { token: "t" })).rejects.toThrow(/source-is-agent/);
  });

  it("two reconnects at once cannot cross: the second one finds the run already re-bound", async () => {
    const { w, id } = await agentWorld();
    const first = await w.service.sourceSession(ACTOR, id, { agent: true });
    // a stale tab still holds the old binding: its compare-and-set fails and its own session is given back
    const stale = jest.spyOn(w.store, "updateRun").mockImplementationOnce(async () => false);
    await expect(w.service.sourceSession(ACTOR, id, { agent: true })).rejects.toThrow(/run-not-open/);
    stale.mockRestore();
    expect(w.store.row(id).sessionId).toBe(first.sessionId);
    expect(w.env.endedSessions).toHaveLength(1);
  });

  it("a finished dry run takes the new session at its promotion: nothing is stored on it", async () => {
    const w = new RunWorld();
    const s = w.env.sessions.get("s1")!;
    s.baseUrl = "agent://srv-agent";
    const d = await w.create({ dryRun: true });
    await w.settle(d);
    const r = await w.service.sourceSession(ACTOR, d, { agent: true });
    expect(w.store.row(d).sessionId).toBe("s1");
    expect(r.sessionId).toMatch(/^s-agent-/);
  });

  it("the new session starts without the owner's consent: it is never copied from the old session id", async () => {
    const { w, id } = await agentWorld();
    await w.service.sourceSession(ACTOR, id, { agent: true });
    expect(w.env.agentConnects).toHaveLength(1);
    // the port carries no grant material; the only things that cross are ids
    expect(Object.keys(w.env.agentConnects[0]).sort()).toEqual(["scopeLabel", "serverId", "sourceTeamRef", "teamId"]);
  });
});
