import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { BadRequestException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { AuthService, type TokenPair } from "./auth.service";

const GH_AUTHORIZE = "https://github.com/login/oauth/authorize";
const GH_TOKEN = "https://github.com/login/oauth/access_token";
const GH_USER = "https://api.github.com/user";
const GH_EMAILS = "https://api.github.com/user/emails";

interface GithubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}

/** Origin of a URL, or "" when it is not a parseable URL. */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

/** What the signed state carries for a browser nonce (a hash, so the cookie value never reaches GitHub). */
function bindNonce(nonce: string): string {
  return createHash("sha256").update(nonce).digest("base64url");
}

/** GitHub OAuth: build the authorize URL and turn a callback code into Tugra tokens. */
@Injectable()
export class GithubOAuthService {
  constructor(
    private readonly config: ConfigService,
    private readonly jwt: JwtService,
    private readonly auth: AuthService,
  ) {}

  isConfigured(): boolean {
    return (
      !!this.config.get<string>("GITHUB_OAUTH_CLIENT_ID") &&
      !!this.config.get<string>("GITHUB_OAUTH_CLIENT_SECRET")
    );
  }

  /**
   * The callback URL registered in the GitHub OAuth app. Resolution:
   *  1. GITHUB_OAUTH_CALLBACK_URL, when set (escape hatch for unusual proxy layouts).
   *  2. Single origin (hub and web share one public origin, the `--domain` proxy setup): the hub's own
   *     `<origin>/auth/oauth/github/callback`, which the proxy routes to the hub (unchanged).
   *  3. Split origins (the raw install: web and hub on different ports/hosts): the callback is served by the
   *     WEB origin at `/api/auth/oauth/github/callback`, which the web's same-origin proxy forwards to the hub.
   *     That keeps the whole login (state cookie, session cookies, redirect) on the one origin the browser
   *     uses for the panel, so it no longer depends on the hub port/host being the cookie-visible one.
   */
  redirectUri(): string {
    const override = this.config.get<string>("GITHUB_OAUTH_CALLBACK_URL");
    if (override) return override;
    const hub = (this.config.get<string>("HUB_PUBLIC_URL") ?? "http://localhost:3000").replace(/\/$/, "");
    const web = (this.config.get<string>("WEB_PUBLIC_URL") ?? "http://localhost:3001").replace(/\/$/, "");
    const hubOrigin = originOf(hub);
    const webOrigin = originOf(web);
    if (!webOrigin || hubOrigin === webOrigin) return `${hub}/auth/oauth/github/callback`;
    return `${webOrigin}/api/auth/oauth/github/callback`;
  }

  /**
   * Start a login: a short-lived signed `state` that embeds a hash of a random browser nonce. The nonce
   * itself goes to the caller to be set as an httpOnly cookie, so the callback proves it came back in the
   * SAME browser (a bare signed JWT alone would let an attacker feed a victim a valid state/code pair).
   */
  async begin(): Promise<{ url: string; nonce: string }> {
    const nonce = randomBytes(32).toString("base64url");
    const state = await this.jwt.signAsync(
      { type: "oauth_state", bnd: bindNonce(nonce) },
      { secret: this.config.get<string>("JWT_ACCESS_SECRET"), expiresIn: "10m" },
    );
    const params = new URLSearchParams({
      client_id: this.config.get<string>("GITHUB_OAUTH_CLIENT_ID")!,
      redirect_uri: this.redirectUri(),
      scope: "read:user user:email",
      state,
    });
    return { url: `${GH_AUTHORIZE}?${params.toString()}`, nonce };
  }

  /** `nonce` is the value of the browser's state-binding cookie (undefined when the browser sent none). */
  async handleCallback(code: string, state: string, nonce: string | undefined): Promise<TokenPair> {
    try {
      const payload = await this.jwt.verifyAsync<{ type?: string; bnd?: string }>(state, {
        secret: this.config.get<string>("JWT_ACCESS_SECRET"),
      });
      if (payload.type !== "oauth_state") throw new Error("bad state type");
      if (!nonce || !payload.bnd) throw new Error("state not bound to this browser");
      const want = Buffer.from(payload.bnd);
      const got = Buffer.from(bindNonce(nonce));
      if (want.length !== got.length || !timingSafeEqual(want, got)) throw new Error("state binding mismatch");
    } catch {
      throw new BadRequestException("invalid oauth state");
    }
    if (!code) throw new BadRequestException("missing code");

    const tokenRes = await fetch(GH_TOKEN, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_id: this.config.get<string>("GITHUB_OAUTH_CLIENT_ID"),
        client_secret: this.config.get<string>("GITHUB_OAUTH_CLIENT_SECRET"),
        code,
        redirect_uri: this.redirectUri(),
      }),
    });
    const tokenJson = (await tokenRes.json()) as { access_token?: string };
    const ghToken = tokenJson.access_token;
    if (!ghToken) throw new BadRequestException("github token exchange failed");

    const ghHeaders = {
      authorization: `Bearer ${ghToken}`,
      accept: "application/vnd.github+json",
      "user-agent": "tugra",
    };
    const ghUser = (await (await fetch(GH_USER, { headers: ghHeaders })).json()) as {
      name?: string | null;
      login?: string;
    };
    const emails = (await (await fetch(GH_EMAILS, { headers: ghHeaders })).json()) as GithubEmail[];
    const primary = Array.isArray(emails)
      ? (emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified))
      : undefined;
    if (!primary) throw new BadRequestException("no verified github email");

    return this.auth.loginWithGithub(primary.email, ghUser.name ?? ghUser.login ?? undefined);
  }
}
