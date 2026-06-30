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

  private redirectUri(): string {
    const hub = this.config.get<string>("HUB_PUBLIC_URL") ?? "http://localhost:3000";
    return `${hub.replace(/\/$/, "")}/auth/oauth/github/callback`;
  }

  /** Stateless CSRF: a short-lived JWT we sign and verify on callback. */
  async authorizeUrl(): Promise<string> {
    const state = await this.jwt.signAsync(
      { type: "oauth_state" },
      { secret: this.config.get<string>("JWT_ACCESS_SECRET"), expiresIn: "10m" },
    );
    const params = new URLSearchParams({
      client_id: this.config.get<string>("GITHUB_OAUTH_CLIENT_ID")!,
      redirect_uri: this.redirectUri(),
      scope: "read:user user:email",
      state,
    });
    return `${GH_AUTHORIZE}?${params.toString()}`;
  }

  async handleCallback(code: string, state: string): Promise<TokenPair> {
    try {
      const payload = await this.jwt.verifyAsync<{ type?: string }>(state, {
        secret: this.config.get<string>("JWT_ACCESS_SECRET"),
      });
      if (payload.type !== "oauth_state") throw new Error("bad state type");
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
