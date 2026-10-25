import { InstanceSettingsService } from "./instance-settings.service";
import { PrismaService } from "../prisma/prisma.service";

const ROW = {
  id: "singleton",
  initializedAt: null,
  allowRegistration: false,
  edition: "community",
  apiEnabled: true,
  apiAllowedIps: [] as string[],
};

function make(over: { findUnique?: jest.Mock; upsert?: jest.Mock; update?: jest.Mock } = {}) {
  const findUnique = over.findUnique ?? jest.fn().mockResolvedValue(ROW);
  const upsert = over.upsert ?? jest.fn().mockResolvedValue(ROW);
  const update = over.update ?? jest.fn().mockResolvedValue(ROW);
  const prisma = { instanceSettings: { findUnique, upsert, update } } as unknown as PrismaService;
  return { svc: new InstanceSettingsService(prisma), findUnique, upsert, update };
}

describe("InstanceSettingsService", () => {
  it("get() returns the existing singleton WITHOUT writing (read-only in steady state)", async () => {
    const { svc, findUnique, upsert } = make();
    const out = await svc.get();
    expect(out).toBe(ROW);
    expect(findUnique).toHaveBeenCalledWith({ where: { id: "singleton" } });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("get() creates the singleton on first access (row missing), race-safe with an empty update", async () => {
    const { svc, upsert } = make({ findUnique: jest.fn().mockResolvedValue(null) });
    const out = await svc.get();
    expect(out).toBe(ROW);
    expect(upsert).toHaveBeenCalledWith({ where: { id: "singleton" }, create: { id: "singleton" }, update: {} });
  });

  it("get() is idempotent — repeated reads never write once the row exists", async () => {
    const { svc, findUnique, upsert } = make();
    await svc.get();
    await svc.get();
    expect(findUnique).toHaveBeenCalledTimes(2);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("update() ensures the row exists then patches the singleton", async () => {
    const { svc, update } = make({ update: jest.fn().mockResolvedValue({ ...ROW, allowRegistration: true }) });
    const out = await svc.update({ allowRegistration: true });
    expect(update).toHaveBeenCalledWith({ where: { id: "singleton" }, data: { allowRegistration: true } });
    expect(out.allowRegistration).toBe(true);
  });
});

describe("InstanceSettingsService.effectiveBranding (Pro paywall at read time)", () => {
  const ORIGINAL = process.env.TUGRA_EDITION;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.TUGRA_EDITION;
    else process.env.TUGRA_EDITION = ORIGINAL;
  });

  const branded = {
    ...ROW,
    brandName: "Acme",
    brandLogoUrl: "https://acme.test/logo.svg",
    brandFaviconUrl: "https://acme.test/favicon.png",
    brandAccentColor: "#112233",
    brandHidePoweredBy: true,
  };

  it("returns the Tugra defaults on Community even when brand fields ARE set", async () => {
    delete process.env.TUGRA_EDITION; // normalises to community
    const { svc } = make({ findUnique: jest.fn().mockResolvedValue(branded) });
    expect(await svc.effectiveBranding()).toEqual({ name: null, logoUrl: null, faviconUrl: null, accentColor: null, hidePoweredBy: false });
  });

  it("returns the stored branding on Pro", async () => {
    process.env.TUGRA_EDITION = "pro";
    const { svc } = make({ findUnique: jest.fn().mockResolvedValue(branded) });
    expect(await svc.effectiveBranding()).toEqual({
      name: "Acme",
      logoUrl: "https://acme.test/logo.svg",
      faviconUrl: "https://acme.test/favicon.png",
      accentColor: "#112233",
      hidePoweredBy: true,
    });
  });
});
