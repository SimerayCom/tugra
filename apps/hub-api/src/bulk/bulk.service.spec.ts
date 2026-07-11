import { planTargets } from "./bulk.service";

describe("planTargets (bulk permission gating)", () => {
  const servers = [
    { id: "a", teamId: "t1" },
    { id: "b", teamId: "t2" },
  ];
  // t1 has the "bulk" permission (e.g. OWNER/ADMIN or a custom role granting it); t2 does not.
  const perms = new Map<string, Set<string>>([
    ["t1", new Set(["bulk", "monitors"])],
    ["t2", new Set(["monitors"])],
  ]);

  it("runs targets whose team has the required permission, skips the rest / unknown", () => {
    const out = planTargets(["a", "b", "ghost"], servers, perms, "bulk");
    expect(out.find((t) => t.serverId === "a")!.run).toBe(true); // has "bulk"
    expect(out.find((t) => t.serverId === "b")!.run).toBe(false); // lacks "bulk"
    expect(out.find((t) => t.serverId === "ghost")!.run).toBe(false); // unknown server
  });

  it("gates on the specific permission it is given", () => {
    const out = planTargets(["a", "b"], servers, perms, "monitors");
    expect(out.find((t) => t.serverId === "a")!.run).toBe(true); // has "monitors"
    expect(out.find((t) => t.serverId === "b")!.run).toBe(true); // has "monitors"
  });
});
