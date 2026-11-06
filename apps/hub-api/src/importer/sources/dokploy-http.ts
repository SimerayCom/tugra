import { GuardedHttpGet } from "./guarded-get";
import type { DokployClient } from "./dokploy.source";

/**
 * SSRF-safe authenticated GET client for one Dokploy instance. A thin wrapper over the shared
 * {@link GuardedHttpGet} core. Dokploy's REST API is tRPC-OpenAPI: procedures are addressed as
 * `/api/<router>.<procedure>` (queries are GET with query-string params) and authenticate with an API key
 * sent in the `x-api-key` header (NOT a Bearer token). The key is generated in the dashboard under
 * Profile → API/CLI and is scoped to one organization.
 */
export class DokployHttpClient implements DokployClient {
  private readonly http: GuardedHttpGet;

  constructor(baseUrl: string, apiKey: string) {
    this.http = new GuardedHttpGet(baseUrl, {
      apiPrefix: "/api",
      label: "Dokploy",
      headers: () => ({ "x-api-key": apiKey }),
      // 401 = missing/invalid key, or a key with no organization. 403 = the key's org role lacks access to
      // some resources (an owner/admin key sees the whole fleet). 429 = programmatic-key rate limit.
      errorHint: (status) =>
        status === 401
          ? " (check the API key — generate it under Profile → API/CLI; it must be bound to an organization)"
          : status === 403
            ? " (the key's org role may not reach every project — use an owner/admin key for a complete import)"
            : status === 429
              ? " (rate limited — generate the key in the Dokploy dashboard rather than programmatically)"
              : "",
    });
  }

  get<T>(path: string): Promise<T> {
    return this.http.get<T>(path);
  }
}
