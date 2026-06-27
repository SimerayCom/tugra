import type { Channel } from "./types";

/** Notification channels scoped to the active team (empty team = no scope → all). */
export function visibleChannels(channels: Channel[], activeTeamId: string): Channel[] {
  if (!activeTeamId) return channels;
  return channels.filter((c) => c.teamId === activeTeamId);
}
