import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { Application } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";
import { CryptoService } from "../crypto/crypto.service";
import { loadProjectCtx } from "../common/resource-project";
import { isLinkEnvKeyAllowed, isSafeEnvValue } from "../common/env-key";
import { VaultApiClient, parseVaultLocator } from "../secret-providers/vault-api.client";

/** One secret ref as returned by the read API — the env var + where it is located, NEVER the fetched value.
 *  A provider the caller can't otherwise see is still named here (it is the app's own binding). */
export interface SecretRefView {
  refId: string;
  envVar: string;
  providerId: string;
  providerName: string;
  kind: string;
  remoteKey: string;
  // true when the app's plain env ALSO sets this key: the fetched secret OVERRIDES it at deploy (secrets are
  // highest precedence), so the UI can warn that the literal is dead. (NOT "shadowedBy": unlike a db-link,
  // the secret wins, not the app-env value.)
  overridesAppEnv: boolean;
  createdAt: string;
}

/**
 * App<->external-secret bindings: attach an external secret store value to an app so it is fetched and
 * injected into the app's runtime env at deploy time (recomputed fresh each deploy), without ever storing
 * the value in Tugra. v1 resolves HashiCorp Vault (KV v2) hub-side — no agent-protocol change. The fetched
 * values take the HIGHEST env precedence (an external managed secret wins over a possibly-stale literal in
 * the app's plain env); a ref that cannot be fetched FAILS the deploy loudly rather than deploying without it.
 */
