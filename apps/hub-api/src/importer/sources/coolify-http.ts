import { GuardedHttpGet } from "./guarded-get";
import type { CoolifyClient } from "./coolify.source";

/**
 * SSRF-safe authenticated GET client for one Coolify instance. A thin wrapper over the shared
 * {@link GuardedHttpGet} core: the Coolify REST API lives under `/api/v1` and authenticates with a Bearer
 * token. (SSRF guard, redirect refusal, timeouts and the response-size cap all live in the shared core.)
 */
export class CoolifyHttpClient implements CoolifyClient {
  private readonly http: GuardedHttpGet;

  constructor(baseUrl: string, token: string) {
    this.http = new GuardedHttpGet(baseUrl, {
      apiPrefix: "/api/v1",
      label: "Coolify",
      headers: () => ({ Authorization: `Bearer ${token}` }),
      // 401 = no/invalid token; 403 = valid token but not authorized — in Coolify that is almost always the
      // token's ability/team (servers are a root-team resource) or the instance's API "Allowed IPs" setting
      // excluding this hub's address.
      errorHint: (status) =>
        status === 401
          ? " (check the API token)"
          : status === 403
            ? ' (token valid but not authorized — check its ability/team is admin and Coolify\'s API "Allowed IPs" setting allows this hub)'
            : "",
    });
  }

  get<T>(path: string): Promise<T> {
    return this.http.get<T>(path);
  }
}
