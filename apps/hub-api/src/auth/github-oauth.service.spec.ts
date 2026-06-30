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

async function freshState(): Promise<string> {
  return jwt.signAsync({ type: "oauth_state" }, { secret: SECRET, expiresIn: "10m" });
}

describe("GithubOAuthService", () => {
  it("reports configured only when both client id and secret are present", () => {
    expect(make().svc.isConfigured()).toBe(true);
    expect(make(makeConfig({ GITHUB_OAUTH_CLIENT_SECRET: undefined })).svc.isConfigured()).toBe(false);
  });

  it("builds an authorize URL with client_id, redirect_uri, scope and a verifiable state", async () => {
    const url = await make().svc.authorizeUrl();
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(u.searchParams.get("client_id")).toBe("client123");
    expect(u.searchParams.get("redirect_uri")).toBe("http://localhost:3000/auth/oauth/github/callback");
    expect(u.searchParams.get("scope")).toBe("read:user user:email");
    const state = u.searchParams.get("state")!;
    await expect(jwt.verifyAsync(state, { secret: SECRET })).resolves.toMatchObject({ type: "oauth_state" });
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
    const pair = await svc.handleCallback("code123", await freshState());
    expect(auth.loginWithGithub).toHaveBeenCalledWith("jane@x.io", "Jane Doe");
    expect(pair).toEqual({ accessToken: "at", refreshToken: "rt" });
  });

  it("rejects when GitHub returns no verified email", async () => {
    mockFetch({
      access_token: { access_token: "ghtok" },
      "user/emails": [{ email: "jane@x.io", primary: true, verified: false }],
      "/user": { login: "jane" },
    });
    await expect(make().svc.handleCallback("code123", await freshState())).rejects.toThrow(/verified/);
  });

  it("rejects a tampered/invalid state", async () => {
    await expect(make().svc.handleCallback("code123", "not-a-valid-state")).rejects.toThrow(/state/);
  });
});
