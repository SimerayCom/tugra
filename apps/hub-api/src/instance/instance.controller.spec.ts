import { InstanceController } from "./instance.controller";
import type { InstanceSettingsService } from "./instance-settings.service";

function controllerWith(settings: Record<string, unknown>): InstanceController {
  return new InstanceController({ get: jest.fn().mockResolvedValue(settings) } as unknown as InstanceSettingsService);
}

describe("InstanceController", () => {
  it("reports initialized=false before the first user is claimed", async () => {
    const res = await controllerWith({ initializedAt: null, allowRegistration: false, edition: "community" }).status();
    expect(res).toEqual({ initialized: false, allowRegistration: false, edition: "community" });
  });

  it("reports initialized=true once initializedAt is set, passing allowRegistration + edition through", async () => {
    const res = await controllerWith({ initializedAt: new Date(), allowRegistration: true, edition: "pro" }).status();
    expect(res).toEqual({ initialized: true, allowRegistration: true, edition: "pro" });
  });

  it("does not leak any other settings fields (only the public triple)", async () => {
    const res = await controllerWith({
      initializedAt: new Date(),
      allowRegistration: false,
      edition: "community",
      acmeEmail: "secret@x.io",
      apiAllowedIps: ["10.0.0.1"],
      publicUrl: "https://internal",
    }).status();
    expect(Object.keys(res).sort()).toEqual(["allowRegistration", "edition", "initialized"]);
  });
});
