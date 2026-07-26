import { ClustersController } from "./clusters.controller";
import type { ClustersService } from "./clusters.service";
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
  return { ctrl: new ClustersController(svc), svc };
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
});
