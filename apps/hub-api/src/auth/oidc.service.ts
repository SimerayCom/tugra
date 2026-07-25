import { BadRequestException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { AuthService, type TokenPair } from "./auth.service";
import { InstanceSettingsService } from "../instance/instance-settings.service";
import { CryptoService } from "../crypto/crypto.service";
import { currentEdition, editionAtLeast } from "../common/edition";
import { assertSafeUrl, allowPrivateTargets } from "../notifications/safe-url";

const DISCOVERY_TTL_MS = 60 * 60 * 1000; // 1h — the IdP's endpoints/keys rotate slowly
const FETCH_TIMEOUT_MS = 10_000;
const SCOPES = "openid email profile";

/** The subset of the OIDC discovery document (`/.well-known/openid-configuration`) we use. */
interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
}

interface TokenResponse {
  id_token?: string;
  access_token?: string;
}

type Jwks = ReturnType<typeof createRemoteJWKSet>;

/**
 * OIDC single sign-on (Pro edition). Generalizes the GitHub OAuth flow to any standards-compliant OIDC
 * provider: build the authorize URL (state + nonce), then on callback exchange the code, verify the
 * id_token's signature against the IdP's JWKS (jose), check the nonce, and turn the identity into Tugra
 * tokens via AuthService.loginWithOidc. Config lives on the InstanceSettings singleton (owner-managed);
 * the client secret is stored encrypted and only decrypted here at token-exchange time.
 */
@Injectable()
export class OidcService {
  constructor(
    private readonly config: ConfigService,
    private readonly jwt: JwtService,
    private readonly auth: AuthService,
    private readonly settings: InstanceSettingsService,
    private readonly crypto: CryptoService,
  ) {}

  // Discovery docs and JWKS getters are cached per issuer/uri so a login doesn't re-fetch every time
  // (jose's createRemoteJWKSet also caches keys internally with its own cooldown).
  private discoveryCache = new Map<string, { doc: OidcDiscovery; exp: number }>();
  private jwksCache = new Map<string, Jwks>();

  /** SSO is usable only on a Pro+ edition AND when the owner has fully configured + enabled it. Checking
   *  the edition here means a Pro→Community downgrade silently disables SSO (the login route then shows a
   *  friendly "unconfigured" instead of exposing a half-configured flow). */
  async isConfigured(): Promise<boolean> {
    if (!editionAtLeast(currentEdition(), "pro")) return false;
    const s = await this.settings.get();
    return !!(s.oidcEnabled && s.oidcIssuer && s.oidcClientId && s.oidcClientSecretEnc);
  }

  private redirectUri(): string {
    const hub = this.config.get<string>("HUB_PUBLIC_URL") ?? "http://localhost:3000";
    return `${hub.replace(/\/$/, "")}/auth/oidc/callback`;
  }

  /** Build the IdP authorize URL. The state is a short-lived signed JWT carrying the nonce (stateless
   *  CSRF + replay binding); the nonce is echoed to the IdP and later matched against the id_token. */
  async authorizeUrl(): Promise<string> {
    const s = await this.settings.get();
    const disc = await this.discover(s.oidcIssuer!);
    const nonce = randomBytes(16).toString("base64url");
    const state = await this.jwt.signAsync(
      { type: "oidc_state", nonce },
      { secret: this.config.get<string>("JWT_ACCESS_SECRET"), expiresIn: "10m" },
    );
    const params = new URLSearchParams({
      client_id: s.oidcClientId!,
      redirect_uri: this.redirectUri(),
      response_type: "code",
      scope: SCOPES,
      state,
      nonce,
    });
    return `${disc.authorization_endpoint}?${params.toString()}`;
  }

