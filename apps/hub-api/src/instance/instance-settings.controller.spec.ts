import { InstanceSettingsController } from "./instance-settings.controller";
import type { InstanceSettingsService } from "./instance-settings.service";
import type { AuditService } from "../audit/audit.service";
import type { AuthUser } from "../auth/strategies/jwt.strategy";

const OWNER = { userId: "owner1", scopes: ["*"] } as AuthUser;

function make(current: { apiEnabled: boolean; apiAllowedIps: string[] }) {
  const updated: { apiEnabled: boolean; apiAllowedIps: string[] } = { ...current };
  const settings = {
    get: jest.fn().mockResolvedValue(current),
    update: jest.fn().mockImplementation((patch) => Promise.resolve(Object.assign(updated, patch))),
  } as unknown as InstanceSettingsService;
  const audit = { log: jest.fn() } as unknown as AuditService;
  return { ctrl: new InstanceSettingsController(settings, audit), settings, audit };
}

const ORIGINAL_EDITION = process.env.TUGRA_EDITION;
afterEach(() => {
  if (ORIGINAL_EDITION === undefined) delete process.env.TUGRA_EDITION;
  else process.env.TUGRA_EDITION = ORIGINAL_EDITION;
});

describe("InstanceSettingsController", () => {
  it("returns the API-gating fields plus the read-only env edition", async () => {
    process.env.TUGRA_EDITION = "pro";
    const { ctrl } = make({ apiEnabled: true, apiAllowedIps: ["10.0.0.0/8"] });
    expect(await ctrl.getSettings()).toEqual({ apiEnabled: true, apiAllowedIps: ["10.0.0.0/8"], edition: "pro" });
  });

  it("patches apiEnabled + apiAllowedIps (dropping blanks) and audits", async () => {
    const { ctrl, settings, audit } = make({ apiEnabled: true, apiAllowedIps: [] });
    const res = await ctrl.updateSettings(OWNER, { apiEnabled: false, apiAllowedIps: ["1.2.3.4", "", "  ", "10.0.0.0/8"] });
    expect(settings.update).toHaveBeenCalledWith({ apiEnabled: false, apiAllowedIps: ["1.2.3.4", "10.0.0.0/8"] });
    expect(res).toEqual({ apiEnabled: false, apiAllowedIps: ["1.2.3.4", "10.0.0.0/8"] });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "instance_settings.update", actor: "owner1" }));
  });

  it("only patches the fields present in the body", async () => {
    const { ctrl, settings } = make({ apiEnabled: true, apiAllowedIps: [] });
    await ctrl.updateSettings(OWNER, { apiEnabled: false });
    expect(settings.update).toHaveBeenCalledWith({ apiEnabled: false });
  });
});
