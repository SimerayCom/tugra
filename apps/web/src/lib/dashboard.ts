import type { ServerView, Monitor } from "./types";

export interface AttentionItem {
  kind: "server" | "monitor";
  id: string;
  name: string;
  status: string;
}

/** Fleet items that need attention right now: offline servers + down monitors. */
export function fleetAttention(servers: ServerView[], monitors: Monitor[]): AttentionItem[] {
  const offline = servers
    .filter((s) => s.status === "OFFLINE")
    .map((s) => ({ kind: "server" as const, id: s.id, name: s.name, status: s.status }));
  const down = monitors
    .filter((m) => m.status === "DOWN")
    .map((m) => ({ kind: "monitor" as const, id: m.id, name: m.name, status: m.status }));
  return [...offline, ...down];
}
