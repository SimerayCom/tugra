import { Controller, Get, Query, Res } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CookieResponse, setAuthCookies } from "../common/cookies";
import { OidcService } from "./oidc.service";

/** Minimal Express response shape we use (avoids a hard @types/express dependency). */
interface RedirectResponse extends CookieResponse {
  redirect(url: string): void;
}

/**
 * OIDC single sign-on (Pro). The browser-facing start + callback, mirroring the GitHub OAuth controller:
 * start redirects to the IdP; callback exchanges the code, sets the httpOnly session cookies and bounces
 * to the SPA. Tokens are delivered only via cookies, never in the URL. Unauthenticated by design (this IS
 * the login). When SSO isn't configured/enabled (or the edition is below Pro), start shows a friendly
 * "unconfigured" instead of the consent screen.
 */
@Controller("auth/oidc")
export class OidcController {
  constructor(
    private readonly oidc: OidcService,
    private readonly config: ConfigService,
  ) {}

  private web(): string {
    return (this.config.get<string>("WEB_PUBLIC_URL") ?? "http://localhost:3001").replace(/\/$/, "");
  }

  @Get()
  async start(@Res() res: RedirectResponse): Promise<void> {
    if (!(await this.oidc.isConfigured())) {
      res.redirect(`${this.web()}/login?error=sso_unconfigured`);
      return;
    }
    res.redirect(await this.oidc.authorizeUrl());
  }

  @Get("callback")
  async callback(
    @Query("code") code: string,
    @Query("state") state: string,
    @Res() res: RedirectResponse,
  ): Promise<void> {
    try {
      const tokens = await this.oidc.handleCallback(code, state);
      setAuthCookies(res, tokens);
      res.redirect(`${this.web()}/oauth/callback`);
    } catch {
      res.redirect(`${this.web()}/login?error=sso`);
    }
  }
}
