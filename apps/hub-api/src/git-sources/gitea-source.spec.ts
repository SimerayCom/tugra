import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GitSourcesService, sourceCloneHost } from "./git-sources.service";
import { CreateGitSourceSchema } from "./dto";
import { GiteaClient, normalizeApiUrl, parseRepoFullName } from "./gitea-client";
import { GuardedHttpGet } from "../importer/sources/guarded-get";
import { gitCloneSteps, type AppSpec } from "../deploy/deploy-script";
import type { PrismaService } from "../prisma/prisma.service";
import type { TeamAccessService } from "../common/team-access.service";
import type { AuditService } from "../audit/audit.service";
import type { CryptoService } from "../crypto/crypto.service";

const TOKEN = "gta_SUPER_SECRET_TOKEN_123";
const audit = { log: jest.fn() };
const crypto = {
  encrypt: (s: string) => `enc(${s})`,
  decrypt: (s: string) => s.replace(/^enc\(/, "").replace(/\)$/, ""),
} as unknown as CryptoService;

function make(prisma: unknown, access: Partial<TeamAccessService> = {}) {
  return new GitSourcesService(prisma as PrismaService, access as TeamAccessService, audit as unknown as AuditService, crypto);
}
const allow = { requirePermission: jest.fn().mockResolvedValue(undefined) };

const row = (over: Record<string, unknown> = {}) => ({
  id: "s1", name: "cb", teamId: "t1", provider: "gitea", appId: null, appSlug: null, installationId: null,
  htmlUrl: "https://git.example.com", apiUrl: "https://git.example.com", tokenEnc: `enc(${TOKEN})`, privateKeyEnc: null,
  createdAt: new Date(), ...over,
});

afterEach(() => jest.restoreAllMocks());

describe("GitSource schema (token providers)", () => {
  const model = Prisma.dmmf.datamodel.models.find((m) => m.name === "GitSource")!;
  const field = (n: string) => model.fields.find((f) => f.name === n)!;

  it("appId and privateKeyEnc are nullable; apiUrl/tokenEnc exist and are optional", () => {
    expect(field("appId").isRequired).toBe(false);
    expect(field("privateKeyEnc").isRequired).toBe(false);
    expect(field("apiUrl").isRequired).toBe(false);
    expect(field("tokenEnc").isRequired).toBe(false);
    expect(field("provider").default).toBe("github"); // existing GitHub rows keep their discriminator
  });

  it("keeps @@unique([teamId, appId]) — NULL appIds are distinct in Postgres, so many token sources coexist", () => {
    expect(model.uniqueFields).toEqual([["teamId", "appId"]]);
    const sql = readFileSync(join(__dirname, "../../prisma/migrations/20261107203000_git_source_token_providers/migration.sql"), "utf8");
    expect(sql).toMatch(/ALTER COLUMN "appId" DROP NOT NULL/);
    expect(sql).toMatch(/ALTER COLUMN "privateKeyEnc" DROP NOT NULL/);
    expect(sql).not.toMatch(/DROP INDEX|DROP CONSTRAINT/); // the unique index is untouched
    // a token source never sets appId, so it can never collide on (teamId, appId)
  });
});

