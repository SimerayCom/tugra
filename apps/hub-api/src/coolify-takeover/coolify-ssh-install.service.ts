import { Injectable } from "@nestjs/common";

/**
 * Install the Tugra agent on the servers a Coolify knows, over Coolify's own SSH keys through the agent on the Coolify host (Coolify hub
 * takeover, lane C): probe, mint a token only after a READY probe, install, wait for enroll, cross-check the host key, uninstall.
 * An empty skeleton; lane C owns this file. Team OWNER only, audited as coolify.ssh.probe / install / uninstall.
 */
@Injectable()
export class CoolifySshInstallService {}
