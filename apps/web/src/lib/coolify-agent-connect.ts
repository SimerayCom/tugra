import type { ServerView } from "./types";

/**
 * The servers the agent path can read Coolify from: any server the user can write to (the Coolify host may sit in any of their teams;
 * the connection belongs to that server's team), online ones first. Offline ones stay listed, marked, so the reason is visible.
 */
export function agentReadyServers(servers: readonly Pick<ServerView, "id" | "name" | "teamId" | "status" | "canWrite">[]): Array<{ id: string; name: string; teamId: string; online: boolean }> {
  return servers
    .filter((s) => s.canWrite)
    .map((s) => ({ id: s.id, name: s.name, teamId: s.teamId, online: s.status === "ONLINE" }))
    .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
}
