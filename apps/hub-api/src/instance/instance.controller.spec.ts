import { InstanceController } from "./instance.controller";
import type { InstanceSettingsService } from "./instance-settings.service";

function controllerWith(settings: Record<string, unknown>): InstanceController {
  return new InstanceController({ get: jest.fn().mockResolvedValue(settings) } as unknown as InstanceSettingsService);
}

// `edition` is env-authoritative (currentEdition() reads TUGRA_EDITION), NOT the DB column.
const ORIGINAL = process.env.TUGRA_EDITION;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.TUGRA_EDITION;
  else process.env.TUGRA_EDITION = ORIGINAL;
});

describe("InstanceController", () => {
  it("reports initialized=false and the env edition before the first user is claimed", async () => {
    delete process.env.TUGRA_EDITION; // → community
    const res = await controllerWith({ initializedAt: null, allowRegistration: false }).status();
    expect(res).toEqual({ initialized: false, allowRegistration: false, edition: "community" });
  });

  it("reports initialized=true and the env edition (ignoring the inert DB column)", async () => {
    process.env.TUGRA_EDITION = "pro";
    // Even if the DB row said community, the env is authoritative:
    const res = await controllerWith({ initializedAt: new Date(), allowRegistration: true, edition: "community" }).status();
    expect(res).toEqual({ initialized: true, allowRegistration: true, edition: "pro" });
  });

  it("does not leak any other settings fields (only the public triple)", async () => {
    const res = await controllerWith({
      initializedAt: new Date(),
      allowRegistration: false,
      acmeEmail: "secret@x.io",
      apiAllowedIps: ["10.0.0.1"],
      publicUrl: "https://internal",
    }).status();
    expect(Object.keys(res).sort()).toEqual(["allowRegistration", "edition", "initialized"]);
  });
});
