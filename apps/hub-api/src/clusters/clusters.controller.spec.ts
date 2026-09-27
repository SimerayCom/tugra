import { ClustersController } from "./clusters.controller";
import type { ClustersService } from "./clusters.service";
import type { SwarmService } from "./swarm.service";
import type { AuthUser } from "../auth/strategies/jwt.strategy";
import { REQUIRE_SCOPES } from "../api-tokens/require-scopes.decorator";

const USER = { userId: "u1", scopes: ["*"] } as AuthUser;

function make() {
  const svc = {
    list: jest.fn().mockResolvedValue([]),
    get: jest.fn().mockResolvedValue({ id: "c1" }),
    create: jest.fn().mockResolvedValue({ id: "c1" }),
    update: jest.fn().mockResolvedValue({ id: "c1" }),
    remove: jest.fn().mockResolvedValue(undefined),
    setServers: jest.fn().mockResolvedValue({ id: "c1" }),
  } as unknown as ClustersService;
  const swarm = {
    form: jest.fn().mockResolvedValue({ clusterId: "c1" }),
    status: jest.fn().mockResolvedValue({ clusterId: "c1" }),
    dissolve: jest.fn().mockResolvedValue({ clusterId: "c1" }),
    joinNode: jest.fn().mockResolvedValue({ clusterId: "c1" }),
    leaveNode: jest.fn().mockResolvedValue({ clusterId: "c1" }),
    setNodeLabels: jest.fn().mockResolvedValue({ clusterId: "c1" }),
    addManager: jest.fn().mockResolvedValue({ clusterId: "c1" }),
    removeManager: jest.fn().mockResolvedValue({ clusterId: "c1" }),
  } as unknown as SwarmService;
  return { ctrl: new ClustersController(svc, swarm), svc, swarm };
}

describe("ClustersController", () => {
  it("list forwards the teamId filter", async () => {
    const { ctrl, svc } = make();
    await ctrl.list(USER, "t1");
    expect(svc.list).toHaveBeenCalledWith("u1", "t1");
  });

  it("get / create / update / remove / setServers delegate to the service", async () => {
    const { ctrl, svc } = make();
    await ctrl.get(USER, "c1");
    expect(svc.get).toHaveBeenCalledWith("u1", "c1");
    await ctrl.create(USER, { teamId: "t1", name: "eu" });
    expect(svc.create).toHaveBeenCalledWith("u1", { teamId: "t1", name: "eu" });
    await ctrl.update(USER, "c1", { name: "eu2" });
    expect(svc.update).toHaveBeenCalledWith("u1", "c1", { name: "eu2" });
    await ctrl.remove(USER, "c1");
    expect(svc.remove).toHaveBeenCalledWith("u1", "c1");
    await ctrl.setServers(USER, "c1", { serverIds: ["s1"] });
    expect(svc.setServers).toHaveBeenCalledWith("u1", "c1", { serverIds: ["s1"] });
  });

  it("DELETE inherits the platform admin default (no scope override that would let a write-only PAT delete)", () => {
    // A @RequireScopes("write") override here would downgrade the destructive delete below the admin default.
    expect(Reflect.getMetadata(REQUIRE_SCOPES, ClustersController.prototype.remove)).toBeUndefined();
  });

  it("swarm form / status / dissolve delegate to the swarm service", async () => {
    const { ctrl, swarm } = make();
    await ctrl.formSwarm(USER, "c1", { managerServerId: "m1" });
    expect(swarm.form).toHaveBeenCalledWith("u1", "c1", { managerServerId: "m1" });
    await ctrl.swarmStatus(USER, "c1");
    expect(swarm.status).toHaveBeenCalledWith("u1", "c1");
    await ctrl.dissolveSwarm(USER, "c1");
    expect(swarm.dissolve).toHaveBeenCalledWith("u1", "c1");
    await ctrl.joinSwarmNode(USER, "c1", { serverId: "s2" });
    expect(swarm.joinNode).toHaveBeenCalledWith("u1", "c1", { serverId: "s2" });
    await ctrl.leaveSwarmNode(USER, "c1", "s2");
    expect(swarm.leaveNode).toHaveBeenCalledWith("u1", "c1", "s2");
    await ctrl.setNodeLabels(USER, "c1", "node_x", { add: { zone: "east" }, remove: [] });
    expect(swarm.setNodeLabels).toHaveBeenCalledWith("u1", "c1", "node_x", { add: { zone: "east" }, remove: [] });
  });

  it("PUT swarm/nodes/:nodeId/labels requires the elevated 'deploy' scope", () => {
    expect(Reflect.getMetadata(REQUIRE_SCOPES, ClustersController.prototype.setNodeLabels)).toEqual(["deploy"]);
  });

  it("POST swarm requires the elevated 'deploy' scope (above the plain-write default)", () => {
    expect(Reflect.getMetadata(REQUIRE_SCOPES, ClustersController.prototype.formSwarm)).toEqual(["deploy"]);
  });

  it("POST swarm/nodes (add node) requires the elevated 'deploy' scope", () => {
    expect(Reflect.getMetadata(REQUIRE_SCOPES, ClustersController.prototype.joinSwarmNode)).toEqual(["deploy"]);
  });

  it("DELETE swarm inherits the platform admin default (no scope override on the destructive dissolve)", () => {
    expect(Reflect.getMetadata(REQUIRE_SCOPES, ClustersController.prototype.dissolveSwarm)).toBeUndefined();
  });

  it("DELETE swarm node inherits the platform admin default (no scope override on node removal)", () => {
    expect(Reflect.getMetadata(REQUIRE_SCOPES, ClustersController.prototype.leaveSwarmNode)).toBeUndefined();
  });

  it("addManager / removeManager delegate to the swarm service (FLEET-G)", async () => {
    const { ctrl, swarm } = make();
    await ctrl.addManager(USER, "c1", { serverId: "s1" });
    expect(swarm.addManager).toHaveBeenCalledWith("u1", "c1", { serverId: "s1" });
    await ctrl.addManager(USER, "c1", { serverId: "s1", acknowledgeEvenQuorum: true });
    expect(swarm.addManager).toHaveBeenCalledWith("u1", "c1", { serverId: "s1", acknowledgeEvenQuorum: true });
    // the ?acknowledgeEvenQuorum=true query string is coerced to a real boolean for the service
    await ctrl.removeManager(USER, "c1", "s1", "true");
    expect(swarm.removeManager).toHaveBeenCalledWith("u1", "c1", { serverId: "s1", acknowledgeEvenQuorum: true });
    await ctrl.removeManager(USER, "c1", "s1", undefined);
    expect(swarm.removeManager).toHaveBeenCalledWith("u1", "c1", { serverId: "s1", acknowledgeEvenQuorum: false });
  });

  it("POST swarm/managers (add manager) requires the elevated 'deploy' scope", () => {
    expect(Reflect.getMetadata(REQUIRE_SCOPES, ClustersController.prototype.addManager)).toEqual(["deploy"]);
  });

  it("DELETE swarm/managers (demote) inherits the platform admin default (no scope override on the destructive demote)", () => {
    expect(Reflect.getMetadata(REQUIRE_SCOPES, ClustersController.prototype.removeManager)).toBeUndefined();
  });
});
