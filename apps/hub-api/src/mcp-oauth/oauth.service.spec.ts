import { createHash } from "node:crypto";
import { TEAM_PERMISSIONS } from "@tugra/shared";
import { hashToken } from "../api-tokens/api-token.util";
import {
  McpOAuthService,
  authorizationServerMetadata,
  protectedResourceMetadata,
  resourceMetadataUrl,
} from "./oauth.service";
import { ACCESS_TTL_MS, CODE_TTL_MS, REFRESH_TTL_MS } from "./oauth.util";

const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
const REDIRECT = "http://localhost:8123/callback";
const RESOURCE = "https://hub.test/api/v1/mcp";
const ISSUER = "https://hub.test";

type Row = Record<string, any>;

// A tiny in-memory stand-in for the four OAuth tables: enough where-matching (equality, in, lt, gt, null,
// none) for the calls the service makes, with the grant -> token cascade the real schema has.
function table(name: string, db: Record<string, Row[]>, cascade?: (removed: Row[]) => void) {
  let seq = 0;
  const rows: Row[] = (db[name] = []);
  const match = (r: Row, where: Row = {}): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (k === "OR") return (v as Row[]).some((w) => match(r, w));
      if (k === "grants") return true; // client sweep: handled by the grants table in the test when needed
      if (v && typeof v === "object" && !(v instanceof Date)) {
        const o = v as Row;
        if ("in" in o) return o.in.includes(r[k]);
        if ("lt" in o) return r[k] < o.lt;
        if ("gt" in o) return r[k] > o.gt;
        return true;
      }
      return r[k] === v;
    });
  return {
    create: async ({ data }: Row) => {
      const row = { id: `${name}${++seq}`, createdAt: new Date(), usedAt: null, refreshUsedAt: null, lastUsedAt: null, grantId: null, ...data };
      rows.push(row);
      return row;
    },
    findUnique: async ({ where }: Row) => rows.find((r) => match(r, where)) ?? null,
    findFirst: async ({ where }: Row) => rows.find((r) => match(r, where)) ?? null,
    findMany: async ({ where }: Row = {}) => rows.filter((r) => match(r, where)),
    update: async ({ where, data }: Row) => {
      const r = rows.find((x) => match(x, where))!;
      Object.assign(r, data);
      return r;
    },
    updateMany: async ({ where, data }: Row) => {
      const hit = rows.filter((r) => match(r, where));
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    },
    deleteMany: async ({ where }: Row = {}) => {
      const hit = rows.filter((r) => match(r, where));
      for (const r of hit) rows.splice(rows.indexOf(r), 1);
      cascade?.(hit);
      return { count: hit.length };
    },
  };
}

function setup(perms: string[] | null = [...TEAM_PERMISSIONS]) {
  const db: Record<string, Row[]> = {};
  const tokens = () => db.oAuthToken;
  const state = { perms: perms as string[] | null };
  const prisma: any = {};
  prisma.oAuthClient = table("oAuthClient", db);
  prisma.oAuthCode = table("oAuthCode", db);
  prisma.oAuthToken = table("oAuthToken", db);
  prisma.oAuthGrant = table("oAuthGrant", db, (removed) => {
    for (const g of removed) {
      for (const t of [...tokens()]) if (t.grantId === g.id) tokens().splice(tokens().indexOf(t), 1);
    }
  });
  // findUnique on tokens joins the grant, like include: { grant: true }
  const baseFind = prisma.oAuthToken.findUnique;
  prisma.oAuthToken.findUnique = async (a: Row) => {
    const t = await baseFind(a);
    return t ? { ...t, grant: db.oAuthGrant.find((g) => g.id === t.grantId) } : null;
  };
  const baseFirst = prisma.oAuthToken.findFirst;
  prisma.oAuthToken.findFirst = async (a: Row) => {
    const t = await baseFirst(a);
    return t ? { ...t, grant: db.oAuthGrant.find((g) => g.id === t.grantId) } : null;
  };
  prisma.team = { findMany: async () => [{ id: "team1", name: "Acme" }] };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const access = {
    membershipPermissions: jest.fn(async () => (state.perms ? new Set(state.perms) : null)),
    permissionsByTeam: jest.fn(async () => new Map([["team1", new Set(state.perms ?? [])]])),
  };
  const svc = new McpOAuthService(prisma, audit as any, access as any);
  return { svc, db, state, audit, access };
}

