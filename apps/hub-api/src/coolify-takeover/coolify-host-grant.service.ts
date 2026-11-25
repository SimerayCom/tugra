import { Injectable } from "@nestjs/common";

/**
 * Consent grants on a Coolify host (Coolify hub takeover, lane B; the "ssh" kind is used by lane C): create, expire and revoke a
 * `CoolifyHostGrant`, and turn the matching agent capability on and off with it. An empty skeleton; lane B owns this file.
 * Team OWNER only, audited as coolify.secrets.grant / coolify.secrets.revoke and coolify.ssh.grant / coolify.ssh.revoke.
 */
@Injectable()
export class CoolifyHostGrantService {}
