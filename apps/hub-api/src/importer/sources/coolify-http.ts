import { GuardedHttpGet, type ErrorHintContext, type RawTransport } from "./guarded-get";
import { coolifyLimits, type RequestLimits } from "./request-limits";
import type { CoolifyClient } from "./coolify.source";

/** The single cause a Coolify 403 body points at; `unknown` = a body we cannot tell apart (older Coolify, no message), so every cause is listed. */
export type Coolify403Cause = "allowed-ips" | "api-disabled" | "scoped-token" | "exceeds-access" | "ability" | "unknown";

/**
 * Which cause a Coolify 4.7.5 403 body names. The bodies are fixed strings from Coolify's middleware:
 *   ApiAllowed        `API is disabled.`
 *   ApiIpAllowed      `You are not allowed to access the API.`
 *   ApiAbility        `This API token is limited to selected projects, environments, or resources, so it cannot use this endpoint.`
 *                     `Missing required permissions: read`
 *   EnsureTokenBelongsToCurrentTeamMember
 *                     `This API token has more access than you have in this team. Revoke it and create a new token.`
 * Matched on the leading words only, because the excerpt kept in the error is cut at ~100 characters.
 */
export function classifyCoolify403(message: string | null | undefined): Coolify403Cause {
  const m = (message ?? "").toLowerCase();
  if (!m) return "unknown";
  if (m.includes("not allowed to access the api")) return "allowed-ips";
  if (m.startsWith("api is disabled")) return "api-disabled";
  if (m.includes("more access than you have")) return "exceeds-access";
  if (m.includes("limited to selected projects") || m.includes("selected projects, environments")) return "scoped-token";
  if (m.startsWith("missing required permissions")) return "ability";
  return "unknown";
}

/**
 * The 401/403/429 advice appended to a Coolify API error. Exported for the specs; the wording is the one the owner reads in
 * the import wizard (the web copy in `import.json` mirrors it).
 *
 * Coolify 4.7 answers 403 for several different reasons, all of which look the same on the wire except for the JSON `message`.
 * When the body names one ({@link classifyCoolify403}) the hint is the ONE matching cause; only an unrecognised or missing
 * message falls back to listing them all (the API switched off in Settings, the instance's "Allowed IPs" list not containing
 * this hub, a token limited to selected projects/environments, a token that has more access than its creator now has in the
 * team, and a creator who is not an admin/owner so the token has no `read:sensitive`).
 *
 * `ctx.egressIp` is this hub's public address when it is known: the Allowed-IPs advice names it, so the owner can paste it
 * into Coolify Settings > Advanced > Allowed IPs without looking it up.
 */
export function coolifyErrorHint(status: number, ctx: ErrorHintContext = {}): string {
  if (status === 401) return " (check the API token: it is invalid or revoked, or the user who created it left the team)";
  if (status === 403) {
    switch (classifyCoolify403(ctx.message)) {
      case "allowed-ips": {
        const addr = ctx.egressIp ? `this hub's address ${ctx.egressIp}` : "this hub's public address (shown in the import wizard when the hub can tell it)";
        return (
          ` (Coolify's Allowed IPs list does not include ${addr}: add it in Coolify under Settings > Advanced > Allowed IPs, or leave the list empty.` +
          " If Coolify sits behind a reverse proxy or Cloudflare, Coolify must see the real client IP (forward the client address headers), otherwise it compares its proxy's address and that is the one to list)"
        );
      }
      case "api-disabled":
        return " (the API is switched off in Coolify: enable it under Settings > Advanced, then retry)";
      case "scoped-token":
        return " (this token is limited to selected projects or environments, and such a token cannot read /servers and the other team-wide endpoints: create a new API token that covers the whole team)";
      case "exceeds-access":
        return " (the token has more access than its creator now has in this team: create a new API token, as a team admin or owner)";
      case "ability":
        return " (the token lacks an ability this step needs: create a new token with read and read:sensitive, plus deploy for a guided run, as a team admin or owner)";
      default:
        return (
          " (token valid but not authorized. Check that the API is enabled in Coolify and its \"Allowed IPs\" list includes this hub's address;" +
          " that the token belongs to a team admin or owner; that it is NOT limited to selected projects or environments, because such a token cannot read /servers and other team-wide endpoints;" +
          " and that it does not have more access than its creator has in the team (\"API token has more access than you have in this team\": create a new token))"
        );
    }
  }
  if (status === 429) return " (rate limited: Coolify allows 200 requests a minute per user, wait a minute and retry)";
  return "";
}

/**
 * SSRF-safe authenticated GET client for one Coolify instance. A thin wrapper over the shared
 * {@link GuardedHttpGet} core: the Coolify REST API lives under `/api/v1` and authenticates with a Bearer
 * token. (SSRF guard, redirect refusal, timeouts and the response-size cap all live in the shared core.)
 *
 * Coolify 4.7 throttles its API (200 requests a minute per user, 30 failed requests a minute per token). Every request goes
 * through the process-wide {@link coolifyLimits} for this base URL: paced under the limit across all concurrent callers, a
 * 429 honours a bounded `Retry-After` and then fails with a stable `rate-limited` error, and a token that keeps failing
 * authorization stops being sent so it cannot be driven into Coolify's escalating lockout.
 */
export class CoolifyHttpClient implements CoolifyClient {
  private readonly http: GuardedHttpGet;

  constructor(baseUrl: string, token: string, opts: { limits?: RequestLimits; transport?: RawTransport; egressIp?: () => Promise<string | null> } = {}) {
    this.http = new GuardedHttpGet(baseUrl, {
      apiPrefix: "/api/v1",
      label: "Coolify",
      headers: () => ({ Authorization: `Bearer ${token}` }),
      errorHint: coolifyErrorHint,
      includeApiMessage: true,
      egressIp: opts.egressIp,
      limits: opts.limits ?? coolifyLimits.for(baseUrl, token),
      transport: opts.transport,
    });
  }

  get<T>(path: string): Promise<T> {
    return this.http.get<T>(path);
  }

  getText(path: string): Promise<string> {
    return this.http.getText(path);
  }
}