  async handleCallback(code: string, state: string): Promise<TokenPair> {
    // Re-check on the callback too — not just at start(). A signed state is valid for 10 minutes, so an
    // owner disabling SSO (or a Pro→Community downgrade) must terminate an in-flight login, not just new
    // authorize attempts.
    if (!(await this.isConfigured())) throw new BadRequestException("sso is not enabled");

    let nonce: string;
    try {
      const payload = await this.jwt.verifyAsync<{ type?: string; nonce?: string }>(state, {
        secret: this.config.get<string>("JWT_ACCESS_SECRET"),
      });
      if (payload.type !== "oidc_state" || !payload.nonce) throw new Error("bad state");
      nonce = payload.nonce;
    } catch {
      throw new BadRequestException("invalid sso state");
    }
    if (!code) throw new BadRequestException("missing code");

    const s = await this.settings.get();
    const disc = await this.discover(s.oidcIssuer!);
    const clientSecret = this.crypto.decrypt(s.oidcClientSecretEnc!);

    // Confidential-client code exchange (client_secret_post). This happens over TLS directly with the
    // token endpoint; the client secret is decrypted only for this call and never logged. The token
    // endpoint comes from the (owner-configured, but not further trusted) discovery document, so it is
    // SSRF-validated right before we POST the secret to it — re-resolving DNS closes the rebind window.
    await this.assertEndpointSafe(disc.token_endpoint);
    const tokens = await this.exchangeCode(disc.token_endpoint, code, s.oidcClientId!, clientSecret);
    if (!tokens.id_token) throw new BadRequestException("sso token exchange failed");

    // Verify the id_token: signature against the IdP's JWKS + issuer + audience + expiry (jose), then
    // the nonce we bound in the state (replay protection). The JWKS URI is also SSRF-validated first.
    await this.assertEndpointSafe(disc.jwks_uri);
    let claims: JWTPayload;
    try {
      const verified = await jwtVerify(tokens.id_token, this.getJwks(disc.jwks_uri), {
        issuer: disc.issuer || s.oidcIssuer!,
        audience: s.oidcClientId!,
      });
      claims = verified.payload;
    } catch {
      throw new BadRequestException("sso token verification failed");
    }
    if (claims.nonce !== nonce) throw new BadRequestException("sso nonce mismatch");
    if (claims.email_verified === false) throw new BadRequestException("sso email is not verified");

    // Prefer the id_token's email/name; fall back to the userinfo endpoint if the id_token omits email.
    let email = typeof claims.email === "string" ? claims.email : undefined;
    let name = typeof claims.name === "string" ? claims.name : undefined;
    if (!email && tokens.access_token && disc.userinfo_endpoint) {
      await this.assertEndpointSafe(disc.userinfo_endpoint);
      const info = await this.fetchJson<{ email?: string; name?: string }>(disc.userinfo_endpoint, {
        headers: { authorization: `Bearer ${tokens.access_token}` },
      });
      email = info.email;
      name = name ?? info.name;
    }
    if (!email) throw new BadRequestException("no email from sso provider");

    const allowedDomains = (s.oidcAllowedDomains ?? []).map((d) => d.trim().toLowerCase()).filter(Boolean);
    return this.auth.loginWithOidc(email, name, allowedDomains);
  }

  // ---- discovery / JWKS / HTTP -------------------------------------------------

  private async discover(issuer: string): Promise<OidcDiscovery> {
    const cached = this.discoveryCache.get(issuer);
    if (cached && cached.exp > Date.now()) return cached.doc;
    const url = `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
    await this.assertEndpointSafe(url); // re-resolve the issuer host at fetch time (DNS-rebind defense)
    const doc = await this.fetchJson<OidcDiscovery>(url);
    if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
      throw new BadRequestException("invalid sso discovery document");
    }
    this.discoveryCache.set(issuer, { doc, exp: Date.now() + DISCOVERY_TTL_MS });
    return doc;
  }

  /**
   * SSRF guard for every server-side OIDC fetch. The issuer is validated once at config-save time, but the
   * endpoints we actually call (discovery, token, JWKS, userinfo) come from the discovery document and are
   * re-validated here right before each fetch — this blocks a malicious/compromised IdP declaring an
   * internal/metadata endpoint AND a DNS rebind after the one-shot save-time check. Self-hosters can opt
   * into private targets via NOTIFY_ALLOW_PRIVATE_TARGETS (same knob as the notifications egress guard).
   */
  private async assertEndpointSafe(url: string): Promise<void> {
    try {
      await assertSafeUrl(url, { allowPrivate: allowPrivateTargets() });
    } catch {
      throw new BadRequestException("sso endpoint is not allowed (private/loopback/metadata address)");
    }
  }

  private getJwks(jwksUri: string): Jwks {
    let jwks = this.jwksCache.get(jwksUri);
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(jwksUri));
      this.jwksCache.set(jwksUri, jwks);
    }
    return jwks;
  }

  private async exchangeCode(tokenEndpoint: string, code: string, clientId: string, clientSecret: string): Promise<TokenResponse> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.redirectUri(),
      client_id: clientId,
      client_secret: clientSecret,
    });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: body.toString(),
        signal: ctrl.signal,
        redirect: "manual", // never follow a redirect off the validated endpoint (SSRF: the secret is in this request)
      });
      if (!res.ok) throw new BadRequestException("sso token exchange failed");
      return (await res.json()) as TokenResponse;
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
      throw new BadRequestException("sso provider unreachable"); // never leaks the client secret in the message
    } finally {
      clearTimeout(timer);
    }
  }

  private async fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      // redirect:"manual" — a validated endpoint must not bounce the request to an unvalidated internal
      // target (SSRF); real IdP discovery/userinfo endpoints answer 200 directly.
      const res = await fetch(url, { ...init, signal: ctrl.signal, redirect: "manual" });
      if (!res.ok) throw new BadRequestException(`sso request failed (${res.status})`);
      return (await res.json()) as T;
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
      throw new BadRequestException("sso provider unreachable");
    } finally {
      clearTimeout(timer);
    }
  }
}
