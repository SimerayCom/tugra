import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException } from "@nestjs/common";
import type { Server } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { CryptoService } from "../crypto/crypto.service";
import { TeamAccessService } from "../common/team-access.service";
import { CloudProviderFactory } from "./providers/provider-factory.service";
import type { CloudOobProvider, OobPowerAction, ProviderActionResult } from "./providers/cloud-provider.interface";
import {
  OOB_DESTRUCTIVE_POWER_ACTIONS,
  type OobActionResult,
  type OobCandidate,
  type OobConsoleResult,
  type OobLinkInput,
  type OobPowerInput,
  type OobRescueResult,
  type OobStatusView,
} from "./oob.dto";

/** Hetzner turns rescue off after the first boot into it, or after 60 minutes (docs.hetzner.cloud). */
const RESCUE_EXPIRES_MINUTES = 60;

/** A resolved link: the server row, its provider client and the decrypted token (held only for this call). */
interface Resolved {
  server: Server;
  client: CloudOobProvider;
  token: string;
  providerServerId: string;
}

/**
 * Out-of-band actions on a cloud-linked server: power, rescue and the provider console. They talk straight to the
 * provider with the team's stored credential, so they work when the Tugra agent is offline (that is the point).
 *
 * Rules every action follows: authorise first (team permission `servers:ops`; the controller adds the PAT scope),
 * resolve the link, check the typed confirmation, write the audit entry BEFORE the provider is called, then call.
 * The provider token is decrypted for one call and dropped. The rescue root password and the console URL/password are
 * returned to the caller once: they are never persisted, never put in the audit entry and never logged.
 */
