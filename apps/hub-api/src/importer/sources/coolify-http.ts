import { GuardedHttpGet, type RawTransport } from "./guarded-get";
import { coolifyLimits, type RequestLimits } from "./request-limits";
import type { CoolifyClient } from "./coolify.source";

/**
 * The 401/403/429 advice appended to a Coolify API error. Exported for the specs; the wording is the one the owner reads in
 * the import wizard (the web copy in `import.json` mirrors it).
 *
 * Coolify 4.7 answers 403 for several different reasons, all of which look the same on the wire, so the hint lists them:
 * the API switched off in Settings, the instance's "Allowed IPs" list not containing this hub, a token limited to selected
 * projects/environments (those cannot read `/servers`, keys, git sources and the other team-wide endpoints), a token that
 * has more access than its creator now has in the team, and a creator who is not an admin/owner (no `read:sensitive`).
 */
export function coolifyErrorHint(status: number): string {
  if (status === 401) return " (check the API token: it is invalid or revoked, or the user who created it left the team)";
  if (status === 403) {
    return (
      " (token valid but not authorized. Check that the API is enabled in Coolify and its \"Allowed IPs\" list includes this hub's address;" +
      " that the token belongs to a team admin or owner; that it is NOT limited to selected projects or environments, because such a token cannot read /servers and other team-wide endpoints;" +
      " and that it does not have more access than its creator has in the team (\"API token has more access than you have in this team\": create a new token))"
    );
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

  constructor(baseUrl: string, token: string, opts: { limits?: RequestLimits; transport?: RawTransport } = {}) {
    this.http = new GuardedHttpGet(baseUrl, {
      apiPrefix: "/api/v1",
      label: "Coolify",
      headers: () => ({ Authorization: `Bearer ${token}` }),
      errorHint: coolifyErrorHint,
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
