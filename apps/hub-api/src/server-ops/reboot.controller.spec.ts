import { ServerOpsController } from "./server-ops.controller";
import { REQUIRE_SCOPES } from "../api-tokens/require-scopes.decorator";
import { methodDefaultScope } from "../api-tokens/scopes";

const reboot = { status: jest.fn().mockResolvedValue({ active: null, last: null }), preview: jest.fn().mockResolvedValue({}), request: jest.fn().mockResolvedValue({ id: "rb1" }), cancel: jest.fn().mockResolvedValue({ id: "rb1" }) };
const make = () => new ServerOpsController({} as never, {} as never, {} as never, reboot as never, {} as never, {} as never, {} as never, {} as never);
const user = { userId: "u1" } as never;

const scopesOf = (fn: unknown) => Reflect.getMetadata(REQUIRE_SCOPES, fn as object) as string[] | undefined;

describe("reboot routes", () => {
  it("are gated like patching: the mutating calls need the deploy scope (DELETE too, not the admin default); reads need none", () => {
    const proto = ServerOpsController.prototype;
    expect(scopesOf(proto.requestReboot)).toEqual(["deploy"]);
    expect(scopesOf(proto.cancelReboot)).toEqual(["deploy"]);
    expect(scopesOf(proto.rebootStatus)).toBeUndefined();
    expect(scopesOf(proto.rebootPreview)).toBeUndefined();
    // the same scope the update-apply route needs
    expect(scopesOf(proto.upgradeAll)).toEqual(["deploy"]);
    expect(methodDefaultScope("GET")).toBe("read");
  });

  it("delegate to the service with the caller and the server id", async () => {
    const c = make();
    await c.rebootStatus(user, "s1");
    await c.rebootPreview(user, "s1");
    await c.requestReboot(user, "s1", { mode: "now", confirmName: "prod-1" });
    await c.cancelReboot(user, "s1");
    expect(reboot.status).toHaveBeenCalledWith("u1", "s1");
    expect(reboot.preview).toHaveBeenCalledWith("u1", "s1");
    expect(reboot.request).toHaveBeenCalledWith("u1", "s1", { mode: "now", confirmName: "prod-1" });
    expect(reboot.cancel).toHaveBeenCalledWith("u1", "s1");
  });
});