describe("create() dispatch by kind", () => {
  it("a payload without `kind` is still a GitHub App source (pre-existing shape)", () => {
    const r = CreateGitSourceSchema.safeParse({ name: "gh", teamId: "t1", appId: "1", privateKey: "pem" });
    expect(r.success).toBe(true);
  });

  it("gitea connect validates the token (whoami), then stores it ENCRYPTED; the view never carries it", async () => {
    const get = jest.spyOn(GuardedHttpGet.prototype, "get").mockResolvedValue({ login: "omer" });
    const create = jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => row(data));
    const svc = make({ gitSource: { create } }, allow);
    const v = await svc.create("u1", { kind: "gitea", name: "cb", teamId: "t1", apiUrl: "https://git.example.com/", token: TOKEN });
    expect(get).toHaveBeenCalledWith("/user");
    const data = create.mock.calls[0][0].data;
    expect(data).toMatchObject({ provider: "gitea", apiUrl: "https://git.example.com", tokenEnc: `enc(${TOKEN})` });
    expect(data.appId).toBeUndefined();
    expect(data.privateKeyEnc).toBeUndefined();
    expect(v).toMatchObject({ kind: "gitea", provider: "gitea", apiUrl: "https://git.example.com", hasToken: true, appId: null });
    expect(JSON.stringify(v)).not.toContain(TOKEN);
    expect(v).not.toHaveProperty("tokenEnc");
    expect(JSON.stringify(audit.log.mock.calls)).not.toContain(TOKEN);
  });

  it("does NOT persist when the token is rejected, and the error never echoes the token", async () => {
    jest.spyOn(GuardedHttpGet.prototype, "get").mockRejectedValue(new Error(`Gitea API error 401 for ${TOKEN}`));
    const create = jest.fn();
    const svc = make({ gitSource: { create } }, allow);
    const err = (await svc.create("u1", { kind: "forgejo", name: "f", teamId: "t1", apiUrl: "https://forge.example.com", token: TOKEN }).catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).not.toContain(TOKEN);
    expect(create).not.toHaveBeenCalled();
  });

  it("codeberg needs no URL (fixed https://codeberg.org)", async () => {
    jest.spyOn(GuardedHttpGet.prototype, "get").mockResolvedValue({ login: "x" });
    const create = jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => row(data));
    const v = await make({ gitSource: { create } }, allow).create("u1", { kind: "codeberg", name: "c", teamId: "t1", token: TOKEN });
    expect(create.mock.calls[0][0].data).toMatchObject({ provider: "codeberg", apiUrl: "https://codeberg.org" });
    expect(v.kind).toBe("codeberg");
  });

  it("requires the integrations permission before any network call", async () => {
    const get = jest.spyOn(GuardedHttpGet.prototype, "get");
    const svc = make({ gitSource: { create: jest.fn() } }, { requirePermission: jest.fn().mockRejectedValue(new ForbiddenException("no")) });
    await expect(svc.create("u1", { kind: "gitea", name: "g", teamId: "t1", apiUrl: "https://git.example.com", token: TOKEN })).rejects.toThrow(ForbiddenException);
    expect(get).not.toHaveBeenCalled();
  });

  it("list() exposes kind/apiUrl/hasToken for both a GitHub row and a token row, never a secret", async () => {
    const gh = { ...row({ id: "g1", provider: "github", appId: "7", apiUrl: null, tokenEnc: null, privateKeyEnc: "enc(pem)", htmlUrl: null }) };
    const prisma = { gitSource: { findMany: jest.fn().mockResolvedValue([gh, row()]) } };
    const access = { permissionsByTeam: jest.fn().mockResolvedValue(new Map([["t1", new Set(["integrations"])]])) };
    const list = await make(prisma, access as unknown as TeamAccessService).list("u1");
    expect(list.map((s) => [s.kind, s.apiUrl, s.hasToken, s.appId])).toEqual([["github", null, true, "7"], ["gitea", "https://git.example.com", true, null]]);
    expect(JSON.stringify(list)).not.toMatch(/enc\(|SECRET/);
  });
});

