import { generateKeyPairSync } from "node:crypto";
import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { GithubManifestService } from "./github-manifest.service";
import { GitSourcesService } from "./git-sources.service";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";
import { CryptoService } from "../crypto/crypto.service";
import { hashState } from "./github-manifest";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const audit = { log: jest.fn() };
const crypto = { encrypt: (s: string) => `enc(${s})`, decrypt: (s: string) => s.replace(/^enc\(/, "").replace(/\)$/, "") } as unknown as CryptoService;
const config = { get: (k: string) => ({ HUB_PUBLIC_URL: "https://hub.example.com", WEB_PUBLIC_URL: "https://panel.example.com" })[k] } as unknown as ConfigService;

/** Minimal in-memory prisma for the three tables the flow touches. */
function fakePrisma(opts: { owner?: boolean } = {}) {
  const setups: Record<string, any>[] = [];
  const sources: Record<string, any>[] = [];
  const installs: Record<string, any>[] = [];
  const prisma = {
    user: { findUnique: jest.fn().mockResolvedValue({ isInstanceOwner: opts.owner ?? false }) },
    gitSourceSetup: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      create: jest.fn(async ({ data }: any) => { const r = { id: `setup${setups.length}`, usedAt: null, createdAt: new Date(), ...data }; setups.push(r); return r; }),
      findUnique: jest.fn(async ({ where }: any) => setups.find((s) => s.stateHash === where.stateHash) ?? null),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const hit = setups.filter((s) => s.id === where.id && (!where.expiresAt || (s.usedAt === null && s.expiresAt > where.expiresAt.gt)));
        hit.forEach((h) => Object.assign(h, data));
        return { count: hit.length };
      }),
    },
    gitSource: {
      create: jest.fn(async ({ data }: any) => { const r = { createdAt: new Date(), installationId: null, installations: [], ...data }; sources.push(r); return r; }),
      findUnique: jest.fn(async ({ where }: any) => sources.find((s) => s.id === where.id) ?? null),
      findUniqueOrThrow: jest.fn(async ({ where }: any) => ({ ...sources.find((s) => s.id === where.id)!, installations: installs.filter((i) => i.sourceId === where.id) })),
      update: jest.fn(async ({ where, data }: any) => Object.assign(sources.find((s) => s.id === where.id)!, data)),
    },
    gitSourceInstallation: {
      upsert: jest.fn(async ({ create, update }: any) => {
        const ex = installs.find((i) => i.sourceId === create.sourceId && i.installationId === create.installationId);
        if (ex) return Object.assign(ex, update);
        const r = { createdAt: new Date(), ...create }; installs.push(r); return r;
      }),
    },
  };
  return { prisma, setups, sources, installs };
}

function make(f: ReturnType<typeof fakePrisma>, access: Partial<TeamAccessService> = { requirePermission: jest.fn().mockResolvedValue(undefined) }) {
  const sources = new GitSourcesService(f.prisma as unknown as PrismaService, access as TeamAccessService, audit as unknown as AuditService, crypto, config);
  return new GithubManifestService(f.prisma as unknown as PrismaService, access as TeamAccessService, audit as unknown as AuditService, crypto, sources, config);
}

const stateOf = (postUrl: string) => new URL(postUrl).searchParams.get("state")!;