async function registered(s: ReturnType<typeof setup>) {
  const r = await s.svc.register({ client_name: "Test client", redirect_uris: [REDIRECT] });
  return r.client_id as string;
}

async function approveFor(s: ReturnType<typeof setup>, clientId: string, scopes = ["read"]) {
  const out = await s.svc.decide(
    "user1",
    { response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: CHALLENGE, code_challenge_method: "S256", state: "xyz" },
    { approve: true, teamId: "team1", scopes },
    RESOURCE,
    ISSUER,
  );
  const url = new URL(out.redirectTo);
  return { code: url.searchParams.get("code")!, url };
}

const exchange = (s: ReturnType<typeof setup>, clientId: string, code: string, over: Record<string, string> = {}) =>
  s.svc.exchangeCode({ code, code_verifier: VERIFIER, client_id: clientId, redirect_uri: REDIRECT, ...over });

describe("metadata documents", () => {
  const o = { issuer: ISSUER, web: ISSUER };
  it("protected resource metadata names the MCP resource and the authorization server", () => {
    const m = protectedResourceMetadata(o);
    expect(m.resource).toBe("https://hub.test/api/v1/mcp");
    expect(m.authorization_servers).toEqual([ISSUER]);
    expect(m.bearer_methods_supported).toEqual(["header"]);
    expect(m.scopes_supported).toEqual(["read", "write", "deploy", "admin", "read:secrets"]);
  });
  it("authorization server metadata is OAuth 2.1 / PKCE S256 / public clients only", () => {
    const m = authorizationServerMetadata({ issuer: ISSUER, web: "https://panel.test" });
    expect(m.issuer).toBe(ISSUER);
    expect(m.authorization_endpoint).toBe("https://panel.test/oauth/authorize");
    expect(m.token_endpoint).toBe("https://hub.test/api/v1/oauth/token");
    expect(m.registration_endpoint).toBe("https://hub.test/api/v1/oauth/register");
    expect(m.revocation_endpoint).toBe("https://hub.test/api/v1/oauth/revoke");
    expect(m.response_types_supported).toEqual(["code"]);
    expect(m.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
    expect(m.code_challenge_methods_supported).toEqual(["S256"]);
    expect(m.token_endpoint_auth_methods_supported).toEqual(["none"]);
  });
  it("the WWW-Authenticate target is the path-suffixed protected resource document", () => {
    expect(resourceMetadataUrl(ISSUER)).toBe("https://hub.test/.well-known/oauth-protected-resource/api/v1/mcp");
  });
});

describe("dynamic client registration", () => {
  it("registers a public client", async () => {
    const s = setup();
    const r = await s.svc.register({ client_name: "Claude", redirect_uris: [REDIRECT, "https://claude.ai/cb"] });
    expect(r).toMatchObject({ client_name: "Claude", token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"] });
    expect(typeof r.client_id).toBe("string");
    expect(r).not.toHaveProperty("client_secret");
  });
  it("refuses missing, plain-http and custom-scheme redirect URIs", async () => {
    const s = setup();
    await expect(s.svc.register({})).rejects.toMatchObject({ response: { error: "invalid_redirect_uri" } });
    await expect(s.svc.register({ redirect_uris: ["http://example.com/cb"] })).rejects.toMatchObject({ response: { error: "invalid_redirect_uri" } });
    await expect(s.svc.register({ redirect_uris: ["myapp://cb"] })).rejects.toMatchObject({ response: { error: "invalid_redirect_uri" } });
  });
  it("refuses confidential-client auth methods", async () => {
    const s = setup();
    await expect(s.svc.register({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "client_secret_basic" })).rejects.toMatchObject({
      response: { error: "invalid_client_metadata" },
    });
  });
});

describe("authorization request", () => {
  const base = (clientId: string) => ({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: CHALLENGE, code_challenge_method: "S256" });

  it("requires an exact registered redirect_uri", async () => {
    const s = setup();
    const id = await registered(s);
    await expect(s.svc.validateAuthorize({ ...base(id), redirect_uri: `${REDIRECT}/` }, RESOURCE)).rejects.toMatchObject({ response: { error: "invalid_request" } });
    await expect(s.svc.validateAuthorize({ ...base(id), redirect_uri: "http://localhost:8123/callback?x=1" }, RESOURCE)).rejects.toMatchObject({ response: { error: "invalid_request" } });
    await expect(s.svc.validateAuthorize(base(id), RESOURCE)).resolves.toMatchObject({ redirectUri: REDIRECT });
  });
  it("accepts only S256", async () => {
    const s = setup();
    const id = await registered(s);
    await expect(s.svc.validateAuthorize({ ...base(id), code_challenge_method: "plain" }, RESOURCE)).rejects.toMatchObject({ response: { error: "invalid_request" } });
    await expect(s.svc.validateAuthorize({ ...base(id), code_challenge_method: undefined }, RESOURCE)).rejects.toMatchObject({ response: { error: "invalid_request" } });
  });
  it("rejects a resource that is not this server", async () => {
    const s = setup();
    const id = await registered(s);
    await expect(s.svc.validateAuthorize({ ...base(id), resource: "https://evil.test/api/v1/mcp" }, RESOURCE)).rejects.toMatchObject({ response: { error: "invalid_target" } });
    await expect(s.svc.validateAuthorize({ ...base(id), resource: `${RESOURCE}/` }, RESOURCE)).resolves.toBeDefined();
  });
  it("the consent preview lists teams with what the role allows", async () => {
    const s = setup(["monitors"]);
    const id = await registered(s);
    const p = await s.svc.preview("user1", base(id), RESOURCE);
    expect(p.client.name).toBe("Test client");
    expect(p.redirectHost).toBe("localhost:8123");
    expect(p.teams).toEqual([{ id: "team1", name: "Acme", allowedScopes: ["read", "write"] }]);
  });
  it("denying redirects back with access_denied and the state", async () => {
    const s = setup();
    const id = await registered(s);
    const out = await s.svc.decide("user1", { ...base(id), state: "s1" }, { approve: false }, RESOURCE, ISSUER);
    const u = new URL(out.redirectTo);
    expect(u.searchParams.get("error")).toBe("access_denied");
    expect(u.searchParams.get("state")).toBe("s1");
    expect(u.searchParams.get("code")).toBeNull();
  });
  it("refuses scopes above the user's role in the chosen team", async () => {
    const s = setup(["monitors"]);
    const id = await registered(s);
    await expect(s.svc.decide("user1", base(id), { approve: true, teamId: "team1", scopes: ["read", "admin"] }, RESOURCE, ISSUER)).rejects.toThrow(/does not allow/);
    await expect(s.svc.decide("user1", base(id), { approve: true, teamId: "team1", scopes: ["read", "deploy"] }, RESOURCE, ISSUER)).rejects.toThrow(/does not allow: deploy/);
  });
  it("refuses a team the user is not in", async () => {
    const s = setup(null);
    const id = await registered(s);
    await expect(s.svc.decide("user1", base(id), { approve: true, teamId: "team1", scopes: ["read"] }, RESOURCE, ISSUER)).rejects.toThrow(/not a member/);
  });
  it("stores the code hashed and returns state and iss", async () => {
    const s = setup();
    const id = await registered(s);
    const { code, url } = await approveFor(s, id);
    expect(url.searchParams.get("state")).toBe("xyz");
    expect(url.searchParams.get("iss")).toBe(ISSUER);
    expect(s.db.oAuthCode[0].codeHash).toBe(hashToken(code));
    expect(JSON.stringify(s.db.oAuthCode)).not.toContain(code);
  });
});

describe("authorization code exchange", () => {
  it("issues a 1 h access token and a refresh token, stored only as hashes", async () => {
    const s = setup();
    const id = await registered(s);
    const { code } = await approveFor(s, id, ["read", "write"]);
    const t = await exchange(s, id, code);
    expect(t).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "read write" });
    expect(t.access_token.startsWith("tugra_oat_")).toBe(true);
    expect(t.refresh_token.startsWith("tugra_ort_")).toBe(true);
    const row = s.db.oAuthToken[0];
    expect(row.accessHash).toBe(hashToken(t.access_token));
    expect(row.refreshHash).toBe(hashToken(t.refresh_token));
    expect(JSON.stringify(s.db)).not.toContain(t.access_token);
    expect(JSON.stringify(s.db)).not.toContain(t.refresh_token);
    expect(row.accessExpiresAt.getTime() - Date.now()).toBeLessThanOrEqual(ACCESS_TTL_MS);
    expect(row.refreshExpiresAt.getTime() - Date.now()).toBeGreaterThan(REFRESH_TTL_MS - 5000);
  });
  it("a code is single-use, and replaying it revokes what it produced", async () => {
    const s = setup();
    const id = await registered(s);
    const { code } = await approveFor(s, id);
    const t = await exchange(s, id, code);
    await expect(exchange(s, id, code)).rejects.toMatchObject({ response: { error: "invalid_grant" } });
    expect(s.db.oAuthGrant).toHaveLength(0);
    await expect(s.svc.validateAccessToken(t.access_token)).resolves.toBeNull();
  });
  it("a code expires after 10 minutes", async () => {
    expect(CODE_TTL_MS).toBe(10 * 60_000);
    const s = setup();
    const id = await registered(s);
    const { code } = await approveFor(s, id);
    const row = s.db.oAuthCode[0];
    expect(row.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(CODE_TTL_MS);
    row.expiresAt = new Date(Date.now() - 1000);
    await expect(exchange(s, id, code)).rejects.toMatchObject({ response: { error: "invalid_grant" } });
    expect(s.db.oAuthGrant ?? []).toHaveLength(0);
  });
  it("a wrong PKCE verifier fails and burns the code", async () => {
    const s = setup();
    const id = await registered(s);
    const { code } = await approveFor(s, id);
    await expect(exchange(s, id, code, { code_verifier: "B".repeat(43) })).rejects.toMatchObject({ response: { error: "invalid_grant" } });
    await expect(exchange(s, id, code)).rejects.toMatchObject({ response: { error: "invalid_grant" } });
  });
  it("a missing verifier fails", async () => {
    const s = setup();
    const id = await registered(s);
    const { code } = await approveFor(s, id);
    await expect(s.svc.exchangeCode({ code, client_id: id, redirect_uri: REDIRECT })).rejects.toMatchObject({ response: { error: "invalid_grant" } });
  });
  it("requires the same redirect_uri and client_id as the authorization request", async () => {
    const s = setup();
    const id = await registered(s);
    const other = await registered(s);
    let { code } = await approveFor(s, id);
    await expect(exchange(s, id, code, { redirect_uri: "http://localhost:9999/callback" })).rejects.toMatchObject({ response: { error: "invalid_grant" } });
    ({ code } = await approveFor(s, id));
    await expect(exchange(s, other, code)).rejects.toMatchObject({ response: { error: "invalid_grant" } });
  });
  it("accepts a token request that leaves redirect_uri out", async () => {
    const s = setup();
    const id = await registered(s);
    const { code } = await approveFor(s, id);
    await expect(exchange(s, id, code, { redirect_uri: undefined as unknown as string })).resolves.toMatchObject({ token_type: "Bearer" });
  });
  it("fails when the user left the team between consent and exchange", async () => {
    const s = setup();
    const id = await registered(s);
    const { code } = await approveFor(s, id);
    s.state.perms = null;
    await expect(exchange(s, id, code)).rejects.toMatchObject({ response: { error: "invalid_grant" } });
  });
});

describe("refresh token rotation", () => {
  async function pair(s: ReturnType<typeof setup>) {
    const id = await registered(s);
    const { code } = await approveFor(s, id, ["read", "write"]);
    return { id, t: await exchange(s, id, code) };
  }

  it("rotates: a new pair is issued and the old refresh token is spent", async () => {
    const s = setup();
    const { id, t } = await pair(s);
    const t2 = await s.svc.refresh({ refresh_token: t.refresh_token, client_id: id });
    expect(t2.refresh_token).not.toBe(t.refresh_token);
    expect(t2.access_token).not.toBe(t.access_token);
    await expect(s.svc.validateAccessToken(t2.access_token)).resolves.toMatchObject({ userId: "user1", oauthTeamId: "team1" });
  });
  it("reusing a spent refresh token revokes the whole family", async () => {
    const s = setup();
    const { id, t } = await pair(s);
    const t2 = await s.svc.refresh({ refresh_token: t.refresh_token, client_id: id });
    await expect(s.svc.refresh({ refresh_token: t.refresh_token, client_id: id })).rejects.toMatchObject({ response: { error: "invalid_grant" } });
    expect(s.db.oAuthGrant).toHaveLength(0);
    expect(s.db.oAuthToken).toHaveLength(0);
    await expect(s.svc.refresh({ refresh_token: t2.refresh_token, client_id: id })).rejects.toMatchObject({ response: { error: "invalid_grant" } });
    await expect(s.svc.validateAccessToken(t2.access_token)).resolves.toBeNull();
    expect(s.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "oauth.refresh_reuse" }));
  });
  it("an expired refresh token is refused", async () => {
    const s = setup();
    const { id, t } = await pair(s);
    s.db.oAuthToken[0].refreshExpiresAt = new Date(Date.now() - 1000);
    await expect(s.svc.refresh({ refresh_token: t.refresh_token, client_id: id })).rejects.toMatchObject({ response: { error: "invalid_grant" } });
  });
  it("a refresh token cannot be used by another client", async () => {
    const s = setup();
    const { t } = await pair(s);
    const other = await registered(s);
    await expect(s.svc.refresh({ refresh_token: t.refresh_token, client_id: other })).rejects.toMatchObject({ response: { error: "invalid_grant" } });
    expect(s.db.oAuthGrant).toHaveLength(1);
  });
  it("kills the grant when the user is no longer in the team", async () => {
    const s = setup();
    const { id, t } = await pair(s);
    s.state.perms = null;
    await expect(s.svc.refresh({ refresh_token: t.refresh_token, client_id: id })).rejects.toMatchObject({ response: { error: "invalid_grant" } });
    expect(s.db.oAuthGrant).toHaveLength(0);
  });
});

