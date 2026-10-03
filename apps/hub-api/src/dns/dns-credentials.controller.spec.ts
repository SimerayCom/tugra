import { DnsCredentialsController } from "./dns-credentials.controller";
import type { DnsCredentialsService } from "./dns-credentials.service";
import type { AuthUser } from "../auth/strategies/jwt.strategy";

const USER = { userId: "u1" } as AuthUser;

function make() {
  const svc = {
    list: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockResolvedValue({ id: "dc1" }),
    update: jest.fn().mockResolvedValue({ id: "dc1" }),
    test: jest.fn().mockResolvedValue({ ok: true }),
    remove: jest.fn().mockResolvedValue(undefined),
  } as unknown as DnsCredentialsService;
  return { ctrl: new DnsCredentialsController(svc), svc };
}

describe("DnsCredentialsController", () => {
  it("delegates list/create/update/test/remove to the service with the token-resolved user", async () => {
    const { ctrl, svc } = make();
    await ctrl.list(USER);
    expect(svc.list).toHaveBeenCalledWith("u1");
    await ctrl.create(USER, { teamId: "t1", name: "cf", provider: "cloudflare", apiToken: "x" } as never);
    expect(svc.create).toHaveBeenCalledWith("u1", expect.objectContaining({ provider: "cloudflare" }));
    await ctrl.update(USER, "dc1", { name: "r" } as never);
    expect(svc.update).toHaveBeenCalledWith("u1", "dc1", { name: "r" });
    await ctrl.test(USER, "dc1");
    expect(svc.test).toHaveBeenCalledWith("u1", "dc1");
    expect(await ctrl.remove(USER, "dc1")).toEqual({ ok: true });
    expect(svc.remove).toHaveBeenCalledWith("u1", "dc1");
  });
});
