import { InstanceSettingsController } from "./instance-settings.controller";
import type { InstanceSettingsService } from "./instance-settings.service";
import type { AuditService } from "../audit/audit.service";
import type { AuthUser } from "../auth/strategies/jwt.strategy";
import type { UpdateService } from "../update/update.service";

const OWNER = { userId: "owner1", scopes: ["*"] } as AuthUser;

function make(current: { apiEnabled: boolean; apiAllowedIps: string[]; publicUrl?: string | null; acmeEmail?: string | null }) {
  const full = { publicUrl: null, acmeEmail: null, ...current };
  const updated = { ...full };
  const settings = {
    get: jest.fn().mockResolvedValue(full),
    update: jest.fn().mockImplementation((patch) => Promise.resolve(Object.assign(updated, patch))),
  } as unknown as InstanceSettingsService;
  const audit = { log: jest.fn() } as unknown as AuditService;
  const update = {
    getStatus: jest.fn().mockResolvedValue({
      current: "0.0.0-dev",
      latest: null,
      channel: "stable",
      updateAvailable: false,
      changelogUrl: null,
      autoUpdate: false,
    }),
    checkRemote: jest.fn().mockResolvedValue({ status: "unconfigured" }),
  } as unknown as UpdateService;
  return { ctrl: new InstanceSettingsController(settings, audit, update), settings, audit, update };
}

const ORIGINAL_EDITION = process.env.TUGRA_EDITION;
afterEach(() => {
  if (ORIGINAL_EDITION === undefined) delete process.env.TUGRA_EDITION;
  else process.env.TUGRA_EDITION = ORIGINAL_EDITION;
});

describe("InstanceSettingsController", () => {
  it("returns the API-gating fields, onboarding basics, plus the read-only env edition", async () => {
    process.env.TUGRA_EDITION = "pro";
    const { ctrl } = make({ apiEnabled: true, apiAllowedIps: ["10.0.0.0/8"], publicUrl: "https://hub.example.com", acmeEmail: "a@b.co" });
    expect(await ctrl.getSettings()).toEqual({
      apiEnabled: true,
      apiAllowedIps: ["10.0.0.0/8"],
      publicUrl: "https://hub.example.com",
      acmeEmail: "a@b.co",
      edition: "pro",
    });
  });

  it("patches apiEnabled + apiAllowedIps (dropping blanks) and audits", async () => {
    const { ctrl, settings, audit } = make({ apiEnabled: true, apiAllowedIps: [] });
    const res = await ctrl.updateSettings(OWNER, { apiEnabled: false, apiAllowedIps: ["1.2.3.4", "", "  ", "10.0.0.0/8"] });
    expect(settings.update).toHaveBeenCalledWith({ apiEnabled: false, apiAllowedIps: ["1.2.3.4", "10.0.0.0/8"] });
    expect(res).toEqual({ apiEnabled: false, apiAllowedIps: ["1.2.3.4", "10.0.0.0/8"], publicUrl: null, acmeEmail: null });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "instance_settings.update", actor: "owner1" }));
  });

  it("only patches the fields present in the body", async () => {
    const { ctrl, settings } = make({ apiEnabled: true, apiAllowedIps: [] });
    await ctrl.updateSettings(OWNER, { apiEnabled: false });
    expect(settings.update).toHaveBeenCalledWith({ apiEnabled: false });
  });

  it("sets publicUrl + acmeEmail (onboarding basics)", async () => {
    const { ctrl, settings } = make({ apiEnabled: true, apiAllowedIps: [] });
    const res = await ctrl.updateSettings(OWNER, { publicUrl: "https://hub.example.com", acmeEmail: "ops@example.com" });
    expect(settings.update).toHaveBeenCalledWith({ publicUrl: "https://hub.example.com", acmeEmail: "ops@example.com" });
    expect(res).toMatchObject({ publicUrl: "https://hub.example.com", acmeEmail: "ops@example.com" });
  });

  it("clears publicUrl + acmeEmail when the owner submits empty strings (falsy → null)", async () => {
    const { ctrl, settings } = make({ apiEnabled: true, apiAllowedIps: [], publicUrl: "https://old", acmeEmail: "old@x.co" });
    await ctrl.updateSettings(OWNER, { publicUrl: "", acmeEmail: "" });
    expect(settings.update).toHaveBeenCalledWith({ publicUrl: null, acmeEmail: null });
  });

  it("getUpdate delegates to UpdateService.getStatus", async () => {
    const { ctrl, update } = make({ apiEnabled: true, apiAllowedIps: [] });
    const out = await ctrl.getUpdate();
    expect(update.getStatus).toHaveBeenCalled();
    expect(out).toMatchObject({ current: "0.0.0-dev", updateAvailable: false, latest: null });
  });

  it("setUpdate persists channel + autoUpdate, audits, and returns the status (no remote fetch)", async () => {
    const { ctrl, settings, audit, update } = make({ apiEnabled: true, apiAllowedIps: [] });
    const out = await ctrl.setUpdate(OWNER, { autoUpdate: true, updateChannel: "beta" });
    expect(settings.update).toHaveBeenCalledWith({ autoUpdate: true, updateChannel: "beta" });
    expect(update.checkRemote).not.toHaveBeenCalled(); // PATCH is fast — never fetches
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "instance_update.settings", actor: "owner1" }));
    expect(out).toMatchObject({ channel: "stable" }); // getStatus() shape
  });

  it("setUpdate only patches the fields present in the body", async () => {
    const { ctrl, settings } = make({ apiEnabled: true, apiAllowedIps: [] });
    await ctrl.setUpdate(OWNER, { autoUpdate: false });
    expect(settings.update).toHaveBeenCalledWith({ autoUpdate: false });
  });

  it("checkUpdate triggers a remote re-check then returns the fresh status", async () => {
    const { ctrl, update } = make({ apiEnabled: true, apiAllowedIps: [] });
    const out = await ctrl.checkUpdate();
    expect(update.checkRemote).toHaveBeenCalled();
    expect(update.getStatus).toHaveBeenCalled();
    expect(out).toMatchObject({ current: "0.0.0-dev" });
  });
});
