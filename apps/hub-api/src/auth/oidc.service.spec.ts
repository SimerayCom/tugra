import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { OidcService } from "./oidc.service";
import { AuthService } from "./auth.service";
import { InstanceSettingsService } from "../instance/instance-settings.service";
import { CryptoService } from "../crypto/crypto.service";
import * as edition from "../common/edition";

// jose is ESM-flavoured; mocking it keeps the id_token verification deterministic and avoids loading
// the real library in the jest (CommonJS) runtime.
jest.mock("jose", () => ({
  createRemoteJWKSet: jest.fn(() => "JWKS_GETTER"),
  jwtVerify: jest.fn(),
}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
import { jwtVerify } from "jose";
const mockJwtVerify = jwtVerify as unknown as jest.Mock;

// The SSRF guard does real DNS resolution (tested in safe-url's own spec); mock it here so the service
// tests are offline+deterministic. Default: every endpoint resolves safe; a test overrides it to block.
jest.mock("../notifications/safe-url", () => ({
  assertSafeUrl: jest.fn().mockResolvedValue(undefined),
  allowPrivateTargets: jest.fn(() => false),
}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
import { assertSafeUrl } from "../notifications/safe-url";
const mockAssertSafeUrl = assertSafeUrl as jest.Mock;

const SECRET = "access-secret-aaaaaaaaaaaa";
const ISSUER = "https://idp.example.com";
const DISCOVERY = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  jwks_uri: `${ISSUER}/jwks`,
  userinfo_endpoint: `${ISSUER}/userinfo`,
};

function makeConfig(overrides: Record<string, string | undefined> = {}): ConfigService {
  const vals: Record<string, string | undefined> = { JWT_ACCESS_SECRET: SECRET, HUB_PUBLIC_URL: "http://localhost:3000", ...overrides };
  return { get: (k: string) => vals[k] } as unknown as ConfigService;
}

const jwt = new JwtService({});

interface SettingsOver {
  oidcEnabled?: boolean;
  oidcIssuer?: string | null;
  oidcClientId?: string | null;
  oidcClientSecretEnc?: string | null;
  oidcAllowedDomains?: string[];
}
function mkSettings(over: SettingsOver = {}) {
  return {
    id: "singleton",
    oidcEnabled: true,
    oidcIssuer: ISSUER,
    oidcClientId: "cid",
    oidcClientSecretEnc: "ENC",
    oidcAllowedDomains: [],
    ...over,
  };
}

function make(settingsOver: SettingsOver = {}, config = makeConfig()) {
  const settings = { get: jest.fn().mockResolvedValue(mkSettings(settingsOver)) } as unknown as InstanceSettingsService;
  const crypto = { decrypt: jest.fn().mockReturnValue("clientsecret") } as unknown as CryptoService;
  const auth = { loginWithOidc: jest.fn().mockResolvedValue({ accessToken: "at", refreshToken: "rt" }) } as unknown as AuthService;
  return { svc: new OidcService(config, jwt, auth, settings, crypto), auth, crypto, settings };
}

function mockFetch(handlers: Record<string, unknown>) {
  global.fetch = jest.fn(async (url: unknown) => {
    const key = Object.keys(handlers).find((k) => String(url).includes(k));
    if (key === undefined) return { ok: false, status: 404, json: async () => ({}) } as Response;
    return { ok: true, json: async () => handlers[key] } as Response;
  }) as unknown as typeof fetch;
}

/** A state token the way authorizeUrl mints it. */
function stateWith(nonce: string): Promise<string> {
  return jwt.signAsync({ type: "oidc_state", nonce }, { secret: SECRET, expiresIn: "10m" });
}

describe("OidcService", () => {
  beforeEach(() => {
    jest.spyOn(edition, "currentEdition").mockReturnValue("pro");
    mockJwtVerify.mockReset();
    mockAssertSafeUrl.mockReset().mockResolvedValue(undefined);
    mockFetch({ ".well-known/openid-configuration": DISCOVERY });
  });

  describe("isConfigured", () => {
    it("is true only on a Pro+ edition with issuer, clientId and secret set", async () => {
      await expect(make().svc.isConfigured()).resolves.toBe(true);
      await expect(make({ oidcEnabled: false }).svc.isConfigured()).resolves.toBe(false);
      await expect(make({ oidcClientSecretEnc: null }).svc.isConfigured()).resolves.toBe(false);
      await expect(make({ oidcIssuer: null }).svc.isConfigured()).resolves.toBe(false);
    });

    it("is false when the edition is below pro even if fully configured (downgrade soft-disables SSO)", async () => {
      jest.spyOn(edition, "currentEdition").mockReturnValue("community");
      await expect(make().svc.isConfigured()).resolves.toBe(false);
    });
  });

  describe("authorizeUrl", () => {
    it("builds the IdP authorize URL with a state JWT whose nonce matches the URL nonce", async () => {
      const url = await make().svc.authorizeUrl();
      const u = new URL(url);
      expect(u.origin + u.pathname).toBe(`${ISSUER}/authorize`);
      expect(u.searchParams.get("client_id")).toBe("cid");
      expect(u.searchParams.get("redirect_uri")).toBe("http://localhost:3000/auth/oidc/callback");
      expect(u.searchParams.get("response_type")).toBe("code");
      expect(u.searchParams.get("scope")).toBe("openid email profile");
      const urlNonce = u.searchParams.get("nonce")!;
      const state = u.searchParams.get("state")!;
      const payload = await jwt.verifyAsync<{ type: string; nonce: string }>(state, { secret: SECRET });
      expect(payload.type).toBe("oidc_state");
      expect(payload.nonce).toBe(urlNonce); // the nonce is bound in the signed state, not just the URL
    });

    it("caches the discovery document across calls (no re-fetch)", async () => {
      const { svc } = make();
      await svc.authorizeUrl();
      await svc.authorizeUrl();
      expect(global.fetch).toHaveBeenCalledTimes(1); // discovery fetched once, then served from cache
    });
  });

  describe("handleCallback", () => {
    it("exchanges the code, verifies the id_token + nonce, and logs in via loginWithOidc", async () => {
      mockFetch({ ".well-known/openid-configuration": DISCOVERY, "/token": { id_token: "IDT", access_token: "AT" } });
      mockJwtVerify.mockResolvedValue({ payload: { nonce: "N1", email: "jane@corp.io", name: "Jane" } });
      const { svc, auth, crypto } = make({ oidcAllowedDomains: ["corp.io"] });
      const pair = await svc.handleCallback("code123", await stateWith("N1"));
      expect(crypto.decrypt).toHaveBeenCalledWith("ENC"); // client secret decrypted only here
      expect(mockJwtVerify).toHaveBeenCalledWith("IDT", "JWKS_GETTER", { issuer: ISSUER, audience: "cid" });
      expect(auth.loginWithOidc).toHaveBeenCalledWith("jane@corp.io", "Jane", ["corp.io"]);
      expect(pair).toEqual({ accessToken: "at", refreshToken: "rt" });
    });

    it("rejects a tampered/invalid state", async () => {
      await expect(make().svc.handleCallback("code123", "not-a-valid-state")).rejects.toThrow(/state/);
    });

    it("rejects when the id_token nonce does not match the state nonce (replay)", async () => {
      mockFetch({ ".well-known/openid-configuration": DISCOVERY, "/token": { id_token: "IDT" } });
      mockJwtVerify.mockResolvedValue({ payload: { nonce: "OTHER", email: "jane@corp.io" } });
      await expect(make().svc.handleCallback("code123", await stateWith("N1"))).rejects.toThrow(/nonce/);
    });

    it("rejects when signature verification fails", async () => {
      mockFetch({ ".well-known/openid-configuration": DISCOVERY, "/token": { id_token: "IDT" } });
      mockJwtVerify.mockRejectedValue(new Error("bad signature"));
      await expect(make().svc.handleCallback("code123", await stateWith("N1"))).rejects.toThrow(/verification/);
    });

    it("falls back to the userinfo endpoint when the id_token omits email", async () => {
      mockFetch({
        ".well-known/openid-configuration": DISCOVERY,
        "/token": { id_token: "IDT", access_token: "AT" },
        "/userinfo": { email: "bob@corp.io", name: "Bob" },
      });
      mockJwtVerify.mockResolvedValue({ payload: { nonce: "N1" } }); // no email claim
      const { svc, auth } = make();
      await svc.handleCallback("code123", await stateWith("N1"));
      expect(auth.loginWithOidc).toHaveBeenCalledWith("bob@corp.io", "Bob", []);
    });

    it("rejects when email_verified is explicitly false", async () => {
      mockFetch({ ".well-known/openid-configuration": DISCOVERY, "/token": { id_token: "IDT" } });
      mockJwtVerify.mockResolvedValue({ payload: { nonce: "N1", email: "jane@corp.io", email_verified: false } });
      await expect(make().svc.handleCallback("code123", await stateWith("N1"))).rejects.toThrow(/not verified/);
    });

    it("rejects an in-flight callback once SSO has been disabled (state still valid, but isConfigured=false)", async () => {
      const { svc } = make({ oidcEnabled: false });
      await expect(svc.handleCallback("code123", await stateWith("N1"))).rejects.toThrow(/not enabled/);
    });

    it("rejects a discovery document whose endpoint points at a blocked (internal/metadata) address", async () => {
      mockFetch({
        ".well-known/openid-configuration": { ...DISCOVERY, token_endpoint: "http://169.254.169.254/token" },
        "169.254.169.254/token": { id_token: "IDT" },
      });
      // The SSRF guard blocks the internal token endpoint declared by the (untrusted) discovery document.
      mockAssertSafeUrl.mockImplementation(async (url: string) => {
        if (url.includes("169.254.169.254")) throw new Error("blocked address");
      });
      await expect(make().svc.handleCallback("code123", await stateWith("N1"))).rejects.toThrow(/endpoint is not allowed/);
    });
  });
});
