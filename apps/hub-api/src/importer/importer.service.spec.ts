import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { ImporterService } from "./importer.service";
import type { AdoptableContainer } from "../migrator/migrator.service";

const localContainer: AdoptableContainer = {
  id: "c1",
  name: "web",
  image: "nginx:1",
  state: "running",
  ports: [{ host: 80, container: 80, protocol: "tcp" }],
  env: [{ key: "K", value: "SECRETVAL" }],
  mounts: [],
  restartPolicy: "always",
  isTugra: false,
  composeProject: null,
  adoptable: true,
};

/** A fake Coolify client whose GETs resolve from a route map (missing → throws, like a 404). */
const coolifyRoutes: Record<string, unknown> = {
  "/servers": [{ uuid: "srv-a", name: "box" }],
  "/servers/srv-a/resources": [{ uuid: "app-1" }],
  "/applications": [{ uuid: "app-1", name: "web", build_pack: "nixpacks", git_repository: "o/r" }],
  "/databases": [],
};
const makeFakeClient = () => ({
  get: jest.fn(async (p: string) => {
    if (p in coolifyRoutes) return coolifyRoutes[p];
    throw new Error(`404 ${p}`);
  }),
});

function make(over: { session?: unknown; clientGet?: jest.Mock } = {}) {
  const migrator = { discover: jest.fn().mockResolvedValue({ containers: [localContainer] }) };
  const importSession = {
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "sess-1", ...data })),
    findUnique: jest.fn().mockResolvedValue(over.session ?? null),
    update: jest.fn().mockResolvedValue({}),
    deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
  };
  const prisma = { importSession } as never;
  const crypto = { encrypt: jest.fn((s: string) => `enc(${s})`), decrypt: jest.fn((s: string) => s.replace(/^enc\(|\)$/g, "")) };
  const access = { requirePermission: jest.fn().mockResolvedValue(undefined) };
  const audit = { log: jest.fn() };
  const client = over.clientGet ? { get: over.clientGet } : makeFakeClient();
  const coolify = { create: jest.fn(() => client) };
  const svc = new ImporterService(migrator as never, prisma, crypto as never, access as never, audit as never, coolify as never);
  return { svc, migrator, importSession, crypto, access, audit, coolify, client };
}

describe("ImporterService.plan — local-docker", () => {
  it("discovers via local-docker and returns a secret-free plan", async () => {
    const { svc, migrator } = make();
    const plan = await svc.plan("u1", { sourceKind: "local-docker", serverId: "srv1" });
    expect(migrator.discover).toHaveBeenCalledWith("u1", "srv1");
    expect(plan.totals.apps).toBe(1);
    expect(JSON.stringify(plan)).not.toContain("SECRETVAL");
  });
});

describe("ImporterService.connect — coolify", () => {
  it("verifies, stores an ENCRYPTED session, audits without the token, returns the id", async () => {
    const { svc, importSession, crypto, access, audit } = make();
    const res = await svc.connect("u1", { sourceKind: "coolify", teamId: "t1", baseUrl: "https://coolify.example.com", token: "COOLIFY_TOKEN" });
    expect(access.requirePermission).toHaveBeenCalledWith("u1", "t1", "apps:config");
    expect(crypto.encrypt).toHaveBeenCalledWith("COOLIFY_TOKEN");
    const stored = importSession.create.mock.calls[0][0].data;
    expect(stored.tokenEnc).toBe("enc(COOLIFY_TOKEN)"); // the stored value is the crypto output, not the raw token
    expect(stored.baseUrl).toBe("https://coolify.example.com");
    expect(res.sessionId).toBe("sess-1");
    expect(JSON.stringify((audit.log as jest.Mock).mock.calls)).not.toContain("COOLIFY_TOKEN");
  });

  it("rejects when the instance is unreachable / token invalid (no session stored)", async () => {
    const { svc, importSession } = make({ clientGet: jest.fn().mockRejectedValue(new Error("401")) });
    await expect(
      svc.connect("u1", { sourceKind: "coolify", teamId: "t1", baseUrl: "https://coolify.example.com", token: "bad" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(importSession.create).not.toHaveBeenCalled();
  });

  it("rejects a non-http(s) / credential-bearing / loopback-literal base URL as a 400", async () => {
    const { svc } = make();
    for (const baseUrl of ["file:///etc/passwd", "https://user:pass@c.example.com", "http://169.254.169.254/", "http://127.0.0.1:5432/"]) {
      await expect(svc.connect("u1", { sourceKind: "coolify", teamId: "t1", baseUrl, token: "x" })).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it("forbids a caller without apps:config before any network call", async () => {
    const { svc, coolify } = make();
    (svc as unknown as { access: { requirePermission: jest.Mock } }).access.requirePermission.mockRejectedValue(new ForbiddenException("no"));
    await expect(svc.connect("u1", { sourceKind: "coolify", teamId: "t1", baseUrl: "https://c.example.com", token: "x" })).rejects.toBeInstanceOf(ForbiddenException);
    expect(coolify.create).not.toHaveBeenCalled();
  });
});

describe("ImporterService.plan — coolify session", () => {
  const liveSession = { id: "sess-1", sourceKind: "coolify", actorId: "u1", teamId: "t1", baseUrl: "https://c.example.com", tokenEnc: "enc(TOK)", status: "active", expiresAt: new Date(Date.now() + 60_000) };

  it("resolves the owned session, decrypts the token, discovers, and plans", async () => {
    const { svc, crypto, coolify, importSession } = make({ session: liveSession });
    const plan = await svc.plan("u1", { sourceKind: "coolify", sessionId: "sess-1" });
    expect(crypto.decrypt).toHaveBeenCalledWith("enc(TOK)");
    expect(coolify.create).toHaveBeenCalledWith("https://c.example.com", "TOK");
    expect(plan.sourceKind).toBe("coolify");
    expect(plan.items.some((i) => i.itemRef === "app:srv-a:app-1")).toBe(true);
    expect(importSession.update).toHaveBeenCalled(); // lastUsedAt bumped
  });

  it("404s an unknown session, forbids another user's, rejects an expired one", async () => {
    await expect(make({ session: null }).svc.plan("u1", { sourceKind: "coolify", sessionId: "x" })).rejects.toBeInstanceOf(NotFoundException);
    await expect(make({ session: { ...liveSession, actorId: "u2" } }).svc.plan("u1", { sourceKind: "coolify", sessionId: "sess-1" })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      make({ session: { ...liveSession, expiresAt: new Date(Date.now() - 1000) } }).svc.plan("u1", { sourceKind: "coolify", sessionId: "sess-1" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
