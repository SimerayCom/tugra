import { Logger } from "@nestjs/common";
import { RunWorld, SERVER, defaultPlan } from "./testing/run-world";
import { checkSwapPlacement } from "./swap-placement";

jest.setTimeout(30_000);
beforeAll(() => {
  jest.spyOn(Logger.prototype, "warn").mockImplementation();
  jest.spyOn(Logger.prototype, "error").mockImplementation();
  jest.spyOn(Logger.prototype, "log").mockImplementation();
});

describe("checkSwapPlacement (pure)", () => {
  it("passes when every source server's target is the Tugra server that is that machine", () => {
    expect(checkSwapPlacement([{ ref: "a", controlPlane: false, tugraServerId: "t1" }], "t1", {})).toEqual({ ok: true });
  });
  it("a server map entry wins over the run's default target", () => {
    expect(checkSwapPlacement([{ ref: "a", controlPlane: false, tugraServerId: "t2" }], "t1", { a: "t2" })).toEqual({ ok: true });
  });
  it("refuses a target that is not the source's machine", () => {
    expect(checkSwapPlacement([{ ref: "a", controlPlane: false, tugraServerId: "t2" }], "t1", {})).toEqual({ ok: false, code: "swap-target-not-source-host", ref: "a" });
  });
  it("refuses when no Tugra server is known to be that machine (never a guess)", () => {
    expect(checkSwapPlacement([{ ref: "a", controlPlane: false, tugraServerId: null }], "t1", {})).toEqual({ ok: false, code: "swap-target-not-source-host", ref: "a" });
  });
  it("the control plane box is refused first, whatever its target", () => {
    const hosts = [
      { ref: "a", controlPlane: false, tugraServerId: null },
      { ref: "cp", controlPlane: true, tugraServerId: "t1" },
    ];
    expect(checkSwapPlacement(hosts, "t1", {})).toEqual({ ok: false, code: "swap-control-plane", ref: "cp" });
  });
  it("no source host with anything in scope passes (the scope step answers an empty scope)", () => {
    expect(checkSwapPlacement([], "t1", {})).toEqual({ ok: true });
  });
});

describe("a swap-proxy run at create", () => {
  const swap = (w: RunWorld, over = {}) => w.create({ topology: "swap-proxy", mode: "takeover", ...over });

  it("is created when the target is the source's machine", async () => {
    const w = new RunWorld();
    w.port.sourceHosts = async () => [{ ref: "srvA", controlPlane: false, tugraServerId: SERVER }];
    await expect(swap(w)).resolves.toEqual(expect.any(String));
  });
  it("is refused with swap-target-not-source-host when the target is another machine, and nothing is created", async () => {
    const w = new RunWorld();
    w.port.sourceHosts = async () => [{ ref: "srvA", controlPlane: false, tugraServerId: "some-other-server" }];
    await expect(swap(w)).rejects.toMatchObject({ response: { code: "swap-target-not-source-host", sourceServer: "srvA" } });
    expect(w.store.runs.size).toBe(0);
  });
  it("is refused with swap-control-plane for the control plane box", async () => {
    const w = new RunWorld();
    w.port.sourceHosts = async () => [{ ref: "cp", controlPlane: true, tugraServerId: SERVER }];
    await expect(swap(w)).rejects.toMatchObject({ response: { code: "swap-control-plane", sourceServer: "cp" } });
    expect(w.store.runs.size).toBe(0);
  });
  it("is refused when the source cannot be read (fail closed)", async () => {
    const w = new RunWorld();
    w.port.sourceHosts = async () => {
      throw new Error("source unreachable");
    };
    await expect(swap(w)).rejects.toMatchObject({ response: { code: "swap-placement-unreadable" } });
  });
  it("passes the run's scope to the port so only the servers in scope are judged", async () => {
    const w = new RunWorld();
    w.port.plan_ = defaultPlan({
      items: [{ itemRef: "app:srvA:web", kind: "app", name: "web", proposed: {}, risks: [], dependsOn: [] }],
      preflight: { databases: [], services: [], appsWithVolumeData: 0, hosts: [{ ref: "srvA" }] },
    });
    const seen: unknown[] = [];
    w.port.sourceHosts = async (_u, i) => {
      seen.push(i.scope);
      return [{ ref: "srvA", controlPlane: false, tugraServerId: SERVER }];
    };
    await swap(w, { scope: { sourceServers: ["srvA"] }, serverMap: { srvA: SERVER } });
    expect(seen).toEqual([{ sourceServers: ["srvA"] }]);
  });
  it("a two-box run is not judged by the swap checks", async () => {
    const w = new RunWorld();
    const sourceHosts = jest.fn(async () => [{ ref: "cp", controlPlane: true, tugraServerId: null }]);
    w.port.sourceHosts = sourceHosts;
    await expect(w.create({ topology: "two-box" })).resolves.toEqual(expect.any(String));
    expect(sourceHosts).not.toHaveBeenCalled();
  });
  it("a port that cannot tell skips the checks (CUTOVER's identity check stays the guard)", async () => {
    const w = new RunWorld();
    await expect(swap(w)).resolves.toEqual(expect.any(String));
  });
});
