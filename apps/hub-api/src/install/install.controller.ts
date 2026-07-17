import { Controller, Get, Header } from "@nestjs/common";
import { ApiExcludeEndpoint } from "@nestjs/swagger";
import { SkipThrottle } from "@nestjs/throttler";
import { ConfigService } from "@nestjs/config";
import { appVersion } from "@tugra/shared";
import { renderAgentInstallScript } from "./agent-install-script";

/**
 * Serves the agent bootstrap script at the BARE path `/install/agent.sh` (excluded from the /api/v1
 * prefix in app-config.ts) so `curl -fsSL <hub>/install/agent.sh | sh -s -- --hub … --token …` works.
 *
 * No `@UseGuards` → public (auth is opt-in per controller, like VersionController). `@ApiExcludeEndpoint`
 * keeps a text/x-shellscript route out of the JSON OpenAPI contract (no drift-guard churn). `@SkipThrottle`
 * because it's a static, non-secret, DB-free asset every enrolling server fetches once.
 */
@Controller("install")
export class InstallController {
  constructor(private readonly config: ConfigService) {}

  @Get("agent.sh")
  @ApiExcludeEndpoint()
  @SkipThrottle()
  @Header("Content-Type", "text/x-shellscript; charset=utf-8")
  @Header("Cache-Control", "no-store")
  agentScript(): string {
    // Version-matched agent image (keeps agent↔hub protocol aligned); AGENT_IMAGE overrides for
    // custom registries / air-gapped mirrors. Published by the release pipeline (release-pipeline-ghcr).
    const image = this.config.get<string>("AGENT_IMAGE") ?? `ghcr.io/mrcandev/tugra-agent:${appVersion()}`;
    return renderAgentInstallScript({ image });
  }
}