describe("SSRF guard on the user-supplied apiUrl", () => {
  it("rejects internal / non-https base URLs at normalisation (before any request)", () => {
    for (const bad of [
      "https://127.0.0.1", "https://169.254.169.254", "https://[::1]", "https://[::ffff:7f00:1]", "https://0.0.0.0",
      "http://git.example.com", "ftp://git.example.com", "https://user:pw@git.example.com", "not a url",
    ]) {
      expect(() => normalizeApiUrl("gitea", bad)).toThrow();
    }
    expect(() => normalizeApiUrl("gitea", "")).toThrow(/required/);
    expect(() => normalizeApiUrl("codeberg", "https://evil.example.com")).toThrow(/codeberg\.org/);
  });

  it("normalises: strips trailing slash, a pasted /api/v1, query and fragment; keeps a sub-path", () => {
    expect(normalizeApiUrl("gitea", "https://Git.Example.com/")).toBe("https://git.example.com");
    expect(normalizeApiUrl("forgejo", "https://git.example.com/api/v1/")).toBe("https://git.example.com");
    expect(normalizeApiUrl("gitea", "https://git.example.com/gitea/?a=1#x")).toBe("https://git.example.com/gitea");
  });

  it("create() with an internal URL fails 400 and never persists or calls out", async () => {
    const create = jest.fn();
    const svc = make({ gitSource: { create } }, allow);
    await expect(svc.create("u1", { kind: "gitea", name: "x", teamId: "t1", apiUrl: "https://169.254.169.254", token: TOKEN })).rejects.toThrow(BadRequestException);
    expect(create).not.toHaveBeenCalled();
  });

  it("a hostname that RESOLVES to loopback is refused by the guarded lookup (real request, no network needed)", async () => {
    const client = new GiteaClient("https://localhost:9", TOKEN);
    await expect(client.whoami()).rejects.toThrow(/SSRF guard/);
  });

  it("the client refuses to construct against a blocked IP literal", () => {
    expect(() => new GiteaClient("https://127.0.0.1", TOKEN)).toThrow();
  });
});

describe("listRepos / listBranches dispatch by kind", () => {
  it("gitea: pages /user/repos and returns repos with default branch", async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => ({ full_name: `o/r${i}`, clone_url: `https://git.example.com/o/r${i}.git`, private: true, default_branch: "main" }));
    const page2 = [{ full_name: "o/last", clone_url: "https://git.example.com/o/last.git", private: false, default_branch: null }];
    // page2 is a partial page (1 < 50); pagination stops on the next EMPTY page (so a server that clamps `limit`
    // below 50 is not silently truncated), hence the trailing [].
    const get = jest.spyOn(GuardedHttpGet.prototype, "get").mockResolvedValueOnce(page1).mockResolvedValueOnce(page2).mockResolvedValueOnce([]);
    const svc = make({ gitSource: { findUnique: jest.fn().mockResolvedValue(row()) } }, { teamRole: jest.fn().mockResolvedValue("OWNER") } as never);
    const repos = await svc.listRepos("u1", "s1");
    expect(get.mock.calls.map((c) => c[0])).toEqual(["/user/repos?limit=50&page=1", "/user/repos?limit=50&page=2", "/user/repos?limit=50&page=3"]);
    expect(repos).toHaveLength(51);
    expect(repos[0]).toEqual({ fullName: "o/r0", cloneUrl: "https://git.example.com/o/r0.git", private: true, defaultBranch: "main" });
    expect(repos[50].defaultBranch).toBeNull();
  });

  it("gitea: lists branches of owner/repo (path-encoded) and rejects a malformed repo", async () => {
    const get = jest.spyOn(GuardedHttpGet.prototype, "get").mockResolvedValueOnce([{ name: "main" }, { name: "dev" }]).mockResolvedValueOnce([]);
    const svc = make({ gitSource: { findUnique: jest.fn().mockResolvedValue(row()) } }, { teamRole: jest.fn().mockResolvedValue("OWNER") } as never);
    expect(await svc.listBranches("u1", "s1", "acme/web")).toEqual([{ name: "main" }, { name: "dev" }]);
    expect(get.mock.calls[0][0]).toBe("/repos/acme/web/branches?limit=50&page=1");
    for (const bad of ["acme", "../etc/passwd", "a/b/c", "acme/..", "acme/we b", ""]) {
      await expect(svc.listBranches("u1", "s1", bad)).rejects.toThrow(BadRequestException);
    }
    expect(parseRepoFullName("acme/web.js")).toEqual({ owner: "acme", repo: "web.js" });
  });

  it("requires team membership", async () => {
    const svc = make({ gitSource: { findUnique: jest.fn().mockResolvedValue(row()) } }, { teamRole: jest.fn().mockResolvedValue(null) } as never);
    await expect(svc.listRepos("u1", "s1")).rejects.toThrow(ForbiddenException);
    await expect(svc.listBranches("u1", "s1", "a/b")).rejects.toThrow(ForbiddenException);
  });

  it("a provider failure becomes a 400 that never echoes the token", async () => {
    jest.spyOn(GuardedHttpGet.prototype, "get").mockRejectedValue(new Error(`boom ${TOKEN}`));
    const svc = make({ gitSource: { findUnique: jest.fn().mockResolvedValue(row()) } }, { teamRole: jest.fn().mockResolvedValue("OWNER") } as never);
    const err = (await svc.listRepos("u1", "s1").catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).not.toContain(TOKEN);
  });

  it("github still dispatches to the GitHub App path (branches via installation token)", async () => {
    const gh = row({ id: "g1", provider: "github", appId: "1", apiUrl: null, tokenEnc: null, privateKeyEnc: "x", installationId: "9" });
    const svc = make({ gitSource: { findUnique: jest.fn().mockResolvedValue(gh) } }, { teamRole: jest.fn().mockResolvedValue("OWNER") } as never);
    jest.spyOn(svc, "installationToken").mockResolvedValue("ghs_t");
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => [{ name: "main" }] });
    (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
    expect(await svc.listBranches("u1", "g1", "acme/web")).toEqual([{ name: "main" }]);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.github.com/repos/acme/web/branches?per_page=100");
  });

  it("installationToken refuses a token source", async () => {
    const svc = make({ gitSource: { findUnique: jest.fn().mockResolvedValue(row()) } });
    await expect(svc.installationToken("s1")).rejects.toThrow(/not a GitHub App/);
  });
});

