import { Controller, Get, Header } from "@nestjs/common";
import { ApiExcludeEndpoint } from "@nestjs/swagger";
import { SkipThrottle } from "@nestjs/throttler";
import { ConfigService } from "@nestjs/config";
import { appVersion } from "@tugra/shared";
import { UpdateService } from "../update/update.service";
import { renderAgentInstallScript } from "./agent-install-script";
import { renderMigratorInstallScript } from "./migrator-install-script";

type ImageRef = { image: string; digests?: { amd64: string; arm64: string } };

const DIGEST_MEMO_TTL_MS = 10 * 60 * 1000; // this endpoint is public + un-throttled → cache the manifest lookup
const DIGEST_RE = /^[a-f0-9]{64}$/; // only well-formed digests are pinned (a malformed one degrades to bare tag)

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
  constructor(
    private readonly config: ConfigService,
    private readonly update: UpdateService,
  ) {}

  private memo: { p: Promise<{ amd64: string; arm64: string } | null>; exp: number } | null = null;

  @Get("agent.sh")
  @ApiExcludeEndpoint()
  @SkipThrottle()
  @Header("Content-Type", "text/x-shellscript; charset=utf-8")
  @Header("Cache-Control", "no-store")
  async agentScript(): Promise<string> {
    return this.renderPinned(renderAgentInstallScript);
  }

  /**
   * The one-click data-migrator bootstrap at the BARE path `/install/migrator.sh` (also excluded from the
   * /api/v1 prefix). It runs the SAME tugra-agent image's `migrate` subcommand, so it reuses the exact
   * image ref + signed-manifest digest pin (and the shared memo) as agent.sh — no separate image exists.
   */
  @Get("migrator.sh")
  @ApiExcludeEndpoint()
  @SkipThrottle()
  @Header("Content-Type", "text/x-shellscript; charset=utf-8")
  @Header("Cache-Control", "no-store")
  async migratorScript(): Promise<string> {
    return this.renderPinned(renderMigratorInstallScript);
  }

  /**
   * The version-matched agent image + its per-arch digests (keeps agent↔hub protocol aligned). AGENT_IMAGE
   * overrides for custom registries / air-gapped mirrors (then no ghcr digest is pinned). Published by the
   * release pipeline (release-pipeline-ghcr).
   */
  private async agentImageRef(): Promise<ImageRef> {
    const image = this.config.get<string>("AGENT_IMAGE") ?? `ghcr.io/simeraycom/tugra-agent:${appVersion()}`;
    return { image, digests: (await this.agentDigests()) ?? undefined };
  }

  /** Render with the pinned ref; a bad digest must NEVER 500 these public endpoints — fall back to the bare tag. */
  private async renderPinned(render: (ref: ImageRef) => string): Promise<string> {
    const ref = await this.agentImageRef();
    try {
      return render(ref);
    } catch {
      return render({ image: ref.image });
    }
  }

  /**
   * The signed-manifest per-arch digests for the agent image of THIS hub's version — used to pin the
   * bootstrap install (supply-chain). Memoizes the in-flight PROMISE (not just the value) so a burst of
   * concurrent requests to this public/un-throttled endpoint shares ONE manifest fetch.
   */
  private async agentDigests(): Promise<{ amd64: string; arm64: string } | null> {
    if (this.config.get<string>("AGENT_IMAGE")) return null; // a mirror override isn't the ghcr image the digest pins
    const now = Date.now();
    if (!this.memo || this.memo.exp <= now) {
      this.memo = { p: this.resolveAgentDigests(), exp: now + DIGEST_MEMO_TTL_MS };
    }
    return this.memo.p;
  }

  /**
   * Best-effort resolve — NEVER throws. Returns digests only when: the signed manifest's latest entry is
   * exactly this hub's version AND both arch digests are present AND well-formed 64-hex. A malformed (but
   * signed) digest is treated as "no digest" (→ bare tag) rather than reaching the renderer (which throws).
   */
  private async resolveAgentDigests(): Promise<{ amd64: string; arm64: string } | null> {
    try {
      const res = await this.update.verifyLatestEntry();
      if (res.status !== "ok" || res.entry.version !== appVersion()) return null;
      const d = res.entry.agentSha256;
      if (d && DIGEST_RE.test(d.amd64 ?? "") && DIGEST_RE.test(d.arm64 ?? "")) return { amd64: d.amd64, arm64: d.arm64 };
      return null;
    } catch {
      return null;
    }
  }
}
