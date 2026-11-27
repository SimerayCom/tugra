import type { ServerView } from "./types";
import { serverBlock, type CtaBlock } from "./cta-readiness";

/**
 * The servers the agent path can read Coolify from: any server the user can write to (the Coolify host may sit in any of their teams;
 * the connection belongs to that server's team), online ones first. Offline ones stay listed, marked, so the reason is visible. A server
 * whose agent has not been granted the `database` capability is listed too, with that as its `block`: the read cannot work there, and the
 * picker says so instead of leaving a button that stays off with no word.
 */
export function agentReadyServers(servers: readonly Pick<ServerView, "id" | "name" | "teamId" | "status" | "canWrite" | "capabilities">[]): Array<{ id: string; name: string; teamId: string; online: boolean; block: CtaBlock | null }> {
  return servers
    .filter((s) => s.canWrite)
    .map((s) => ({ id: s.id, name: s.name, teamId: s.teamId, online: s.status === "ONLINE", block: serverBlock(s, ["database"]) }))
    .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
}
