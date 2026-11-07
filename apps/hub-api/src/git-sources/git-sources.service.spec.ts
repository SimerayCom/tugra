import { generateKeyPairSync } from "node:crypto";
import { ConflictException, ForbiddenException } from "@nestjs/common";
import { Role } from "@prisma/client";
import { GitSourcesService } from "./git-sources.service";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";
import { CryptoService } from "../crypto/crypto.service";

const ALL_PERMS = ["apps:deploy", "apps:config", "databases", "backups", "servers:manage", "servers:ops", "terminal", "bulk", "monitors", "projects", "integrations", "variables"];

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
    const svc = make({ gitSource: { create } } as unknown as PrismaService, { requirePermission: jest.fn().mockResolvedValue(undefined) });
    const v = await svc.create("u1", { name: "gh", teamId: "t1", appId: "123", privateKey: PEM, installationId: "9", webhookSecret: "wh" });
    const data = create.mock.calls[0][0].data;
    expect(data.privateKeyEnc).toBe(`enc(${PEM})`);
    expect(data.webhookSecretEnc).toBe("enc(wh)");
    expect(v).not.toHaveProperty("privateKeyEnc");
    expect(v).not.toHaveProperty("webhookSecretEnc");
  });

  it("maps the unique (teamId, appId) violation on connect to a 409, not a raw 500", async () => {
    const create = jest.fn().mockRejectedValue(Object.assign(new Error("Unique constraint failed"), { code: "P2002" }));
    const svc = make({ gitSource: { create } } as unknown as PrismaService, { requirePermission: jest.fn().mockResolvedValue(undefined) });
    await expect(svc.create("u1", { name: "gh", teamId: "t1", appId: "123", privateKey: PEM })).rejects.toThrow(ConflictException);
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
      permissionsByTeam: jest.fn().mockResolvedValue(new Map([["tOwner", new Set(ALL_PERMS)], ["tViewer", new Set()]])),
    } as unknown as TeamAccessService;
    const list = await make(prisma as unknown as PrismaService, access).list("u1");
    expect(list.find((s) => s.id === "s1")!.canWrite).toBe(true);
    expect(list.find((s) => s.id === "s2")!.canWrite).toBe(false);
  });

  it("appJwt signs with a PKCS#1 'BEGIN RSA PRIVATE KEY' key (Dokploy's format)", () => {
    const pkcs1 = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs1" }).toString();
    expect(pkcs1).toContain("BEGIN RSA PRIVATE KEY");
    const svc = make({} as PrismaService, {});
    const jwt = svc.appJwt("777", pkcs1);
    expect(jwt.split(".")).toHaveLength(3);
    expect(JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString())).toMatchObject({ iss: "777" });
  });

  describe("upsertForImport", () => {
    const pkcs1 = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs1" }).toString();
    // minimal in-memory upsert keyed by (teamId, appId)
    function store() {
      const rows = new Map<string, Record<string, unknown>>();
      const upsert = jest.fn(async ({ where, create, update }: { where: { teamId_appId: { teamId: string; appId: string } }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
        const k = `${where.teamId_appId.teamId}:${where.teamId_appId.appId}`;
        const prev = rows.get(k);
        const row = prev ? { ...prev, ...update } : { id: `gs-${rows.size + 1}`, ...create };
        rows.set(k, row);
        return { id: row.id as string };
      });
      return { rows, upsert };
    }

    it("creates then updates (idempotent): one row, same id, refreshed encrypted creds + installation; name preserved", async () => {
      const { rows, upsert } = store();
      const requirePermission = jest.fn().mockResolvedValue(undefined);
      const svc = make({ gitSource: { upsert } } as unknown as PrismaService, { requirePermission });
      const id1 = await svc.upsertForImport("u1", "t1", { name: "My App", appId: "4242", privateKey: pkcs1, installationId: "1", clientSecret: "cs", webhookSecret: "wh" });
      const id2 = await svc.upsertForImport("u1", "t1", { name: "Renamed?", appId: "4242", privateKey: PEM, installationId: "2" });
      expect(id2).toBe(id1);
      expect(rows.size).toBe(1);
      const row = rows.get("t1:4242")!;
      expect(row.name).toBe("My App"); // not clobbered on update
      expect(row.installationId).toBe("2");
      expect(row.privateKeyEnc).toBe(`enc(${PEM})`);
      expect(row.clientSecretEnc).toBe("enc(cs)"); // omitted on the 2nd call → kept, not nulled
      expect(row.webhookSecretEnc).toBe("enc(wh)");
      expect(requirePermission).toHaveBeenCalledWith("u1", "t1", "integrations");
      expect(upsert.mock.calls[0][0].where).toEqual({ teamId_appId: { teamId: "t1", appId: "4242" } });
    });

    it("keeps an imported PKCS#1 key usable: decrypt → appJwt signs", async () => {
      const { rows, upsert } = store();
      const svc = make({ gitSource: { upsert } } as unknown as PrismaService, { requirePermission: jest.fn().mockResolvedValue(undefined) });
      await svc.upsertForImport("u1", "t1", { name: "n", appId: "9", privateKey: pkcs1 });
      const enc = rows.get("t1:9")!.privateKeyEnc as string;
      expect(() => svc.appJwt("9", crypto.decrypt(enc))).not.toThrow();
    });

    it("authorizes on the target team (forbidden → no write) and rejects an unparsable key without echoing it", async () => {
      const { upsert } = store();
      const denied = make({ gitSource: { upsert } } as unknown as PrismaService, { requirePermission: jest.fn().mockRejectedValue(new ForbiddenException("no")) });
      await expect(denied.upsertForImport("u1", "t1", { name: "n", appId: "9", privateKey: pkcs1 })).rejects.toThrow(ForbiddenException);
      const ok = make({ gitSource: { upsert } } as unknown as PrismaService, { requirePermission: jest.fn().mockResolvedValue(undefined) });
      await expect(ok.upsertForImport("u1", "t1", { name: "n", appId: "9", privateKey: "SECRET-NOT-A-PEM" })).rejects.toThrow(/invalid GitHub App private key/);
      const err = (await ok.upsertForImport("u1", "t1", { name: "n", appId: "9", privateKey: "SECRET-NOT-A-PEM" }).catch((x) => x)) as Error;
      expect(String(err?.message)).not.toContain("SECRET-NOT-A-PEM"); // the rejection never echoes the submitted key
      expect(upsert).not.toHaveBeenCalled();
    });
  });
});
