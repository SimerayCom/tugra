import { sourceAgentGaps, type CoveragePlan } from "./agent-coverage";

const plan = (hosts: CoveragePlan["preflight"] extends infer P ? (P extends { hosts?: infer H } ? H : never) : never, refs: string[] = ["app:srv-a:1", "database:srv-b:2"]): CoveragePlan => ({
  items: refs.map((itemRef) => ({ itemRef, kind: itemRef.split(":")[0] })),
  preflight: { hosts },
});

describe("sourceAgentGaps", () => {
  it("has no gap when every source server with something to move has an online agent", () => {
    const p = plan([
      { ref: "srv-a", name: "a", tugra: { serverId: "1" }, agentOnline: true },
      { ref: "srv-b", name: "b", tugra: { serverId: "2" }, agentOnline: true },
    ]);
    expect(sourceAgentGaps(p)).toEqual({ gaps: [], unverified: false });
  });

  it("flags a server with no match as no_agent and a matched but offline one as offline, by name", () => {
    const p = plan([
      { ref: "srv-a", name: "Edge A", agentOnline: false },
      { ref: "srv-b", name: "Edge B", tugra: { serverId: "2" }, agentOnline: false },
    ]);
    expect(sourceAgentGaps(p)).toEqual({
      gaps: [
        { ref: "srv-a", name: "Edge A", state: "no_agent" },
        { ref: "srv-b", name: "Edge B", state: "offline" },
      ],
      unverified: false,
    });
  });

  it("does not flag the control-plane box or any server that holds nothing to move", () => {
    const p = plan([
      { ref: "srv-a", name: "a", tugra: { serverId: "1" }, agentOnline: true },
      { ref: "srv-b", name: "b", tugra: { serverId: "2" }, agentOnline: true },
      { ref: "srv-hub", name: "coolify", agentOnline: false },
    ]);
    expect(sourceAgentGaps(p).gaps).toEqual([]);
  });

  it("ignores items the run leaves out, and a server whose items are all left out needs no agent", () => {
    const p = plan([
      { ref: "srv-a", name: "a", tugra: { serverId: "1" }, agentOnline: true },
      { ref: "srv-b", name: "b", agentOnline: false },
    ]);
    expect(sourceAgentGaps(p).gaps).toHaveLength(1);
    expect(sourceAgentGaps(p, { items: { "database:srv-b:2": { include: false } } as never })).toEqual({ gaps: [], unverified: false });
  });

  it("says unverified, not covered, when the plan carries no placement facts or an unknown host", () => {
    expect(sourceAgentGaps({ items: [{ itemRef: "app:srv-a:1", kind: "app" }] }).unverified).toBe(true);
    expect(sourceAgentGaps(plan([], ["app:srv-a:1"])).unverified).toBe(true);
    expect(sourceAgentGaps(plan([{ ref: "srv-z", name: "z", agentOnline: true }], ["app:srv-a:1"])).unverified).toBe(true);
    expect(sourceAgentGaps(plan([{ ref: "srv-a", name: "a" }], ["app:srv-a:1"])).unverified).toBe(true); // agentOnline never computed
  });

  it("has nothing to check for a plan with nothing placeable", () => {
    expect(sourceAgentGaps({ items: [{ itemRef: "volume:srv-a:v", kind: "volume" }] })).toEqual({ gaps: [], unverified: false });
    expect(sourceAgentGaps({ items: [] })).toEqual({ gaps: [], unverified: false });
  });
});