@Injectable()
export class OobService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly providers: CloudProviderFactory,
  ) {}

  // ───────────────────────────── read ─────────────────────────────

  /** The link for any member of the server's team; plus (best effort) the provider-side state for members with servers:ops. */
  async status(userId: string, serverId: string): Promise<OobStatusView> {
    const server = await this.requireServer(serverId);
    const perms = await this.access.membershipPermissions(userId, server.teamId);
    if (!perms) throw new ForbiddenException("not a member of this team");
    const canManage = perms.has("servers:manage");
    const canOps = perms.has("servers:ops");
    const base: OobStatusView = {
      linked: false,
      provider: server.provider ?? null,
      providerServerId: server.providerServerId ?? null,
      manual: server.providerManualLink,
      supported: false,
      credentialName: null,
      credentialMissing: false,
      canManage,
      canOps,
      state: null,
      stateError: null,
    };
    if (!server.provider || !server.providerServerId) return base;
    const client = this.providers.getOob(server.provider);
    base.supported = client !== null;
    if (!server.cloudCredentialId) return { ...base, credentialMissing: true };
    const cred = await this.prisma.cloudCredential.findUnique({ where: { id: server.cloudCredentialId } });
    if (!cred) return { ...base, credentialMissing: true };
    const linked: OobStatusView = { ...base, linked: true, credentialName: cred.name };
    // The provider is called with the team's token, so only callers who may act (servers:ops) trigger it; the rest
    // get the link metadata without live state (a viewer or a poll loop must not burn the shared API rate limit).
    if (!client || !canOps) return linked;
    try {
      linked.state = await client.getServerState(this.crypto.decrypt(cred.apiTokenEnc), server.providerServerId);
    } catch (e) {
      linked.stateError = oobHttpError(server.provider, e).message;
    }
    return linked;
  }

  // ───────────────────────────── actions ─────────────────────────────

  /** power_on | power_off | reboot (hard reset) | shutdown (graceful). The last three need the server's name typed. */
  async power(userId: string, serverId: string, body: OobPowerInput): Promise<OobActionResult> {
    const r = await this.resolve(userId, serverId);
    if ((OOB_DESTRUCTIVE_POWER_ACTIONS as readonly string[]).includes(body.action)) this.requireConfirm(r.server, body.confirmName);
    const providerAction = await this.run(userId, r, `power.${body.action}`, { action: body.action }, () => r.client.power(r.token, r.providerServerId, body.action as OobPowerAction));
    return { ok: true, action: body.action, providerAction };
  }

  /** Enable the provider's rescue system. The one-time root password is returned here and nowhere else. */
  async enableRescue(userId: string, serverId: string): Promise<OobRescueResult> {
    const r = await this.resolve(userId, serverId);
    let rootPassword = "";
    const providerAction = await this.run(userId, r, "rescue.enable", {}, async () => {
      const res = await r.client.enableRescue(r.token, r.providerServerId);
      rootPassword = res.rootPassword;
      return res.action;
    });
    return { ok: true, action: "enable_rescue", providerAction, rootPassword, expiresInMinutes: RESCUE_EXPIRES_MINUTES };
  }

  async disableRescue(userId: string, serverId: string): Promise<OobActionResult> {
    const r = await this.resolve(userId, serverId);
    const providerAction = await this.run(userId, r, "rescue.disable", {}, () => r.client.disableRescue(r.token, r.providerServerId));
    return { ok: true, action: "disable_rescue", providerAction };
  }

  /** Ask the provider for a console session. The URL and VNC password are returned once and valid for a minute. */
  async console(userId: string, serverId: string): Promise<OobConsoleResult> {
    const r = await this.resolve(userId, serverId);
    let session: { wssUrl: string; password: string; validForSeconds: number } = { wssUrl: "", password: "", validForSeconds: 0 };
    const providerAction = await this.run(userId, r, "console", {}, async () => {
      const res = await r.client.requestConsole(r.token, r.providerServerId);
      session = { wssUrl: res.wssUrl, password: res.password, validForSeconds: res.validForSeconds };
      return res.action;
    });
    return { ok: true, action: "console", providerAction, ...session };
  }

  // ───────────────────────────── linking ─────────────────────────────

  /** The VMs the chosen credential can see, to pick the one this server runs on (servers:manage). */
  async candidates(userId: string, serverId: string, cloudCredentialId: string): Promise<OobCandidate[]> {
    const server = await this.requireServer(serverId);
    await this.access.requirePermission(userId, server.teamId, "servers:manage");
    const { client, token } = await this.credentialClient(server, cloudCredentialId);
    let list;
    try {
      list = await client.listServers(token);
    } catch (e) {
      throw oobHttpError(client.name, e);
    }
    const used = await this.prisma.server.findMany({
      where: { cloudCredentialId, providerServerId: { not: null }, id: { not: serverId } },
      select: { providerServerId: true },
    });
    const taken = new Set(used.map((u) => u.providerServerId));
    return list.map((s) => ({ ...s, matchesIp: !!server.publicIp && s.publicIpv4 === server.publicIp, taken: taken.has(s.providerServerId) }));
  }

  /**
   * Link an EXISTING server to its provider VM (servers:manage). A wrong link would power off someone else's machine, so
   * the provider server is read first and its public IPv4 must equal this server's; if that cannot be shown (IP unknown
   * or different, e.g. a floating IP) the caller must type the provider server's name. A hand link never lets Tugra
   * destroy the VM (providerManualLink). Servers Tugra provisioned are linked already, at provision time.
   */
  async link(userId: string, serverId: string, body: OobLinkInput): Promise<OobStatusView> {
    const server = await this.requireServer(serverId);
    await this.access.requirePermission(userId, server.teamId, "servers:manage");
    // Tugra-owned rows (provider set, not a hand link) are never re-pointed: it would flip providerManualLink on a VM
    // Tugra created and leak it on delete. The one allowed change is a credential that was deleted: the SAME VM may be
    // re-attached to a new credential, and the row stays Tugra-owned (providerManualLink false).
    const tugraOwned = !!server.provider && !server.providerManualLink;
    if (tugraOwned) {
      if (!server.providerServerId) throw new ConflictException("this server is still being provisioned by Tugra; try again once it is created");
      if (server.cloudCredentialId) throw new ConflictException("this server was provisioned by Tugra and is already linked to its cloud server");
      if (body.providerServerId !== server.providerServerId) {
        throw new ConflictException("this server was provisioned by Tugra; only its own cloud server can be linked again after its credential was deleted");
      }
    }
    const { client, token, credentialName } = await this.credentialClient(server, body.cloudCredentialId);
    let state;
    try {
      state = await client.getServerState(token, body.providerServerId);
    } catch (e) {
      throw oobHttpError(client.name, e);
    }
    const ipVerified = !!server.publicIp && state.publicIpv4 === server.publicIp;
    if (!ipVerified && body.confirmProviderName !== state.name) {
      throw new ConflictException({
        statusCode: 409,
        message: server.publicIp
          ? `the cloud server's public IP (${state.publicIpv4 ?? "none"}) is not this server's (${server.publicIp}); type the cloud server's name ("${state.name}") to confirm it is the same machine`
          : `this server's public IP is not known yet, so the link cannot be checked; type the cloud server's name ("${state.name}") to confirm it is the same machine`,
        code: "oob_link_unverified",
        providerServerName: state.name,
      });
    }
    const dup = await this.prisma.server.findFirst({ where: { cloudCredentialId: body.cloudCredentialId, providerServerId: body.providerServerId, id: { not: serverId } }, select: { id: true } });
    if (dup) throw new ConflictException("that cloud server is already linked to another server");
    await this.prisma.server.update({
      where: { id: serverId },
      data: { provider: client.name, providerServerId: body.providerServerId, cloudCredentialId: body.cloudCredentialId, providerManualLink: !tugraOwned },
    });
    await this.audit.log({
      actor: userId,
      action: "server.oob.link",
      target: serverId,
      meta: { provider: client.name, providerServerId: body.providerServerId, credential: credentialName, ipVerified },
    });
    return this.status(userId, serverId);
  }

  /** Remove a HAND link (servers:manage). A link Tugra made at provision time stays: it also drives destroy-on-delete. */
  async unlink(userId: string, serverId: string): Promise<OobStatusView> {
    const server = await this.requireServer(serverId);
    await this.access.requirePermission(userId, server.teamId, "servers:manage");
    if (!server.providerServerId) throw new BadRequestException("this server is not linked to a cloud server");
    if (!server.providerManualLink) throw new ConflictException("this server was provisioned by Tugra; its link cannot be removed");
    await this.prisma.server.update({ where: { id: serverId }, data: { provider: null, providerServerId: null, cloudCredentialId: null, providerManualLink: false } });
    await this.audit.log({ actor: userId, action: "server.oob.unlink", target: serverId, meta: { provider: server.provider, providerServerId: server.providerServerId } });
    return this.status(userId, serverId);
  }

  // ───────────────────────────── internals ─────────────────────────────

  private async requireServer(serverId: string): Promise<Server> {
    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundException("server not found");
    return server;
  }

  /** Authorise (servers:ops) and resolve the link + client + token for an action. */
  private async resolve(userId: string, serverId: string): Promise<Resolved> {
    const server = await this.requireServer(serverId);
    await this.access.requirePermission(userId, server.teamId, "servers:ops");
    if (!server.provider || !server.providerServerId) throw new ConflictException({ statusCode: 409, message: "this server is not linked to a cloud server", code: "oob_not_linked" });
    const client = this.providers.getOob(server.provider);
    if (!client) throw new BadRequestException(`out-of-band actions are not available for ${server.provider} yet`);
    if (!server.cloudCredentialId) {
      throw new ConflictException({ statusCode: 409, message: "the cloud credential of this server was deleted; link the server again", code: "oob_credential_missing" });
    }
    const cred = await this.prisma.cloudCredential.findUnique({ where: { id: server.cloudCredentialId } });
    if (!cred || cred.teamId !== server.teamId) {
      throw new ConflictException({ statusCode: 409, message: "the cloud credential of this server was deleted; link the server again", code: "oob_credential_missing" });
    }
    return { server, client, token: this.crypto.decrypt(cred.apiTokenEnc), providerServerId: server.providerServerId };
  }

  private async credentialClient(server: Server, cloudCredentialId: string): Promise<{ client: CloudOobProvider; token: string; credentialName: string }> {
    const cred = await this.prisma.cloudCredential.findUnique({ where: { id: cloudCredentialId } });
    if (!cred || cred.teamId !== server.teamId) throw new NotFoundException("cloud credential not found");
    const client = this.providers.getOob(cred.provider);
    if (!client) throw new BadRequestException(`out-of-band actions are not available for ${cred.provider} yet`);
    return { client, token: this.crypto.decrypt(cred.apiTokenEnc), credentialName: cred.name };
  }

  private requireConfirm(server: Server, confirmName: string | undefined): void {
    if (confirmName !== server.name) {
      throw new BadRequestException({ statusCode: 400, message: "confirmation name does not match the server name", code: "oob_confirm_mismatch" });
    }
  }

  /** Audit BEFORE the provider call; map a provider failure to a clear HTTP error (and note it in the audit). */
  private async run(userId: string, r: Resolved, what: string, extra: Record<string, unknown>, call: () => Promise<ProviderActionResult>): Promise<ProviderActionResult> {
    const meta = { provider: r.server.provider, providerServerId: r.providerServerId, ...extra };
    await this.audit.log({ actor: userId, action: `server.oob.${what}`, target: r.server.id, meta });
    try {
      return await call();
    } catch (e) {
      const mapped = oobHttpError(r.server.provider ?? "provider", e, true);
      await this.audit
        .log({ actor: userId, action: `server.oob.${what}.failed`, target: r.server.id, meta: { ...meta, httpStatus: mapped.getStatus() } })
        .catch(() => undefined);
      throw mapped;
    }
  }
}

