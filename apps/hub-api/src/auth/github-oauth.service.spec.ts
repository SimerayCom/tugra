import { createHash } from "node:crypto";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { GithubOAuthService } from "./github-oauth.service";
import { AuthService } from "./auth.service";

const SECRET = "access-secret-aaaaaaaaaaaa";

function makeConfig(overrides: Record<string, string | undefined> = {}): ConfigService {
  const vals: Record<string, string | undefined> = {
    GITHUB_OAUTH_CLIENT_ID: "client123",
    GITHUB_OAUTH_CLIENT_SECRET: "secret456",
    JWT_ACCESS_SECRET: SECRET,
    HUB_PUBLIC_URL: "http://localhost:3000",
    ...overrides,
  };
  return { get: (k: string) => vals[k] } as unknown as ConfigService;
}

const jwt = new JwtService({});

function make(config = makeConfig()) {
  const auth = { loginWithGithub: jest.fn().mockResolvedValue({ accessToken: "at", refreshToken: "rt" }) } as unknown as AuthService;
  return { svc: new GithubOAuthService(config, jwt, auth), auth };
}

function mockFetch(handlers: Record<string, unknown>) {
  global.fetch = jest.fn(async (url: unknown) => {
    const key = Object.keys(handlers).find((k) => String(url).includes(k));
    return { json: async () => handlers[key!] } as Response;
  }) as unknown as typeof fetch;
}

const NONCE = "browser-nonce-abc";
const bind = (n: string) => createHash("sha256").update(n).digest("base64url");

/** A state exactly as begin() would mint it for a browser holding `nonce`. */
async function freshState(nonce = NONCE): Promise<string> {
  return jwt.signAsync({ type: "oauth_state", bnd: bind(nonce) }, { secret: SECRET, expiresIn: "10m" });
}