describe("access tokens never exceed the user's role", () => {
  it("clamps granted scopes to the member's current permissions", async () => {
    const s = setup();
    const id = await registered(s);
    const { code } = await approveFor(s, id, ["read", "write", "deploy", "admin"]);
    const t = await exchange(s, id, code);
    await expect(s.svc.validateAccessToken(t.access_token)).resolves.toMatchObject({ scopes: ["read", "write", "deploy", "admin"] });
    s.state.perms = ["monitors"]; // demoted to a role that can configure monitors only
    const u = await s.svc.validateAccessToken(t.access_token);
    expect(u?.scopes).toEqual(["read", "write"]);
    s.state.perms = []; // viewer
    expect((await s.svc.validateAccessToken(t.access_token))?.scopes).toEqual(["read"]);
  });
  it("stops working when the user leaves the team", async () => {
    const s = setup();
    const id = await registered(s);
    const { code } = await approveFor(s, id);
    const t = await exchange(s, id, code);
    s.state.perms = null;
    await expect(s.svc.validateAccessToken(t.access_token)).resolves.toBeNull();
  });
  it("an expired access token is refused", async () => {
    const s = setup();
    const id = await registered(s);
    const { code } = await approveFor(s, id);
    const t = await exchange(s, id, code);
    s.db.oAuthToken[0].accessExpiresAt = new Date(Date.now() - 1);
    await expect(s.svc.validateAccessToken(t.access_token)).resolves.toBeNull();
  });
  it("an unknown token is refused", async () => {
    await expect(setup().svc.validateAccessToken("tugra_oat_nope")).resolves.toBeNull();
  });
});

