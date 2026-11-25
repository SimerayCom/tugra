import type { HostIdentityFacts } from "@tugra/shared";
import type { CoolifyHostIdentityReader } from "./coolify-ssh-plan";

/**
 * What a Tugra agent says about its OWN machine's sshd host keys (it reports them with its host info), as the SSH install's cross-check
 * reads it. The facts are the agent's report held in memory by the servers service; nothing is stored here.
 */
export function hostIdentityReaderOf(servers: { hostIdentityOf(serverId: string): HostIdentityFacts | undefined }): CoolifyHostIdentityReader {
  return {
    reportedHostKeyFp: async (serverId) => servers.hostIdentityOf(serverId)?.sshHostKeyFp ?? null,
    reportedHostKeyFps: async (serverId) => [...(servers.hostIdentityOf(serverId)?.sshHostKeyFps ?? [])],
  };
}
