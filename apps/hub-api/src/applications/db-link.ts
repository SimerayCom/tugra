import type { DbEngine } from "../databases/database-script";

/**
 * DB<->App linking policy (pure, no I/O — unit-tested in isolation).
 *
 * v1 is INTERNAL-only: a link injects the database's node-local (tugra-net) connection URI into the
 * app's runtime env. That bridge only resolves for a classic, non-compose app with no custom --network,
 * co-located on the SAME server as the database. Every other topology (swarm/cluster, compose, a custom
 * network, or a different server) is refused at link time with a reason — never a silently dead link.
 * Public / cross-server linking is a later, explicit opt-in (it would send credentials in clear text).
 */

export type LinkRouteReason = "swarm-app" | "compose-app" | "custom-network" | "cross-server";

export interface LinkRoute {
  route: "internal" | null;
  reason?: LinkRouteReason;
}

export interface LinkRouteApp {
  clusterId: string | null;
  source: string; // "IMAGE" | "GIT" | "COMPOSE"
  serverId: string;
  /** Whether the app's docker options declare a custom --network (computed by the caller via hasNetworkOpt). */
  hasCustomNetwork: boolean;
}

/** Decide whether an app can receive this database's internal URI, and why not when it can't. */
export function linkRoute(app: LinkRouteApp, db: { serverId: string }): LinkRoute {
  if (app.clusterId) return { route: null, reason: "swarm-app" };
  if (app.source === "COMPOSE") return { route: null, reason: "compose-app" };
  if (app.hasCustomNetwork) return { route: null, reason: "custom-network" };
  if (app.serverId !== db.serverId) return { route: null, reason: "cross-server" };
  return { route: "internal" };
}

/** Human-facing explanation for an ineligible link (used in API errors + the web picker). */
export function linkRouteReasonText(reason: LinkRouteReason): string {
  switch (reason) {
    case "swarm-app":
      return "a swarm/cluster app deploys on the overlay and can't reach a node-local database by name";
    case "compose-app":
      return "a compose app manages its own networks — declare tugra-net in the compose file instead";
    case "custom-network":
      return "remove the --network flag from this app's docker options before linking a database";
    case "cross-server":
      return "the database is on a different server — same-server linking only in this version";
  }
}

const DEFAULT_ENV_VAR: Record<DbEngine, string> = {
  POSTGRES: "DATABASE_URL",
  MYSQL: "DATABASE_URL",
  MARIADB: "DATABASE_URL",
  REDIS: "REDIS_URL",
  KEYDB: "REDIS_URL",
  DRAGONFLY: "REDIS_URL",
  MONGO: "MONGO_URL",
  CLICKHOUSE: "CLICKHOUSE_URL",
  LIBSQL: "DATABASE_URL",
};

/** The conventional env var name an engine's connection URI is injected under, unless overridden. */
export function defaultEnvVar(engine: DbEngine): string {
  return DEFAULT_ENV_VAR[engine] ?? "DATABASE_URL";
}