describe("revocation and connected clients", () => {
  it("the revocation endpoint kills the grant by access or refresh token, and is silent about unknown tokens", async () => {
    const s = setup();
    const id = await registered(s);
    const { code } = await approveFor(s, id);
    const t = await exchange(s, id, code);
    await expect(s.svc.revokeToken("tugra_ort_unknown", id)).resolves.toBeUndefined();
    expect(s.db.oAuthGrant).toHaveLength(1);
    await s.svc.revokeToken(t.refresh_token, id);
    expect(s.db.oAuthGrant).toHaveLength(0);
    await expect(s.svc.validateAccessToken(t.access_token)).resolves.toBeNull();
  });
  it("another client cannot revoke someone else's token", async () => {
    const s = setup();
    const id = await registered(s);
    const other = await registered(s);
    const { code } = await approveFor(s, id);
    const t = await exchange(s, id, code);
    await s.svc.revokeToken(t.access_token, other);
    expect(s.db.oAuthGrant).toHaveLength(1);
  });
  it("lists a user's connections and revokes one", async () => {
    const s = setup();
    const id = await registered(s);
    const { code } = await approveFor(s, id, ["read", "deploy"]);
    const t = await exchange(s, id, code);
    s.db.oAuthGrant[0].client = { name: "Test client" };
    const prismaList = (s.svc as any).prisma.oAuthGrant;
    prismaList.findMany = async () => s.db.oAuthGrant.map((g) => ({ ...g, client: { name: "Test client" }, tokens: s.db.oAuthToken.filter((x) => x.grantId === g.id).map((x) => ({ id: x.id })) }));
    const list = await s.svc.listGrants("user1");
    expect(list).toEqual([expect.objectContaining({ clientName: "Test client", teamName: "Acme", scopes: ["read", "deploy"] })]);
    await s.svc.revokeGrant("user1", list[0].id);
    await expect(s.svc.validateAccessToken(t.access_token)).resolves.toBeNull();
    await expect(s.svc.revokeGrant("user1", list[0].id)).rejects.toThrow(/not found/);
  });
  it("keeps a grant that has no token yet instead of sweeping it from the list", async () => {
    const s = setup();
    const grants = (s.svc as any).prisma.oAuthGrant;
    const fresh = { id: "g1", clientId: "c", userId: "user1", teamId: "team1", scopes: ["read"], createdAt: new Date(), lastUsedAt: null, client: { name: "C" }, tokens: [] };
    const old = { ...fresh, id: "g2", createdAt: new Date(Date.now() - 3600_000) };
    grants.findMany = async () => [fresh, old];
    grants.deleteMany = jest.fn(async () => ({ count: 1 }));
    const list = await s.svc.listGrants("user1");
    expect(list.map((g) => g.id)).toEqual(["g1"]);
    expect(grants.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["g2"] } } });
  });
  it("cannot revoke another user's connection", async () => {
    const s = setup();
    const id = await registered(s);
    const { code } = await approveFor(s, id);
    await exchange(s, id, code);
    await expect(s.svc.revokeGrant("someone-else", s.db.oAuthGrant[0].id)).rejects.toThrow(/not found/);
    expect(s.db.oAuthGrant).toHaveLength(1);
  });
});
