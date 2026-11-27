import { BadRequestException } from "@nestjs/common";
import { ImporterService } from "./importer.service";
import { ImportSourceFactory } from "./sources/import-source.factory";
import { caproverAppsAnswer } from "./__fixtures__/caprover.fixture";

/** The real ImportSourceFactory with a fake CapRover transport: the service's connect/test/plan run end to end over the adapter. */
function make(over: { login?: jest.Mock; get?: jest.Mock } = {}) {
  const login = over.login ?? jest.fn(async () => "LOGIN_TOKEN");
  const get = over.get ?? jest.fn(async () => caproverAppsAnswer());
  const caprover = { login, create: jest.fn(() => ({ get })) };
  const sources = new ImportSourceFactory({ create: jest.fn() } as never, { create: jest.fn() } as never, undefined, undefined, caprover as never);
  const importSession = {
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "sess-1", ...data })),
    findUnique: jest.fn(),
    update: jest.fn().mockResolvedValue({}),
    deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
  };
  const crypto = { encrypt: jest.fn((s: string) => `enc(${s})`), decrypt: jest.fn((s: string) => s.replace(/^enc\(|\)$/g, "")) };
  const audit = { log: jest.fn() };
  const access = { requirePermission: jest.fn().mockResolvedValue(undefined) };
  const svc = new ImporterService({} as never, { importSession } as never, crypto as never, access as never, audit as never, sources);
  return { svc, caprover, login, get, importSession, crypto, audit };
}

const input = { sourceKind: "caprover" as const, teamId: "t1", baseUrl: "https://captain.example.com", token: "dash-pw" };

describe("ImporterService.connect: caprover", () => {
  it("exchanges the password for a login token and stores ONLY the token (encrypted)", async () => {
    const { svc, login, caprover, importSession, crypto, audit } = make();
    const res = await svc.connect("u1", input);
    expect(login).toHaveBeenCalledWith("https://captain.example.com", "dash-pw");
    expect(caprover.create).toHaveBeenCalledWith("https://captain.example.com", "LOGIN_TOKEN");
    expect(crypto.encrypt).toHaveBeenCalledTimes(1);
    expect(crypto.encrypt).toHaveBeenCalledWith("LOGIN_TOKEN");
    const stored = importSession.create.mock.calls[0][0].data;
    expect(stored).toMatchObject({ sourceKind: "caprover", tokenEnc: "enc(LOGIN_TOKEN)" });
    expect(JSON.stringify([stored, audit.log.mock.calls])).not.toContain("dash-pw");
    expect(res.sessionId).toBe("sess-1");
  });

  it("a wrong password is a 400 with the stable unauthorized code; no session is stored and no read is made", async () => {
    const login = jest.fn().mockRejectedValue(new Error("CapRover API error 401 (check the dashboard password; connect again if the login has expired)"));
    const { svc, importSession, get } = make({ login });
    const err = await svc.connect("u1", input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getResponse()).toMatchObject({ code: "unauthorized", message: expect.stringContaining("could not reach CapRover") });
    expect(JSON.stringify((err as BadRequestException).getResponse())).not.toContain("dash-pw");
    expect(importSession.create).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it("a good login on a URL that is not CapRover is refused at verify", async () => {
    const { svc, importSession } = make({ get: jest.fn().mockResolvedValue({ nothing: true }) });
    await expect(svc.connect("u1", input)).rejects.toBeInstanceOf(BadRequestException);
    expect(importSession.create).not.toHaveBeenCalled();
  });
});

describe("ImporterService.test: caprover", () => {
  it("answers with counts and stores nothing", async () => {
    const { svc, importSession } = make();
    const { token, teamId, ...rest } = input;
    await expect(svc.test("u1", { ...rest, teamId, token })).resolves.toEqual({ ok: true, apps: 5, databases: 2, services: 0, sensitive: null });
    expect(importSession.create).not.toHaveBeenCalled();
  });

  it("a wrong password is a normal refusal with a code, not an exception", async () => {
    const { svc } = make({ login: jest.fn().mockRejectedValue(new Error("CapRover API error 401 (check the dashboard password)")) });
    await expect(svc.test("u1", input)).resolves.toMatchObject({ ok: false, code: "unauthorized" });
  });
});

describe("ImporterService.plan: caprover", () => {
  it("plans the fleet from the stored login token", async () => {
    const { svc, importSession, caprover } = make();
    importSession.findUnique.mockResolvedValue({ id: "sess-1", teamId: "t1", actorId: "u1", sourceKind: "caprover", baseUrl: input.baseUrl, tokenEnc: "enc(LOGIN_TOKEN)", scopeKey: null, transport: "token", status: "active", expiresAt: new Date(Date.now() + 60_000) });
    const plan = await svc.plan("u1", { sourceKind: "caprover", sessionId: "sess-1" });
    expect(caprover.create).toHaveBeenCalledWith(input.baseUrl, "LOGIN_TOKEN");
    expect(plan.sourceKind).toBe("caprover");
    expect(plan.totals).toMatchObject({ apps: 4, databases: 2 });
    expect(plan.items.filter((i) => i.kind !== "volume").map((i) => i.name).sort()).toEqual(["api", "blog", "cache", "db", "pg-pool", "uploader"]);
    expect(plan.items.find((i) => i.name === "api")?.dependsOn).toEqual(expect.arrayContaining([expect.stringContaining("database:"), expect.stringContaining(":db")]));
  });
});
