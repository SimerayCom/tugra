/**
 * Which source hosts a run covers and which of its items live on each (pure). Every plan item ref carries the Coolify server
 * uuid it lives on (`app:<serverRef|_>:<uuid>`, `database:...`, `volume:<serverRef|_>:<uuid>:<vol>`); a run's `serverMap` names the
 * hosts the owner placed explicitly. The `coolify-host-loop` runner and the per-host inventory loop over the union.
 */
import { hostLoopTargets, type ServerMapped } from "../../../core/run-contract";
import type { DataSnapshot } from "../data-contract";

export type HostItems = Pick<DataSnapshot, "databases" | "volumes" | "apps" | "services">;

/** The server ref inside an item ref, or `_` when the source did not say (`app:_:<uuid>`). */
export const serverRefOfItem = (itemRef: string): string => itemRef.split(":")[1] ?? "_";

/** Every source host of the run, sorted: the serverMap's keys and the refs of the plan items (the unknown `_` is not a host). */
export function sourceHostsOf(run: ServerMapped, items: HostItems): string[] {
  const hosts = new Set<string>(hostLoopTargets(run).map((t) => t.sourceServerRef));
  for (const ref of [...items.databases.map((d) => d.itemRef), ...items.volumes.map((v) => v.itemRef), ...items.apps.map((a) => a.itemRef), ...items.services.map((s) => s.itemRef)]) {
    const sr = serverRefOfItem(ref);
    if (sr !== "_") hosts.add(sr);
  }
  return [...hosts].sort();
}

/** The data items (databases and the volumes that move) of one host: what a host's migrator is restricted to with `--only`. */
export function dataItemsOfHost(host: string, items: Pick<DataSnapshot, "databases" | "volumes">): string[] {
  return [...items.databases.map((d) => d.itemRef), ...items.volumes.filter((v) => !v.excluded).map((v) => v.itemRef)].filter((r) => serverRefOfItem(r) === host).sort();
}

/** Every itemRef of the plan (for the cross-check). */
export const planRefsOf = (items: HostItems): string[] => [...items.databases.map((d) => d.itemRef), ...items.volumes.map((v) => v.itemRef), ...items.apps.map((a) => a.itemRef), ...items.services.map((s) => s.itemRef)];
