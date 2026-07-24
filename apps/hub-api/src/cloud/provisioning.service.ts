import { BadGatewayException, BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { isIP } from "node:net";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { CryptoService } from "../crypto/crypto.service";
import { TeamAccessService } from "../common/team-access.service";
import { ServersService, type ServerView } from "../servers/servers.service";
import { isPublicIp } from "../common/observed-ip";
import { CloudProviderFactory } from "./providers/provider-factory.service";
import type { CloudServerCreateResult } from "./providers/cloud-provider.interface";
import { buildCloudInitUserData } from "./cloud-init";
import { HETZNER_DEFAULT_IMAGE, isValidHetznerImage, isValidHetznerLocation, isValidHetznerServerType } from "./hetzner-catalog";
import type { ProvisionServerInput } from "./dto";

/**
 * Creates a VM on a cloud provider and lets it auto-enroll. Synchronous: the provider create call
 * returns as soon as the VM is scheduled; the VM's cloud-init installs Docker + runs the existing
 * agent installer, and the normal WS enroll flips the Server row PENDING→ONLINE. No background job.
 */
@Injectable()
export class ProvisioningService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly servers: ServersService,
    private readonly providers: CloudProviderFactory,
  ) {}

  async provision(userId: string, dto: ProvisionServerInput): Promise<ServerView> {
    await this.access.requirePermission(userId, dto.teamId, "servers:manage"); // authz FIRST

    const hubUrl = process.env.HUB_PUBLIC_URL;
    if (!hubUrl || !isPubliclyReachableUrl(hubUrl)) {
      throw new BadRequestException("set HUB_PUBLIC_URL to a publicly reachable URL before provisioning cloud servers");
    }
    if (!isValidHetznerLocation(dto.location)) throw new BadRequestException("unknown location");
    if (!isValidHetznerServerType(dto.serverType)) throw new BadRequestException("unknown server type");
    const image = dto.image ?? HETZNER_DEFAULT_IMAGE;
    if (!isValidHetznerImage(image)) throw new BadRequestException("unknown image");

    const cred = await this.prisma.cloudCredential.findUnique({ where: { id: dto.cloudCredentialId } });
    if (!cred || cred.teamId !== dto.teamId) throw new NotFoundException("cloud credential not found");
    const client = this.providers.get(cred.provider); // BadRequest if the provider has no client
    const token = this.crypto.decrypt(cred.apiTokenEnc);

    // Row FIRST — the enroll token must exist in the DB before the VM can boot and try to use it.
    // provider + cloudCredentialId are written atomically here so a later delete can destroy the VM.
    const { server, installCommand } = await this.servers.createServer(userId, dto.name, dto.teamId, hubUrl, {
      provider: cred.provider,
      cloudCredentialId: cred.id,
    });

    let created: CloudServerCreateResult;
    try {
      created = await client.createServer(token, {
        name: dto.name,
        location: dto.location,
        serverType: dto.serverType,
        image,
        userData: buildCloudInitUserData(installCommand), // carries only the enroll token
      });
    } catch (e) {
      // Compensate: the provider never created a VM for this row → delete it, nothing orphaned.
      await this.prisma.server.delete({ where: { id: server.id } }).catch(() => undefined);
      await this.audit.log({ actor: userId, action: "server.provision.failed", target: server.id, meta: { provider: cred.provider } });
      throw new BadGatewayException(providerErrorMessage(cred.provider, e));
    }

    try {
      await this.prisma.server.update({
        where: { id: server.id },
        data: { providerServerId: created.providerServerId, publicIp: created.publicIp, publicIpv6: created.publicIpv6 },
      });
    } catch {
      // The VM booted (and is billing) but we couldn't record its id — without providerServerId a
      // later delete could never destroy it. Symmetric compensation: best-effort destroy the VM and
      // drop the row so nothing is orphaned. destroyServer talks straight to the provider (no DB), so
      // it still works when the DB itself is the thing that failed.
      await client.destroyServer(token, created.providerServerId).catch(() => undefined);
      await this.prisma.server.delete({ where: { id: server.id } }).catch(() => undefined);
      await this.audit
        .log({ actor: userId, action: "server.provision.failed", target: server.id, meta: { provider: cred.provider, providerServerId: created.providerServerId, stage: "persist" } })
        .catch(() => undefined);
      throw new BadGatewayException("provisioned the VM but could not record it — it was torn down; please retry");
    }
    await this.audit.log({
      actor: userId,
      action: "server.provision",
      target: server.id,
      meta: { provider: cred.provider, location: dto.location, serverType: dto.serverType, image },
    });
    return this.servers.getForUser(userId, server.id);
  }

  /** Best-effort VM teardown, invoked by ServersService.deleteForUser via ModuleRef. Never throws on
   *  a missing credential; a provider error propagates to the caller, which wraps it in `.catch()`. */
  async destroyVm(provider: string, cloudCredentialId: string, providerServerId: string): Promise<void> {
    const cred = await this.prisma.cloudCredential.findUnique({ where: { id: cloudCredentialId } });
    if (!cred) return; // credential already deleted — can't reach the provider, nothing more to do
    const token = this.crypto.decrypt(cred.apiTokenEnc);
    await this.providers.get(provider).destroyServer(token, providerServerId);
  }
}

/** The hub must be reachable from the freshly-booted VM. Reject localhost/.local and private IPs. */
export function isPubliclyReachableUrl(raw: string): boolean {
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!host || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return false;
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (isIP(bare)) return isPublicIp(bare); // an IP literal must be publicly routable
  return true; // a real DNS hostname — accepted (the hub itself never fetches this URL)
}

/** Provider error messages are response-derived + token-free (HetznerApiError guarantees this). */
function providerErrorMessage(provider: string, e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return `${provider}: could not create the server (${m})`;
}
