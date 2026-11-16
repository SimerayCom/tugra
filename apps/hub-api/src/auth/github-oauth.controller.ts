import { Controller, ForbiddenException, Get, Query, Req, Res } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  clearOauthStateCookie,
  CookieResponse,
  parseCookies,
  setAuthCookies,
  setOauthStateCookie,
  TG_OAUTH_STATE,
} from "../common/cookies";
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
    const { url, nonce } = await this.oauth.begin();
    setOauthStateCookie(res, nonce);
    res.redirect(url);
  }

  /**
   * Callback: exchange the code, set httpOnly session cookies, then redirect to the SPA. Tokens are
   * delivered only via the cookies — never in the URL — so they can't leak through browser history
   * or the Referer header. The callback URL is chosen so it lands on the origin the browser uses for the
   * panel (see GithubOAuthService.redirectUri): the proxy origin for `--domain`, or the web port's own
   * `/api/auth/oauth/github/callback` proxy on the raw two-port install. The browser-bound state cookie is
   * single-use: it is cleared whatever the outcome. The whole login must therefore run on ONE origin: the panel has
   * to be opened at exactly WEB_PUBLIC_URL (same scheme, host and port), otherwise the cookie set at the start is
   * not sent to the callback and the user gets `?error=oauth_origin`.
   */
  @Get("callback")
  async callback(
    @Query("code") code: string,
    @Query("state") state: string,
    @Req() req: { headers?: { cookie?: string | string[] } },
    @Res() res: RedirectResponse,
  ): Promise<void> {
    const nonce = parseCookies(req.headers?.cookie)[TG_OAUTH_STATE];
    clearOauthStateCookie(res);
    // No binding cookie: the browser started the login on a different origin than the one GitHub sent it back to
    // (the callback always lands on WEB_PUBLIC_URL / the registered URL), or the cookie expired. Say so, instead of
    // the generic failure, so the login page can tell the user to open the panel at its configured address.
    if (!nonce) {
      res.redirect(`${this.web()}/login?error=oauth_origin`);
      return;
    }
    try {
      const tokens = await this.oauth.handleCallback(code, state, nonce);
      setAuthCookies(res, tokens);
      res.redirect(`${this.web()}/oauth/callback`);
    } catch (err) {
      // A gated NEW OAuth user gets a specific error so the login page can explain it (not the generic one).
      const reason = err instanceof ForbiddenException ? "registration_disabled" : "oauth";
      res.redirect(`${this.web()}/login?error=${reason}`);
    }
  }
}