describe("GithubOAuthService", () => {
  it("reports configured only when both client id and secret are present", () => {
    expect(make().svc.isConfigured()).toBe(true);
    expect(make(makeConfig({ GITHUB_OAUTH_CLIENT_SECRET: undefined })).svc.isConfigured()).toBe(false);
  });

  it("builds an authorize URL with client_id, redirect_uri, scope and a verifiable state", async () => {
    const { url, nonce } = await make().svc.begin();
    expect(nonce.length).toBeGreaterThan(20);
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(u.searchParams.get("client_id")).toBe("client123");
    expect(u.searchParams.get("redirect_uri")).toBe("http://localhost:3001/api/auth/oauth/github/callback");
    expect(u.searchParams.get("scope")).toBe("read:user user:email");
    const state = u.searchParams.get("state")!;
    const payload = await jwt.verifyAsync(state, { secret: SECRET });
    expect(payload).toMatchObject({ type: "oauth_state", bnd: bind(nonce) });
    // The cookie nonce itself never travels in the (GitHub-visible) state.
    expect(state).not.toContain(nonce);
    expect(JSON.stringify(payload)).not.toContain(nonce);
  });

  it("mints a fresh nonce per login", async () => {
    const svc = make().svc;
    expect((await svc.begin()).nonce).not.toBe((await svc.begin()).nonce);
  });

  describe("redirect URI per topology", () => {
    const uri = (o: Record<string, string | undefined>) => make(makeConfig(o)).svc.redirectUri();

    it("single origin (--domain): the hub's own /auth/oauth/github/callback, unchanged", () => {
      expect(uri({ HUB_PUBLIC_URL: "https://panel.example.com", WEB_PUBLIC_URL: "https://panel.example.com" })).toBe(
        "https://panel.example.com/auth/oauth/github/callback",
      );
      // trailing slashes don't make the origins look different
      expect(uri({ HUB_PUBLIC_URL: "https://panel.example.com/", WEB_PUBLIC_URL: "https://panel.example.com" })).toBe(
        "https://panel.example.com/auth/oauth/github/callback",
      );
    });

    it("raw two-port install (http, IP, different ports): the callback is served by the WEB origin's /api proxy", () => {
      expect(uri({ HUB_PUBLIC_URL: "http://203.0.113.7:3000", WEB_PUBLIC_URL: "http://203.0.113.7:3001" })).toBe(
        "http://203.0.113.7:3001/api/auth/oauth/github/callback",
      );
    });

    it("split hosts: still the web origin, so the whole login stays on the origin the panel uses", () => {
      expect(uri({ HUB_PUBLIC_URL: "https://hub.example.com", WEB_PUBLIC_URL: "https://app.example.com" })).toBe(
        "https://app.example.com/api/auth/oauth/github/callback",
      );
    });

    it("an explicit GITHUB_OAUTH_CALLBACK_URL wins in every topology", () => {
      expect(
        uri({
          HUB_PUBLIC_URL: "http://203.0.113.7:3000",
          WEB_PUBLIC_URL: "http://203.0.113.7:3001",
          GITHUB_OAUTH_CALLBACK_URL: "https://login.example.com/cb",
        }),
      ).toBe("https://login.example.com/cb");
    });

    it("authorizeUrl and the token exchange use the same redirect_uri (GitHub requires they match)", async () => {
      const cfg = makeConfig({ HUB_PUBLIC_URL: "http://203.0.113.7:3000", WEB_PUBLIC_URL: "http://203.0.113.7:3001" });
      const { svc } = make(cfg);
      const authUri = new URL((await svc.begin()).url).searchParams.get("redirect_uri");
      let exchanged = "";
      global.fetch = jest.fn(async (url: unknown, init?: RequestInit) => {
        if (String(url).includes("access_token")) exchanged = JSON.parse(String(init?.body)).redirect_uri;
        return { json: async () => ({ access_token: "t", login: "x", name: "x" }) } as Response;
      }) as unknown as typeof fetch;
      await svc.handleCallback("c", await freshState(), NONCE).catch(() => undefined);
      expect(exchanged).toBe(authUri);
    });
  });

  it("exchanges a code, picks the primary verified email, and logs in", async () => {
    mockFetch({
      access_token: { access_token: "ghtok" },
      "user/emails": [
        { email: "secondary@x.io", primary: false, verified: true },
        { email: "jane@x.io", primary: true, verified: true },
      ],
      "/user": { name: "Jane Doe", login: "jane" },
    });
    const { svc, auth } = make();
    const pair = await svc.handleCallback("code123", await freshState(), NONCE);
    expect(auth.loginWithGithub).toHaveBeenCalledWith("jane@x.io", "Jane Doe");
    expect(pair).toEqual({ accessToken: "at", refreshToken: "rt" });
  });

  it("rejects when GitHub returns no verified email", async () => {
    mockFetch({
      access_token: { access_token: "ghtok" },
      "user/emails": [{ email: "jane@x.io", primary: true, verified: false }],
      "/user": { login: "jane" },
    });
    await expect(make().svc.handleCallback("code123", await freshState(), NONCE)).rejects.toThrow(/verified/);
  });

  it("rejects a tampered/invalid state", async () => {
    await expect(make().svc.handleCallback("code123", "not-a-valid-state", NONCE)).rejects.toThrow(/state/);
  });

  describe("state is bound to the browser", () => {
    it("rejects a valid state when the browser sent no binding cookie", async () => {
      mockFetch({});
      await expect(make().svc.handleCallback("code123", await freshState(), undefined)).rejects.toThrow(/state/);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("rejects a valid state replayed with a different browser's nonce", async () => {
      mockFetch({});
      await expect(make().svc.handleCallback("code123", await freshState(), "someone-else")).rejects.toThrow(/state/);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("rejects an unbound legacy state (no bnd claim)", async () => {
      mockFetch({});
      const legacy = await jwt.signAsync({ type: "oauth_state" }, { secret: SECRET, expiresIn: "10m" });
      await expect(make().svc.handleCallback("code123", legacy, NONCE)).rejects.toThrow(/state/);
    });

    it("rejects a state of the wrong type or signed with another secret", async () => {
      mockFetch({});
      const wrongType = await jwt.signAsync({ type: "access", bnd: bind(NONCE) }, { secret: SECRET, expiresIn: "10m" });
      const wrongKey = await jwt.signAsync({ type: "oauth_state", bnd: bind(NONCE) }, { secret: "other-secret-bbbbbbbbbb", expiresIn: "10m" });
      await expect(make().svc.handleCallback("c", wrongType, NONCE)).rejects.toThrow(/state/);
      await expect(make().svc.handleCallback("c", wrongKey, NONCE)).rejects.toThrow(/state/);
    });

    it("round-trips begin() -> handleCallback() with the nonce begin() returned", async () => {
      mockFetch({
        access_token: { access_token: "ghtok" },
        "user/emails": [{ email: "jane@x.io", primary: true, verified: true }],
        "/user": { login: "jane" },
      });
      const { svc } = make();
      const { url, nonce } = await svc.begin();
      const state = new URL(url).searchParams.get("state")!;
      await expect(svc.handleCallback("code123", state, nonce)).resolves.toEqual({ accessToken: "at", refreshToken: "rt" });
    });
  });
});
