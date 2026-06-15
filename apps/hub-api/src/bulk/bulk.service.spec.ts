import { Role } from "@prisma/client";
import { planTargets } from "./bulk.service";

describe("planTargets (bulk role gating)", () => {
  const servers = [
    { id: "a", teamId: "t1" },
    { id: "b", teamId: "t2" },
  ];
  const roles = new Map<string, Role>([
    ["t1", Role.OWNER],
    ["t2", Role.VIEWER],
  ]);

  it("runs writable servers and skips viewer / unknown ones", () => {
    const out = planTargets(["a", "b", "ghost"], servers, roles);
    expect(out.find((t) => t.serverId === "a")!.run).toBe(true); // OWNER
    expect(out.find((t) => t.serverId === "b")!.run).toBe(false); // VIEWER
    expect(out.find((t) => t.serverId === "ghost")!.run).toBe(false); // unknown
  });
});
