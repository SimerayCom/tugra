import type { ServerView, Monitor, DomainView } from "./types";

export interface AttentionItem {
  kind: "server" | "monitor" | "domain";
  id: string;
  name: string;
  status: string;
}

/** Fleet items that need attention now: offline servers, down monitors, bad SSL certs. */
export function fleetAttention(
  servers: ServerView[],
  monitors: Monitor[],
  domains: DomainView[] = [],
): AttentionItem[] {
  const offline = servers
    .filter((s) => s.status === "OFFLINE")
    .map((s) => ({ kind: "server" as const, id: s.id, name: s.name, status: s.status }));
  const down = monitors
    .filter((m) => m.status === "DOWN")
    .map((m) => ({ kind: "monitor" as const, id: m.id, name: m.name, status: m.status }));
  const certs = domains
    .filter((d) => d.ssl.state !== "ok")
    // link to the owning app (id = appId)
    .map((d) => ({ kind: "domain" as const, id: d.appId, name: d.domain, status: d.ssl.state }));
  return [...offline, ...down, ...certs];
}