/**
 * Provider failure -> an HTTP error a person can act on. Messages come from the provider's RESPONSE body (never the
 * request, so never the token). 401/403 are NOT passed through as such: they would read as "you are not logged in to
 * Tugra" (and a browser session would be dropped), when it is the stored cloud credential that was refused.
 * `mutating`: the call was an action; a timeout then means the provider may have executed it, and the message says so.
 */
export function oobHttpError(provider: string, e: unknown, mutating = false): HttpException {
  const status = typeof (e as { status?: unknown })?.status === "number" ? (e as { status: number }).status : -1;
  const code = (e as { hetznerError?: { code?: string } })?.hetznerError?.code;
  const msg = e instanceof Error && e.message ? e.message : `${provider} api error`;
  const body = (statusCode: number, code: string, message: string) => ({ statusCode, message, code });
  if (status === 0 && (e as { timedOut?: unknown })?.timedOut === true) {
    return new HttpException(
      body(
        504,
        "oob_provider_timeout",
        mutating
          ? `${provider} did not answer in time; the action may or may not have been carried out: check the server's state before trying again`
          : `${provider} did not answer in time; try again`,
      ),
      504,
    );
  }
  if (status === 0) return new HttpException(body(502, "oob_provider_unreachable", `${provider} api unreachable`), 502);
  if (status === 401 || (status === 403 && code !== "maintenance")) {
    return new HttpException(body(424, "oob_credential_rejected", `${provider} rejected the stored API token (it needs Read & Write access); update it under Cloud providers`), 424);
  }
  if (status === 403) return new HttpException(body(503, "oob_provider_maintenance", msg), 503);
  if (status === 404) return new HttpException(body(409, "oob_provider_server_missing", `the server no longer exists at ${provider} (or belongs to another project); link it again`), 409);
  if (status === 423) {
    return new HttpException(
      body(409, code === "protected" ? "oob_protected" : "oob_locked", code === "protected" ? `${provider}: this action is protected for this server` : `another action is already running on this server at ${provider}; wait a moment and try again`),
      409,
    );
  }
  if (status === 422 && code !== "service_error") return new HttpException(body(422, "oob_unsupported", msg), 422);
  if (status === 429) return new HttpException(body(429, "oob_rate_limited", `${provider} is rate limiting requests; try again later`), 429);
  if (status === 504) return new HttpException(body(504, "oob_provider_timeout", msg), 504);
  return new HttpException(body(502, "oob_provider_error", msg), 502);
}
