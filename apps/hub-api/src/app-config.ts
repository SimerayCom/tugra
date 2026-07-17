import { INestApplication, RequestMethod } from "@nestjs/common";

/**
 * Apply the runtime routing config shared by the real bootstrap (main.ts) AND route-level tests.
 *
 * Every REST controller is served under `/api/v1` so the public API is versioned. A fixed set of routes
 * is EXEMPT and stays at its bare path because an external party calls it at a URL that cannot change:
 *  - `webhooks/*`            — external git providers POST to `HUB_PUBLIC_URL/webhooks/...`.
 *  - `auth/oauth/github(/callback)` — the redirect URI is registered in the GitHub OAuth app.
 *  - `health`, `version`     — infra/monitoring probes.
 *  - `install/agent.sh`      — the `curl | sh` agent bootstrap runs against a fixed, un-versioned URL.
 *
 * The agent/terminal WebSocket upgrades (`/agent`, `/terminal`) are raw `ws` servers, NOT Nest routes, so
 * the global prefix does not touch them (no exclusion needed or possible).
 */
export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix("api/v1", {
    exclude: [
      { path: "health", method: RequestMethod.GET },
      { path: "version", method: RequestMethod.GET },
      { path: "install/agent.sh", method: RequestMethod.GET },
      { path: "webhooks/deploy/:token", method: RequestMethod.POST },
      { path: "webhooks/github/:sourceId", method: RequestMethod.POST },
      { path: "auth/oauth/github", method: RequestMethod.GET }, // OAuth start
      { path: "auth/oauth/github/callback", method: RequestMethod.GET },
    ],
  });
}
