import { generateKeyPairSync } from "node:crypto";
import { Role } from "@prisma/client";
import { GitSourcesService } from "./git-sources.service";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";
import { CryptoService } from "../crypto/crypto.service";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ format: "pem", type: "pkcs8" }).toString();

const audit = { log: jest.fn() } as unknown as AuditService;
const crypto = {
  encrypt: (s: string) => `enc(${s})`,
  decrypt: (s: string) => s.replace(/^enc\(/, "").replace(/\)$/, ""),
} as unknown as CryptoService;

function make(prisma: Partial<PrismaService>, access: Partial<TeamAccessService>) {
  return new GitSourcesService(prisma as PrismaService, access as TeamAccessService, audit, crypto);
}

describe("GitSourcesService", () => {
  it("encrypts secrets on create and never returns them", async () => {
    const create = jest.fn().mockResolvedValue({
      id: "s1", name: "gh", teamId: "t1", provider: "github", appId: "123",
      appSlug: null, installationId: "9", htmlUrl: null, createdAt: new Date(),
    });
    const svc = make({ gitSource: { create } } as unknown as PrismaService, { requireRole: jest.fn().mockResolvedValue(undefined) });
    const v = await svc.create("u1", { name: "gh", teamId: "t1", appId: "123", privateKey: PEM, installationId: "9", webhookSecret: "wh" });
    const data = create.mock.calls[0][0].data;
    expect(data.privateKeyEnc).toBe(`enc(${PEM})`);
    expect(data.webhookSecretEnc).toBe("enc(wh)");
    expect(v).not.toHaveProperty("privateKeyEnc");
    expect(v).not.toHaveProperty("webhookSecretEnc");
  });

  it("appJwt produces an RS256 token issued by the app id", () => {
    const svc = make({} as PrismaService, {});
    const jwt = svc.appJwt("12345", PEM);
    const [h, p] = jwt.split(".");
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toMatchObject({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(p, "base64url").toString())).toMatchObject({ iss: "12345" });
    expect(jwt.split(".")).toHaveLength(3);
  });

  it("fetches and caches the installation token", async () => {
    const findUnique = jest.fn().mockResolvedValue({ id: "s1", appId: "123", installationId: "9", privateKeyEnc: `enc(${PEM})` });
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ token: "ghs_abc", expires_at: new Date(Date.now() + 3600_000).toISOString() }),
    });
    (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
    const svc = make({ gitSource: { findUnique } } as unknown as PrismaService, {});
    expect(await svc.installationToken("s1")).toBe("ghs_abc");
    expect(await svc.installationToken("s1")).toBe("ghs_abc"); // cached
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain("/app/installations/9/access_tokens");
  });

  it("lists installation repositories", async () => {
    const findUnique = jest.fn().mockResolvedValue({ id: "s2", appId: "123", installationId: "9", privateKeyEnc: `enc(${PEM})`, teamId: "t1" });
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ token: "ghs_x", expires_at: new Date(Date.now() + 3600_000).toISOString() }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ repositories: [{ full_name: "acme/web", clone_url: "https://github.com/acme/web.git", private: true }] }) });
    (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
    const svc = make(
      { gitSource: { findUnique } } as unknown as PrismaService,
      { teamRole: jest.fn().mockResolvedValue(Role.OWNER) },
    );
    const repos = await svc.listRepos("u1", "s2");
    expect(repos).toEqual([{ fullName: "acme/web", cloneUrl: "https://github.com/acme/web.git", private: true }]);
  });

  it("list() sets canWrite per the caller's role in each source's team", async () => {
    const row = (id: string, teamId: string) => ({ id, name: id, teamId, provider: "github", appId: "1", appSlug: null, installationId: null, htmlUrl: null, createdAt: new Date() });
    const prisma = {
      gitSource: { findMany: jest.fn().mockResolvedValue([row("s1", "tOwner"), row("s2", "tViewer")]) },
    } as unknown as PrismaService;
    const access = {
      roleByTeam: jest.fn().mockResolvedValue(new Map([["tOwner", Role.ADMIN], ["tViewer", Role.VIEWER]])),
    } as unknown as TeamAccessService;
    const list = await make(prisma as unknown as PrismaService, access).list("u1");
    expect(list.find((s) => s.id === "s1")!.canWrite).toBe(true);
    expect(list.find((s) => s.id === "s2")!.canWrite).toBe(false);
  });
});
