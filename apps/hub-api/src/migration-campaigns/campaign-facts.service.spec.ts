import { ConflictException } from "@nestjs/common";
import { CampaignFactsService, hostFactOf } from "./campaign-facts.service";
import { inPlaceLock } from "./campaign-plan";

const HASH = "c".repeat(32);

const planOf = (hash: string, agentServerId: string | null = null) => ({
  planHash: hash,
  items: [{ itemRef: "app:a:one", kind: "app", name: "one" }],
  preflight: {
    hosts: [
      { ref: "local", name: "localhost", controlPlane: true as const, tugra: { serverId: "srv-panel", name: "panel", teamId: "t1", via: "owner" as const, confidence: "certain" as const } },
      { ref: "alias", name: "same-box-by-ip", tugra: { serverId: "srv-panel", name: "panel", teamId: "t1", via: "public-ip" as const, confidence: "certain" as const } },
      { ref: "other", name: "other", tugra: { serverId: "srv-other", name: "other", teamId: "t1", via: "public-ip" as const, confidence: "certain" as const } },
    ],
    ...(agentServerId ? { agentRead: { transport: "agent" as const, agentServerId, schemaVersion: null, coolifyImage: null, readAt: "", counts: { teams: 1, projects: 1, servers: 3, applications: 1, databases: 0, services: 0 } } } : {}),
  },
});

function build(plan: ReturnType<typeof planOf>) {
  const importer = { plan: jest.fn(async (..._a: unknown[]) => plan) };
  const prisma = { server: { findMany: jest.fn(async () => [{ id: "srv-panel", teamId: "t1", status: "ONLINE", capabilities: ["deploy"] }, { id: "srv-other", teamId: "t1", status: "ONLINE", capabilities: ["deploy"] }]) } };
  return { svc: new CampaignFactsService(prisma as never, importer as never), importer };
}

describe("CampaignFactsService.read", () => {
  it("re-plans with the data modes the owner reviewed, so a Volume choice does not make the hash differ for ever", async () => {
    const { svc, importer } = build(planOf(HASH));
    await svc.read("u1", { sessionId: "s1", planHash: HASH, serverIds: [], dbDataModes: { "database:a:pg": "volume" } });
    expect(importer.plan).toHaveBeenCalledWith("u1", { sourceKind: "coolify", sessionId: "s1", dbDataModes: { "database:a:pg": "volume" } });
  });
  it("sends no modes when there are none (the hash of a plan without them is unchanged)", async () => {
    const { svc, importer } = build(planOf(HASH));
    await svc.read("u1", { sessionId: "s1", planHash: HASH, serverIds: [] });
    expect(importer.plan).toHaveBeenCalledWith("u1", { sourceKind: "coolify", sessionId: "s1" });
  });
  it("a plan with another hash is still the 409 the owner must see", async () => {
    const { svc } = build(planOf("d".repeat(32)));
    await expect(svc.read("u1", { sessionId: "s1", planHash: HASH, serverIds: [] })).rejects.toBeInstanceOf(ConflictException);
  });
  it("a second Coolify row for the machine the panel runs on is the control plane too: in place is locked for it", async () => {
    const { svc } = build(planOf(HASH, "srv-panel"));
    const f = await svc.read("u1", { sessionId: "s1", planHash: HASH, serverIds: [] });
    const by = new Map(f.hosts.map((h) => [h.ref, h] as const));
    expect(by.get("local")?.controlPlane).toBe(true);
    expect(by.get("alias")?.controlPlane).toBe(true);
    expect(inPlaceLock(by.get("alias")!)).toBe("control_plane");
    expect(by.get("other")?.controlPlane).toBe(false);
  });
  it("without an agent read there is no machine to compare with: nothing changes for the token path", () => {
    const h = planOf(HASH).preflight.hosts[1];
    expect(hostFactOf(h as never, new Set(["srv-panel"])).controlPlane).toBe(false);
    expect(hostFactOf(h as never, new Set(["srv-panel"]), undefined, "srv-panel").controlPlane).toBe(true);
  });
});