describe("GithubManifestService", () => {
  afterEach(() => jest.restoreAllMocks());

  it("start: authorizes the team, stores only the hash of a user-bound ticket, and pre-fills the manifest", async () => {
    const f = fakePrisma();
    const requirePermission = jest.fn().mockResolvedValue(undefined);
    const v = await make(f, { requirePermission }).start("u1", { teamId: "t1", name: "Acme Deploy" });
    expect(requirePermission).toHaveBeenCalledWith("u1", "t1", "integrations");
    const state = stateOf(v.postUrl);
    expect(f.setups).toHaveLength(1);
    expect(f.setups[0]).toMatchObject({ kind: "manifest", userId: "u1", teamId: "t1", stateHash: hashState(state) });
    expect(JSON.stringify(f.setups)).not.toContain(state);
    expect(f.setups[0].expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(15 * 60_000);
    expect(v.manifest.hook_attributes.url).toBe(`https://hub.example.com/webhooks/github/${f.setups[0].sourceId}`);
    expect(v.manifest.redirect_url).toBe("https://panel.example.com/sources/github/callback");
    expect(v.webhookActive).toBe(true);
    expect(v.postUrl.startsWith("https://github.com/settings/apps/new?")).toBe(true);
  });

  it("start: an organization posts to its settings page; sharing with all teams needs the instance owner", async () => {
    const f = fakePrisma();
    const v = await make(f).start("u1", { teamId: "t1", org: "acme-inc" });
    expect(v.postUrl.startsWith("https://github.com/organizations/acme-inc/settings/apps/new?")).toBe(true);
    await expect(make(f).start("u1", { teamId: "t1", sharedAllTeams: true })).rejects.toThrow(ForbiddenException);
    const owner = fakePrisma({ owner: true });
    await make(owner).start("u1", { teamId: "t1", sharedAllTeams: true });
    expect(owner.setups[0].sharedAllTeams).toBe(true);
  });

  it("start: no integrations permission means no ticket", async () => {
    const f = fakePrisma();
    const requirePermission = jest.fn().mockRejectedValue(new ForbiddenException());
    await expect(make(f, { requirePermission }).start("u1", { teamId: "t9" })).rejects.toThrow(ForbiddenException);
    expect(f.setups).toHaveLength(0);
  });

  function mockGithub(handlers: Record<string, () => unknown>) {
    const calls: { url: string; method?: string }[] = [];
    (global as unknown as { fetch: typeof fetch }).fetch = jest.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method });
      const key = Object.keys(handlers).find((k) => url.includes(k));
      if (!key) return { ok: false, status: 404, json: async () => ({}) } as Response;
      return { ok: true, status: 200, json: async () => handlers[key]() } as Response;
    }) as unknown as typeof fetch;
    return calls;
  }

  it("complete: exchanges the code, stores credentials encrypted under the pre-issued source id, never returns the key", async () => {
    const f = fakePrisma();
    const svc = make(f);
    const started = await svc.start("u1", { teamId: "t1", name: "Acme Deploy" });
    const calls = mockGithub({ "/app-manifests/": () => ({ id: 4242, slug: "acme-deploy", name: "Acme Deploy", html_url: "https://github.com/apps/acme-deploy", client_id: "Iv1.x", client_secret: "cs", webhook_secret: "whsec", pem: PEM }) });
    const out = await svc.complete("u1", { code: "the-code", state: stateOf(started.postUrl) });
    expect(calls[0].url).toBe("https://api.github.com/app-manifests/the-code/conversions");
    expect(calls[0].method).toBe("POST");
    const row = f.sources[0];
    expect(row.id).toBe(f.setups[0].sourceId);
    expect(row).toMatchObject({ teamId: "t1", appId: "4242", appSlug: "acme-deploy", privateKeyEnc: `enc(${PEM})`, webhookSecretEnc: "enc(whsec)", clientSecretEnc: "enc(cs)" });
    expect(JSON.stringify(out)).not.toContain("BEGIN PRIVATE KEY");
    expect(JSON.stringify(out)).not.toContain("whsec");
    expect(out.source.webhookUrl).toBe(`https://hub.example.com/webhooks/github/${row.id}`);
    expect(out.installUrl.startsWith("https://github.com/apps/acme-deploy/installations/new?state=")).toBe(true);
    expect(JSON.stringify(audit.log.mock.calls)).not.toContain("BEGIN PRIVATE KEY");
  });

  it("complete: a ticket is single use", async () => {
    const f = fakePrisma();
    const svc = make(f);
    const started = await svc.start("u1", { teamId: "t1" });
    mockGithub({ "/app-manifests/": () => ({ id: 1, slug: "a", pem: PEM, webhook_secret: "w" }) });
    const state = stateOf(started.postUrl);
    await svc.complete("u1", { code: "c", state });
    await expect(svc.complete("u1", { code: "c", state })).rejects.toThrow(/invalid or expired/);
    expect(f.sources).toHaveLength(1);
  });

  it("complete: a transient GitHub failure hands the ticket back so the user can retry", async () => {
    const f = fakePrisma();
    const svc = make(f);
    const started = await svc.start("u1", { teamId: "t1" });
    const state = stateOf(started.postUrl);
    (global as unknown as { fetch: typeof fetch }).fetch = jest.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch;
    await expect(svc.complete("u1", { code: "c", state })).rejects.toThrow(/try again/);
    expect(f.setups[0].usedAt).toBeNull();
    (global as unknown as { fetch: typeof fetch }).fetch = jest.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    await expect(svc.complete("u1", { code: "c", state })).rejects.toThrow(/could not be reached/);
    expect(f.setups[0].usedAt).toBeNull();
    mockGithub({ "/app-manifests/": () => ({ id: 1, slug: "a", pem: PEM }) });
    await svc.complete("u1", { code: "c", state });
    expect(f.sources).toHaveLength(1);
  });

  it("complete: a spent or expired code keeps the ticket used and explains the App may already exist", async () => {
    const f = fakePrisma();
    const svc = make(f);
    const started = await svc.start("u1", { teamId: "t1" });
    mockGithub({}); // 404 for the conversion
    await expect(svc.complete("u1", { code: "c", state: stateOf(started.postUrl) })).rejects.toThrow(/delete it there/);
    expect(f.setups[0].usedAt).not.toBeNull();
    expect(f.sources).toHaveLength(0);
  });

  it("complete: another user's browser cannot use the ticket, and the ticket survives", async () => {
    const f = fakePrisma();
    const svc = make(f);
    const started = await svc.start("u1", { teamId: "t1" });
    const fetchSpy = mockGithub({ "/app-manifests/": () => ({ id: 1, slug: "a", pem: PEM }) });
    await expect(svc.complete("u2", { code: "c", state: stateOf(started.postUrl) })).rejects.toThrow(BadRequestException);
    expect(fetchSpy).toHaveLength(0);
    expect(f.setups[0].usedAt).toBeNull();
    expect(f.sources).toHaveLength(0);
  });

  it("complete: an expired ticket and a made-up state are refused before GitHub is called", async () => {
    const f = fakePrisma();
    const svc = make(f);
    const started = await svc.start("u1", { teamId: "t1" });
    f.setups[0].expiresAt = new Date(Date.now() - 1000);
    const calls = mockGithub({ "/app-manifests/": () => ({ id: 1, slug: "a", pem: PEM }) });
    await expect(svc.complete("u1", { code: "c", state: stateOf(started.postUrl) })).rejects.toThrow(/invalid or expired/);
    await expect(svc.complete("u1", { code: "c", state: "forged" })).rejects.toThrow(/invalid or expired/);
    expect(calls).toHaveLength(0);
  });

  it("complete: an install ticket cannot be used where a manifest ticket is expected", async () => {
    const f = fakePrisma();
    const svc = make(f);
    const started = await svc.start("u1", { teamId: "t1" });
    mockGithub({ "/app-manifests/": () => ({ id: 1, slug: "a", pem: PEM }) });
    const done = await svc.complete("u1", { code: "c", state: stateOf(started.postUrl) });
    await expect(svc.complete("u1", { code: "c", state: new URL(done.installUrl).searchParams.get("state")! })).rejects.toThrow(/invalid or expired/);
  });

  it("complete: an unreadable key from GitHub is rejected without echoing it", async () => {
    const f = fakePrisma();
    const svc = make(f);
    const started = await svc.start("u1", { teamId: "t1" });
    mockGithub({ "/app-manifests/": () => ({ id: 1, slug: "a", pem: "-----BEGIN PRIVATE KEY-----\nSECRETJUNK\n-----END PRIVATE KEY-----" }) });
    const err = await svc.complete("u1", { code: "c", state: stateOf(started.postUrl) }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as Error).message).not.toContain("SECRETJUNK");
    expect(f.sources).toHaveLength(0);
  });

  it("captureInstallation: records the account, sets the primary installation, supports a second one", async () => {
    const f = fakePrisma();
    const svc = make(f);
    const started = await svc.start("u1", { teamId: "t1" });
    mockGithub({ "/app-manifests/": () => ({ id: 77, slug: "a", pem: PEM, webhook_secret: "w" }) });
    const done = await svc.complete("u1", { code: "c", state: stateOf(started.postUrl) });
    mockGithub({ "/app/installations/555": () => ({ id: 555, app_id: 77, account: { login: "alice", type: "User", avatar_url: "https://avatars.example.com/a" } }) });
    const view = await svc.captureInstallation("u1", { state: new URL(done.installUrl).searchParams.get("state")!, installationId: "555" });
    expect(view.installationId).toBe("555");
    expect(view.installations).toEqual([{ installationId: "555", accountLogin: "alice", accountType: "User", avatarUrl: "https://avatars.example.com/a" }]);

    // a second installation (an organization) via the add-another-account link
    mockGithub({});
    const more = await svc.startInstall("u1", f.sources[0].id);
    mockGithub({ "/app/installations/556": () => ({ id: 556, app_id: 77, account: { login: "acme-inc", type: "Organization", avatar_url: null } }) });
    const view2 = await svc.captureInstallation("u1", { state: new URL(more.installUrl).searchParams.get("state")!, installationId: "556" });
    expect(view2.installationId).toBe("555"); // primary unchanged
    expect(view2.installations.map((i) => i.accountLogin)).toEqual(["alice", "acme-inc"]);
  });

  it("captureInstallation: refuses an installation that does not belong to the App", async () => {
    const f = fakePrisma();
    const svc = make(f);
    const started = await svc.start("u1", { teamId: "t1" });
    mockGithub({ "/app-manifests/": () => ({ id: 77, slug: "a", pem: PEM }) });
    const done = await svc.complete("u1", { code: "c", state: stateOf(started.postUrl) });
    mockGithub({ "/app/installations/9": () => ({ id: 9, app_id: 12345, account: { login: "mallory", type: "User" } }) });
    await expect(svc.captureInstallation("u1", { state: new URL(done.installUrl).searchParams.get("state")!, installationId: "9" })).rejects.toThrow(/does not belong/);
    expect(f.installs).toHaveLength(0);
    expect(f.sources[0].installationId).toBeNull();
  });

  it("startInstall: needs the integrations permission on the source's team", async () => {
    const f = fakePrisma();
    f.sources.push({ id: "s1", teamId: "t1", provider: "github", appId: "1", appSlug: "a", privateKeyEnc: `enc(${PEM})` });
    const requirePermission = jest.fn().mockRejectedValue(new ForbiddenException());
    await expect(make(f, { requirePermission }).startInstall("u2", "s1")).rejects.toThrow(ForbiddenException);
    expect(f.setups).toHaveLength(0);
  });
});