@Injectable()
export class AppSecretRefsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly vault: VaultApiClient,
  ) {}

  // ---- deploy-time resolution ----------------------------------------------

  /**
   * Env fetched from this app's secret refs, computed FRESH on every deploy. Each ref contributes one
   * variable: the external secret's value under the ref's `envVar`. A provider that is gone or in another
   * team, an unsupported kind, or a fetch that fails (store unreachable, path/field missing) FAILS the
   * deploy with a non-secret message — never a silent empty value. The returned values are transient and
   * are never persisted back onto the app.
   */
  async resolveSecretEnv(app: Application): Promise<Record<string, string>> {
    const out: Record<string, string> = Object.create(null) as Record<string, string>;
    if (app.isPreview) return out; // a preview is a throwaway clone and carries no refs of its own (v1)

    const refs = await this.prisma.secretRef.findMany({
      where: { appId: app.id },
      orderBy: { createdAt: "asc" },
      include: { provider: true },
    });
    if (refs.length === 0) return out;

    for (const ref of refs) {
      const provider = ref.provider;
      if (!provider) throw new BadRequestException(`secret provider for ${ref.envVar} no longer exists — remove the binding`);
      if (provider.teamId !== app.teamId) throw new BadRequestException(`secret provider for ${ref.envVar} is not in this app's team — remove the binding`);
      out[ref.envVar] = await this.fetchValue(provider.kind, provider.address, provider.tokenEnc, ref.remoteKey, ref.envVar, provider.name);
    }
    return out;
  }

  private async fetchValue(
    kind: string,
    address: string,
    tokenEnc: string,
    remoteKey: string,
    envVar: string,
    providerName: string,
  ): Promise<string> {
    if (kind !== "vault") throw new BadRequestException(`cannot resolve ${envVar}: unsupported secret provider kind "${kind}"`);
    const token = this.crypto.decrypt(tokenEnc);
    let value: string;
    try {
      value = await this.vault.fetchSecret(address, token, remoteKey);
    } catch (e) {
      // The client's errors are already secret-free (address + locator only); re-wrap with the env var +
      // provider so the deploy log says WHICH binding failed, never the value or the token.
      const detail = e instanceof Error ? e.message : "unknown error";
      throw new BadRequestException(`could not resolve ${envVar} from secret provider "${providerName}": ${detail}`);
    }
    // The env-file is KEY=VALUE lines joined by "\n", so a newline/CR/NUL in a fetched value would inject a
    // second env var (e.g. a Vault field "x\nPATH=/evil"). User-supplied env is held to isSafeEnvValue; a
    // fetched secret bypasses that DTO guard, so enforce the SAME boundary here. The value is never echoed.
    if (!isSafeEnvValue(value)) {
      throw new BadRequestException(`the secret for ${envVar} (provider "${providerName}") contains a newline or control character and cannot be injected as an env var`);
    }
    return value;
  }

  // ---- read ----------------------------------------------------------------

  /** This app's secret refs for the config card. No secret values; the locator (remoteKey) is not a secret. */
  async list(userId: string, appId: string): Promise<SecretRefView[]> {
    const app = await this.requireAppRead(userId, appId);
    const refs = await this.prisma.secretRef.findMany({
      where: { appId },
      orderBy: { createdAt: "asc" },
      include: { provider: true },
    });
    if (refs.length === 0) return [];
    const appKeys = this.appEnvKeys(app);
    return refs.map((ref) => ({
      refId: ref.id,
      envVar: ref.envVar,
      providerId: ref.providerId,
      providerName: ref.provider?.name ?? "(removed)",
      kind: ref.provider?.kind ?? "unknown",
      remoteKey: ref.remoteKey,
      overridesAppEnv: appKeys.has(ref.envVar),
      createdAt: ref.createdAt.toISOString(),
    }));
  }

  // ---- mutate --------------------------------------------------------------

  /**
   * Bind an external secret to an app. Requires apps:config + resource access on the app AND the
   * `integrations` permission on the provider's team (using a secret store is gated like managing it). The
   * provider must be in the app's team — a miss is 404, not 403, so a caller can't probe other teams' ids.
   * The env var name follows the link-injection policy, and a Vault locator is format-checked up front so a
   * malformed binding fails here, not at deploy.
   */
  async create(
    userId: string,
    appId: string,
    input: { providerId: string; envVar: string; remoteKey: string },
  ): Promise<SecretRefView> {
    const app = await this.requireAppConfig(userId, appId);
    if (app.isPreview) throw new BadRequestException("preview apps can't bind secrets directly");

    if (!isLinkEnvKeyAllowed(input.envVar)) {
      throw new BadRequestException(`invalid env var name: ${JSON.stringify(input.envVar)}`);
    }

    // Same-team lookup only — a cross-team / unknown id is 404 (no existence oracle).
    const provider = await this.prisma.secretProvider.findFirst({ where: { id: input.providerId, teamId: app.teamId } });
    if (!provider) throw new NotFoundException("secret provider not found");
    await this.access.requirePermission(userId, provider.teamId, "integrations");

    // Fail fast on a malformed locator for the kinds we can validate (Vault). parseVaultLocator throws a
    // VaultApiError (not an HttpException), so map it to a 400 rather than letting it surface as a 500.
    if (provider.kind === "vault") {
      try {
        parseVaultLocator(input.remoteKey);
      } catch (e) {
        throw new BadRequestException(e instanceof Error ? e.message : "invalid secret locator");
      }
    }

    if (await this.prisma.secretRef.findUnique({ where: { appId_envVar: { appId, envVar: input.envVar } } })) {
      throw new ConflictException(`env var ${input.envVar} is already bound to a secret`);
    }
    // A secret ref outranks a database link of the same name at deploy (highest precedence), so refuse to
    // bind one over an existing db-link env var rather than silently overriding the injected connection URI.
    if (await this.prisma.appDatabaseLink.findUnique({ where: { appId_envVar: { appId, envVar: input.envVar } } })) {
      throw new ConflictException(`env var ${input.envVar} is already used by a database link — unlink it first`);
    }

    const created = await this.prisma.secretRef.create({
      data: { appId, providerId: provider.id, envVar: input.envVar, remoteKey: input.remoteKey, createdBy: userId },
      include: { provider: true },
    });
    await this.audit.log({
      actor: userId,
      action: "app.secret_ref.create",
      target: appId,
      meta: { providerId: provider.id, envVar: input.envVar, kind: provider.kind }, // locator/value never logged
    });
    return {
      refId: created.id,
      envVar: created.envVar,
      providerId: created.providerId,
      providerName: provider.name,
      kind: provider.kind,
      remoteKey: created.remoteKey,
      overridesAppEnv: this.appEnvKeys(app).has(created.envVar),
      createdAt: created.createdAt.toISOString(),
    };
  }

  /** Remove a secret binding. apps:config + resource access on the app; a foreign refId is 404. */
  async remove(userId: string, appId: string, refId: string): Promise<void> {
    await this.requireAppConfig(userId, appId);
    const ref = await this.prisma.secretRef.findFirst({ where: { id: refId, appId } });
    if (!ref) throw new NotFoundException("secret binding not found");
    await this.prisma.secretRef.delete({ where: { id: ref.id } });
    await this.audit.log({ actor: userId, action: "app.secret_ref.delete", target: appId, meta: { providerId: ref.providerId, envVar: ref.envVar } });
  }

  // ---- helpers -------------------------------------------------------------

  private appEnv(app: Application): Record<string, string> {
    if (!app.envEnc) return {};
    try {
      return JSON.parse(this.crypto.decrypt(app.envEnc)) as Record<string, string>;
    } catch {
      return {};
    }
  }

  private appEnvKeys(app: Application): Set<string> {
    return new Set(Object.keys(this.appEnv(app)));
  }

  private async requireAppConfig(userId: string, appId: string): Promise<Application> {
    const app = await this.loadApp(appId);
    await this.access.requirePermission(userId, app.teamId, "apps:config");
    await this.access.requireResourceAccess(userId, app.teamId, {
      resourceId: app.id,
      resolveProjectId: () => loadProjectCtx(this.prisma, app.environmentId).then((c) => c.projectId),
    });
    return app;
  }

  private async requireAppRead(userId: string, appId: string): Promise<Application> {
    const app = await this.loadApp(appId);
    await this.access.requireResourceAccess(userId, app.teamId, {
      resourceId: app.id,
      resolveProjectId: () => loadProjectCtx(this.prisma, app.environmentId).then((c) => c.projectId),
    });
    return app;
  }

  private async loadApp(appId: string): Promise<Application> {
    const app = await this.prisma.application.findUnique({ where: { id: appId } });
    if (!app) throw new NotFoundException("application not found");
    return app;
  }
}