describe("clone wiring (cloneToken → deploy script)", () => {
  const svc = () => make({ gitSource: { findUnique: jest.fn().mockResolvedValue(row()) } });

  it("an app linked to a gitea source resolves its decrypted token for a repo on the instance host", async () => {
    expect(await svc().cloneToken("s1", "https://git.example.com/acme/web.git")).toBe(TOKEN);
  });

  it("pins the credential to the source's host: a repo URL anywhere else is refused (no token leaves)", async () => {
    await expect(svc().cloneToken("s1", "https://evil.example.com/acme/web.git")).rejects.toThrow(/only authenticates git\.example\.com/);
    // an ssh:// / git@ repo authenticates with its deploy key — no HTTP token is transmitted, so it returns "" (not a host-mismatch error)
    expect(await svc().cloneToken("s1", "git@evil.example.com:acme/web.git")).toBe("");
    await expect(svc().cloneToken("s1", null)).rejects.toThrow(BadRequestException);
  });

  it("a GitHub App source is pinned to github.com", async () => {
    const gh = row({ id: "g1", provider: "github", appId: "1", apiUrl: null, tokenEnc: null, privateKeyEnc: "x", installationId: "9" });
    const s = make({ gitSource: { findUnique: jest.fn().mockResolvedValue(gh) } });
    jest.spyOn(s, "installationToken").mockResolvedValue("ghs_t");
    expect(await s.cloneToken("g1", "https://github.com/acme/web.git")).toBe("ghs_t");
    await expect(s.cloneToken("g1", "https://git.example.com/acme/web.git")).rejects.toThrow(/only authenticates github\.com/);
    expect(sourceCloneHost({ provider: "codeberg", apiUrl: "https://codeberg.org" })).toBe("codeberg.org");
  });

  it("the token never appears in the clone script: askpass only, base64-transported, not in argv or the URL", () => {
    const app = { gitUrl: "https://git.example.com/acme/web.git", gitBranch: "main", gitToken: TOKEN } as unknown as AppSpec;
    const script = gitCloneSteps(app, "/tmp/build").join("\n");
    expect(script).toContain("GIT_ASKPASS=");
    expect(script).not.toContain(TOKEN); // only its base64 form is shipped, and it is written to a 0600 file
    const cloneLine = script.split("\n").find((l) => l.includes("git clone"))!;
    expect(cloneLine).not.toContain(TOKEN);
    expect(cloneLine).toContain("https://x-access-token@git.example.com/acme/web.git");
    expect(cloneLine).not.toMatch(/:[^@/]*@git\.example\.com/); // no password in the URL
  });
});
