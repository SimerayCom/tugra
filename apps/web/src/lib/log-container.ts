// Which container the app's Logs tab should follow before the user picks one. Pure (no DOM) so it is unit-tested.
// A compose app has many containers; showing nothing until one is picked reads as "no logs". The right default
// is the app's main service: one that serves a link/domain, then one named like the app, then the first running
// container — preferring an application container over an obvious backing service (database, cache).

export interface LogContainer {
  name: string;
  state: string;
}

/** The compose service of a Tugra-managed container name (`tugra_<id>-<service>-<n>`, or the swarm task form
 *  `tugra_<id>-<service>.<slot>.<task>`); null for a bare app container or a container with a custom name. */
export function composeServiceOf(name: string): string | null {
  const swarm = /^tugra_[a-z0-9]+-(.+?)\.\d+\.[a-z0-9]+$/i.exec(name);
  if (swarm) return swarm[1];
  const m = /^tugra_[a-z0-9]+-(.+)-\d+$/i.exec(name);
  return m ? m[1] : null;
}

/** Strip the `tugra_<id>` project prefix so a container reads as its compose service ("wordpress", "db")
 *  instead of the raw `tugra_<cuid>-wordpress-1`. Handles the compose replica form, the swarm task form
 *  and the bare single-container form; any other name is returned unchanged. */
export function friendlyContainer(name: string): string {
  if (/^tugra_[a-z0-9]+(?:-(.+?))?\.\d+\.[a-z0-9]+$/i.test(name)) return composeServiceOf(name) ?? "container";
  const service = composeServiceOf(name);
  if (service) return service;
  if (/^tugra_[a-z0-9]+$/i.test(name)) return "container";
  return name;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const BACKING = /^(db|database|postgres(ql)?|pg|mysql|mariadb|mongo(db)?|redis|valkey|keydb|memcached|cache|minio|rabbitmq|elasticsearch|opensearch)$/;

/** Service names an app exposes through its links (`service` links carry the service, `port` links `service:port`). */
export function linkServices(links: readonly { kind: string; label: string | null }[] | undefined): string[] {
  const out: string[] = [];
  for (const l of links ?? []) {
    if ((l.kind !== "service" && l.kind !== "port") || !l.label) continue;
    const svc = l.label.split(":")[0];
    if (svc && !out.includes(svc)) out.push(svc);
  }
  return out;
}

/** How often the container list behind the Logs tab is re-read: quickly while nothing is running yet (a deploy or
 *  restart is in flight and the list is empty or only holds exited containers), slowly once something runs so a
 *  later restart/recreate is still noticed. */
export const CONTAINER_LIST_FAST_MS = 5_000;
export const CONTAINER_LIST_SLOW_MS = 30_000;
export function containerListRefetchMs(containers: readonly LogContainer[] | undefined): number {
  return containers?.some((c) => c.state.toLowerCase() === "running") ? CONTAINER_LIST_SLOW_MS : CONTAINER_LIST_FAST_MS;
}

export function pickDefaultLogContainer(containers: readonly LogContainer[], hints: { appName?: string; services?: readonly string[]; keep?: string } = {}): string | undefined {
  if (containers.length === 0) return undefined;
  const running = containers.filter((c) => c.state.toLowerCase() === "running");
  // Stay on the container already being followed while it is still running, so a refreshed list never makes the
  // stream hop to another service.
  if (hints.keep && running.some((c) => c.name === hints.keep)) return hints.keep;
  const pool = running.length > 0 ? running : containers;
  const svc = (c: LogContainer) => composeServiceOf(c.name);
  for (const want of hints.services ?? []) {
    const hit = pool.find((c) => svc(c) === want);
    if (hit) return hit.name;
  }
  const app = hints.appName ? slug(hints.appName) : "";
  if (app) {
    const exact = pool.find((c) => { const s = svc(c); return s != null && slug(s) === app; });
    if (exact) return exact.name;
    const prefixed = pool.find((c) => { const s = svc(c); return s != null && slug(s).startsWith(`${app}-`); });
    if (prefixed) return prefixed.name;
  }
  const nonBacking = pool.find((c) => { const s = svc(c); return !(s != null && BACKING.test(s.toLowerCase())); });
  return (nonBacking ?? pool[0]).name;
}
