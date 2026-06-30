import { Controller, Get, Query, Res } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { GithubOAuthService } from "./github-oauth.service";

/** Minimal Express response shape we use (avoids a hard @types/express dependency). */
interface RedirectResponse {
  redirect(url: string): void;
}

@Controller("auth/oauth/github")
export class GithubOAuthController {
  constructor(
    private readonly oauth: GithubOAuthService,
    private readonly config: ConfigService,
  ) {}

  private web(): string {
    return (this.config.get<string>("WEB_PUBLIC_URL") ?? "http://localhost:3001").replace(/\/$/, "");
  }

  /** Start: redirect the browser to GitHub's consent screen (or a friendly error if unconfigured). */
  @Get()
  async start(@Res() res: RedirectResponse): Promise<void> {
    if (!this.oauth.isConfigured()) {
      res.redirect(`${this.web()}/login?error=oauth_unconfigured`);
      return;
    }
    res.redirect(await this.oauth.authorizeUrl());
  }

  /** Callback: exchange the code, then hand Tugra tokens to the SPA via URL fragment. */
  @Get("callback")
  async callback(
    @Query("code") code: string,
    @Query("state") state: string,
    @Res() res: RedirectResponse,
  ): Promise<void> {
    try {
      const tokens = await this.oauth.handleCallback(code, state);
      res.redirect(
        `${this.web()}/oauth/callback#access=${encodeURIComponent(tokens.accessToken)}&refresh=${encodeURIComponent(tokens.refreshToken)}`,
      );
    } catch {
      res.redirect(`${this.web()}/login?error=oauth`);
    }
  }
}
