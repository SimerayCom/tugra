import { Controller, ForbiddenException, Get, Query, Res } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CookieResponse, setAuthCookies } from "../common/cookies";
import { GithubOAuthService } from "./github-oauth.service";

/** Minimal Express response shape we use (avoids a hard @types/express dependency). */
interface RedirectResponse extends CookieResponse {
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

  /**
   * Callback: exchange the code, set httpOnly session cookies, then redirect to the SPA. Tokens are
   * delivered only via the cookies — never in the URL — so they can't leak through browser history
   * or the Referer header. (Requires the hub and SPA to share a public origin, which the same-origin
   * reverse-proxy deployment provides, so the cookies are visible to the SPA.)
   */
  @Get("callback")
  async callback(
    @Query("code") code: string,
    @Query("state") state: string,
    @Res() res: RedirectResponse,
  ): Promise<void> {
    try {
      const tokens = await this.oauth.handleCallback(code, state);
      setAuthCookies(res, tokens);
      res.redirect(`${this.web()}/oauth/callback`);
    } catch (err) {
      // A gated NEW OAuth user gets a specific error so the login page can explain it (not the generic one).
      const reason = err instanceof ForbiddenException ? "registration_disabled" : "oauth";
      res.redirect(`${this.web()}/login?error=${reason}`);
    }
  }
}
