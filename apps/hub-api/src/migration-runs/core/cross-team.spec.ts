import { Logger } from "@nestjs/common";
import { ACTOR, RunWorld, TEAM, defaultPlan } from "./testing/run-world";

jest.setTimeout(30_000);
beforeAll(() => {
  jest.spyOn(Logger.prototype, "warn").mockImplementation();
  jest.spyOn(Logger.prototype, "error").mockImplementation();
  jest.spyOn(Logger.prototype, "log").mockImplementation();
});

/** The Coolify import session belongs to TEAM (where the Coolify host is); the servers the owner moves onto sit in other teams. */
const TEAM_B = "t-b";
const SRV_B = "srv-b";
const world = () => {
  const w = new RunWorld();
  w.env.teams = [TEAM, TEAM_B];
  w.env.serversById.set(SRV_B, { id: SRV_B, name: "box-b", teamId: TEAM_B, status: "ONLINE", capabilities: ["deploy"] });
  w.port.plan_ = defaultPlan({
    items: [{ itemRef: "app:srvA:web", kind: "app", name: "web", proposed: {}, risks: [], dependsOn: [] }],
    preflight: { databases: [], services: [], appsWithVolumeData: 0, hosts: [{ ref: "srvA" }] },
  });
  return w;
};

describe("a run whose target is in another team than the import session", () => {
  it("is created in the target's team, labelled with the campaign, and read back by the actor", async () => {
    const w = world();
    const id = await w.create({ targetServerId: SRV_B, campaign: "move-1", scope: { sourceServers: ["srvA"] }, dryRun: true });
    expect(w.store.row(id)).toMatchObject({ teamId: TEAM_B, sessionId: "s1", campaign: "move-1", targetServerId: SRV_B });
    expect((await w.service.get(ACTOR, id)).id).toBe(id);
  });
  it("an in-place takeover of a machine in another team than the session works the same", async () => {
    const w = world();
    const v = await w.service.create(ACTOR, w.createBody({ targetServerId: SRV_B, topology: "swap-proxy", mode: "takeover", dryRun: true, campaign: "move-1", scope: { sourceServers: ["srvA"] } }), { inPlace: true });
    expect(w.store.row(v.id)).toMatchObject({ teamId: TEAM_B, inPlace: true });
  });
  it("still needs standing in the target's team (not the session's)", async () => {
    const w = world();
    w.env.perms[`u1|${TEAM_B}`] = { member: true, appsConfig: false, databases: true };
    await expect(w.create({ targetServerId: SRV_B, dryRun: true })).rejects.toThrow(/insufficient-permission/);
    w.env.perms[`u1|${TEAM_B}`] = { member: false, appsConfig: true, databases: true };
    await expect(w.create({ targetServerId: SRV_B, dryRun: true })).rejects.toThrow(/server-not-found/);
  });
});
