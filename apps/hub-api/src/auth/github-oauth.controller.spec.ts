import { ForbiddenException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { GithubOAuthController } from "./github-oauth.controller";
import { GithubOAuthService } from "./github-oauth.service";
import { AuthService } from "./auth.service";
import { TG_ACCESS, TG_CSRF, TG_OAUTH_STATE, TG_REFRESH } from "../common/cookies";

const SECRET = "access-secret-aaaaaaaaaaaa";

interface Captured {
  set: { name: string; value: string; options: Record<string, unknown> }[];
  cleared: { name: string; options?: Record<string, unknown> }[];
  redirectedTo?: string;
}

function mockRes() {
  const cap: Captured = { set: [], cleared: [] };
  const res = {
    cookie: (name: string, value: string, options: Record<string, unknown>) => cap.set.push({ name, value, options }),
    clearCookie: (name: string, options?: Record<string, unknown>) => cap.cleared.push({ name, options }),
    redirect: (url: string) => {
      cap.redirectedTo = url;
    },
  };
  return { res, cap };
}

/** Wire the real service + controller around a config for the given topology. */
function build(env: Record<string, string>, auth?: Partial<AuthService>) {
  const vals: Record<string, string | undefined> = {
    GITHUB_OAUTH_CLIENT_ID: "cid",
    GITHUB_OAUTH_CLIENT_SECRET: "csec",
    JWT_ACCESS_SECRET: SECRET,
    ...env,
  };
  const config = { get: (k: string) => vals[k] } as unknown as ConfigService;
  const authSvc = {
    loginWithGithub: jest.fn().mockResolvedValue({ accessToken: "AT", refreshToken: "RT" }),
    ...auth,
  } as unknown as AuthService;
  const svc = new GithubOAuthService(config, new JwtService({}), authSvc);
  return { ctl: new GithubOAuthController(svc, config), authSvc };
}

function mockGithub() {
  global.fetch = jest.fn(async (url: unknown) => {
    const u = String(url);
    const body = u.includes("access_token")
      ? { access_token: "ghtok" }
      : u.includes("user/emails")
        ? [{ email: "jane@x.io", primary: true, verified: true }]
        : { login: "jane" };
    return { json: async () => body } as Response;
  }) as unknown as typeof fetch;
}

const TOPOLOGIES = {
  "raw two-port install (http, IP, hub :3000 / web :3001, COOKIE_SECURE=false)": {
    env: { HUB_PUBLIC_URL: "http://203.0.113.7:3000", WEB_PUBLIC_URL: "http://203.0.113.7:3001" },
    cookieSecure: "false",
    web: "http://203.0.113.7:3001",
    callback: "http://203.0.113.7:3001/api/auth/oauth/github/callback",
  },
  "single-origin HTTPS proxy (--domain, COOKIE_SECURE=true)": {
    env: { HUB_PUBLIC_URL: "https://panel.example.com", WEB_PUBLIC_URL: "https://panel.example.com" },
    cookieSecure: "true",
    web: "https://panel.example.com",
    callback: "https://panel.example.com/auth/oauth/github/callback",
  },
} as const;

describe("GithubOAuthController", () => {
  const saved = process.env.COOKIE_SECURE;
  afterEach(() => {
    if (saved === undefined) delete process.env.COOKIE_SECURE;
    else process.env.COOKIE_SECURE = saved;
  });

  describe.each(Object.entries(TOPOLOGIES))("%s", (_name, topo) => {
    beforeEach(() => {
      process.env.COOKIE_SECURE = topo.cookieSecure;
      mockGithub();
    });

    it("start: sets the httpOnly state-binding cookie and redirects to GitHub with the topology's callback URL", async () => {
      const { ctl } = build(topo.env);
      const { res, cap } = mockRes();
      await ctl.start(res);

      const bind = cap.set.find((c) => c.name === TG_OAUTH_STATE)!;
      expect(bind.options).toMatchObject({
        httpOnly: true,
        sameSite: "lax",
        secure: topo.cookieSecure === "true",
      });
      const loc = new URL(cap.redirectedTo!);
      expect(loc.host).toBe("github.com");
      expect(loc.searchParams.get("redirect_uri")).toBe(topo.callback);
    });

    it("callback: with the matching cookie it sets session cookies (same Secure policy), clears the binding, redirects to the SPA", async () => {
      const { ctl, authSvc } = build(topo.env);
      const start = mockRes();
      await ctl.start(start.res);
      const state = new URL(start.cap.redirectedTo!).searchParams.get("state")!;
      const nonce = start.cap.set.find((c) => c.name === TG_OAUTH_STATE)!.value;

      const { res, cap } = mockRes();
      await ctl.callback("code1", state, { headers: { cookie: `${TG_OAUTH_STATE}=${nonce}` } }, res);

      expect(authSvc.loginWithGithub).toHaveBeenCalledWith("jane@x.io", "jane");
      expect(cap.redirectedTo).toBe(`${topo.web}/oauth/callback`);
      for (const name of [TG_ACCESS, TG_REFRESH, TG_CSRF]) {
        const c = cap.set.find((x) => x.name === name)!;
        expect(c.options.secure).toBe(topo.cookieSecure === "true");
        expect(c.options.path).toBe("/");
      }
      expect(cap.cleared.map((c) => c.name)).toContain(TG_OAUTH_STATE);
    });

    it("callback: a valid state WITHOUT the browser's cookie is rejected - no session, error redirect, GitHub never called", async () => {
      const { ctl, authSvc } = build(topo.env);
      const start = mockRes();
      await ctl.start(start.res);
      const state = new URL(start.cap.redirectedTo!).searchParams.get("state")!;

      const { res, cap } = mockRes();
      await ctl.callback("code1", state, { headers: {} }, res);

      expect(cap.redirectedTo).toBe(`${topo.web}/login?error=oauth`);
      expect(cap.set).toHaveLength(0);
      expect(authSvc.loginWithGithub).not.toHaveBeenCalled();
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("callback: a state bound to another browser (different cookie) is rejected", async () => {
      const { ctl, authSvc } = build(topo.env);
      const start = mockRes();
      await ctl.start(start.res);
      const state = new URL(start.cap.redirectedTo!).searchParams.get("state")!;

      const { res, cap } = mockRes();
      await ctl.callback("code1", state, { headers: { cookie: `${TG_OAUTH_STATE}=attacker-nonce` } }, res);

      expect(cap.redirectedTo).toBe(`${topo.web}/login?error=oauth`);
      expect(authSvc.loginWithGithub).not.toHaveBeenCalled();
    });

    it("callback: a gated new user still gets the registration_disabled reason, and the binding cookie is cleared", async () => {
      const { ctl } = build(topo.env, {
        loginWithGithub: jest.fn().mockRejectedValue(new ForbiddenException("registration disabled")),
      } as Partial<AuthService>);
      const start = mockRes();
      await ctl.start(start.res);
      const state = new URL(start.cap.redirectedTo!).searchParams.get("state")!;
      const nonce = start.cap.set.find((c) => c.name === TG_OAUTH_STATE)!.value;

      const { res, cap } = mockRes();
      await ctl.callback("code1", state, { headers: { cookie: `${TG_OAUTH_STATE}=${nonce}` } }, res);
      expect(cap.redirectedTo).toBe(`${topo.web}/login?error=registration_disabled`);
      expect(cap.cleared.map((c) => c.name)).toContain(TG_OAUTH_STATE);
    });
  });

  it("start: unconfigured redirects to the login page without setting a cookie", async () => {
    const { ctl } = build({ GITHUB_OAUTH_CLIENT_ID: "", WEB_PUBLIC_URL: "http://203.0.113.7:3001" });
    const { res, cap } = mockRes();
    await ctl.start(res);
    expect(cap.redirectedTo).toBe("http://203.0.113.7:3001/login?error=oauth_unconfigured");
    expect(cap.set).toHaveLength(0);
  });
});
