import { ConfigService } from "@nestjs/config";

/**
 * The public origin of the web app (SPA), for building links emailed to users — reset links,
 * invitation links, etc. Distinct from HUB_PUBLIC_URL (the API/agent origin). Trailing slash
 * trimmed so `${webBaseUrl(config)}/reset-password` never doubles up.
 */
export function webBaseUrl(config: ConfigService): string {
  return (config.get<string>("WEB_PUBLIC_URL") ?? "http://localhost:3001").replace(/\/+$/, "");
}
