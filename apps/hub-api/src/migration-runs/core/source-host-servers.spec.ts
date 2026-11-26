import { Logger } from "@nestjs/common";
import { RunWorld, SERVER, TEAM, defaultPlan } from "./testing/run-world";

jest.setTimeout(30_000);
beforeAll(() => {
  jest.spyOn(Logger.prototype, "warn").mockImplementation();
  jest.spyOn(Logger.prototype, "error").mockImplementation();
  jest.spyOn(Logger.prototype, "log").mockImplementation();
});

const SRC = "srv-source-host";
const twoServers = () => {
  const w = new RunWorld();
  w.env.serversById.set(SRC, { id: SRC, name: "source-box", teamId: TEAM });
  w.port.plan_ = defaultPlan({
    items: [{ itemRef: "app:srvA:web", kind: "app", name: "web", proposed: {}, risks: [], dependsOn: [] }],
    preflight: { databases: [], services: [], appsWithVolumeData: 0, hosts: [{ ref: "srvA" }] },
  });
  return w;
};
const create = (w: RunWorld, over: Record<string, unknown> = {}) => w.create({ topology: "two-box", options: { sourceRunner: "agent" }, scope: { sourceServers: ["srvA"] }, serverMap: { srvA: SERVER }, ...over } as never);
const optionsOf = (w: RunWorld, id: string) => w.store.row(id).options as Record<string, unknown>;

describe("sourceHostServers is derived by the hub at create", () => {
  it("records the Tugra server the plan matched to each source server for the agent runner on a two-box run", async () => {
    const w = twoServers();
    w.port.sourceHosts = async () => [{ ref: "srvA", controlPlane: false, tugraServerId: SRC }];
    expect(optionsOf(w, await create(w)).sourceHostServers).toEqual({ srvA: SRC });
  });
  it("discards a value the caller sends", async () => {
    const w = twoServers();
    w.port.sourceHosts = async () => [{ ref: "srvA", controlPlane: false, tugraServerId: SRC }];
    const id = await create(w, { options: { sourceRunner: "agent", sourceHostServers: { srvA: "attacker-chosen-server" } } });
    expect(optionsOf(w, id).sourceHostServers).toEqual({ srvA: SRC });
  });
  it("a caller's value is dropped even when the hub cannot derive one", async () => {
    const w = twoServers();
    w.port.sourceHosts = async () => [{ ref: "srvA", controlPlane: false, tugraServerId: null }];
    const id = await create(w, { options: { sourceRunner: "agent", sourceHostServers: { srvA: "attacker-chosen-server" } } });
    expect(optionsOf(w, id).sourceHostServers).toBeUndefined();
  });
  it("stays absent when a source server has no matching Tugra server", async () => {
    const w = twoServers();
    w.port.sourceHosts = async () => [{ ref: "srvA", controlPlane: false, tugraServerId: null }];
    expect(optionsOf(w, await create(w)).sourceHostServers).toBeUndefined();
  });
  it("stays absent when the matched server belongs to another team the actor has no standing in", async () => {
    const w = twoServers();
    w.env.serversById.set(SRC, { id: SRC, name: "source-box", teamId: "other-team" });
    w.port.sourceHosts = async () => [{ ref: "srvA", controlPlane: false, tugraServerId: SRC }];
    expect(optionsOf(w, await create(w)).sourceHostServers).toBeUndefined();
  });
  it("is recorded when the matched server sits in another team the actor may run migrations in (the Coolify host is often in a different team than the target)", async () => {
    const w = twoServers();
    w.env.serversById.set(SRC, { id: SRC, name: "source-box", teamId: "other-team" });
    w.env.perms["u1|other-team"] = { member: true, appsConfig: true, databases: true };
    w.port.sourceHosts = async () => [{ ref: "srvA", controlPlane: false, tugraServerId: SRC }];
    expect(optionsOf(w, await create(w)).sourceHostServers).toEqual({ srvA: SRC });
    const w2 = twoServers();
    w2.env.serversById.set(SRC, { id: SRC, name: "source-box", teamId: "other-team" });
    w2.env.perms["u1|other-team"] = { member: true, appsConfig: true, databases: false };
    w2.port.sourceHosts = async () => [{ ref: "srvA", controlPlane: false, tugraServerId: SRC }];
    expect(optionsOf(w2, await create(w2)).sourceHostServers).toBeUndefined();
  });
  it("stays absent when the source cannot be read (the run is still created; the data steps then say there is no source host)", async () => {
    const w = twoServers();
    w.port.sourceHosts = async () => {
      throw new Error("down");
    };
    expect(optionsOf(w, await create(w)).sourceHostServers).toBeUndefined();
  });
  it("is not set for other runners or for a swap (a swap runs on its own target)", async () => {
    const w = twoServers();
    const spy = jest.fn(async () => [{ ref: "srvA", controlPlane: false, tugraServerId: SRC }]);
    w.port.sourceHosts = spy;
    expect(optionsOf(w, await create(w, { options: { sourceRunner: "operator" } })).sourceHostServers).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
    const w2 = twoServers();
    w2.port.sourceHosts = async () => [{ ref: "srvA", controlPlane: false, tugraServerId: SERVER }];
    expect(optionsOf(w2, await create(w2, { topology: "swap-proxy", mode: "takeover" })).sourceHostServers).toBeUndefined();
  });
});
