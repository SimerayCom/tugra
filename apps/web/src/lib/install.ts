import type { ServerView } from "./types";

// A template can only be installed onto a server that is online and reachable.
export function installableServers(servers: ServerView[]): ServerView[] {
  return servers.filter((s) => s.status === "ONLINE");
}

// The server to install onto without asking: exactly one online server → its id;
// zero or many → null (blocked, or the user must choose).
export function autoServerId(servers: ServerView[]): string | null {
  const online = installableServers(servers);
  return online.length === 1 ? online[0].id : null;
}
