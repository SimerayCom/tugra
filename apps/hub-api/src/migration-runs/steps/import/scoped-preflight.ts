/**
 * The plan's `preflight` block narrowed to what one run moves, pure. The importer plans the whole source, so its rows (manual data,
 * skipped stacks, bind mounts, generated hosts, source servers) cover every team and server the session can see. A run that moves one
 * server must be judged by its own items only: another server's bind mount or another team's host must never reach its checks, its
 * approval or its counts. A run that moves the whole plan gets the block back untouched.
 */
import type { ImportPlanResponse } from "../../../importer/importer.service";
import { hostOfItemRef } from "../../core/run-scope";

type Plan = Pick<ImportPlanResponse, "items" | "preflight">;
type PlanPreflight = NonNullable<ImportPlanResponse["preflight"]>;

const placeable = (kind: string): boolean => kind === "app" || kind === "database" || kind === "service";

/**
 * A row names its item by `itemRef` (every plan the hub builds does); an older row has only a name, which is matched against the kept
 * items of that kind. A name that belongs to no item of the plan at all is kept: it is never hidden on a guess.
 */
function rowKept(row: { itemRef?: string }, name: string, kind: string, plan: Plan, keptRefs: ReadonlySet<string>): boolean {
  if (row.itemRef) return keptRefs.has(row.itemRef);
  const same = plan.items.filter((i) => i.kind === kind && i.name === name);
  return same.length === 0 || same.some((i) => keptRefs.has(i.itemRef));
}

export function scopedPreflight(plan: Plan, items: ImportPlanResponse["items"]): ImportPlanResponse["preflight"] {
  const pf = plan.preflight;
  if (!pf || items.length === plan.items.length) return pf;
  const keptRefs = new Set(items.map((i) => i.itemRef));
  const out: PlanPreflight = {
    ...pf,
    databases: pf.databases.filter((d) => rowKept(d, d.name, "database", plan, keptRefs)),
    services: pf.services.filter((s) => rowKept(s, s.name, "service", plan, keptRefs)),
    ...(pf.volumes ? { volumes: pf.volumes.filter((v) => rowKept(v, v.app, "app", plan, keptRefs)) } : {}),
  };
  if (pf.hosts) {
    // a source server whose every item is left out is not part of this run; a server the plan holds no item for at all stays (it is "empty")
    const planned = new Set(plan.items.filter((i) => placeable(i.kind)).map((i) => hostOfItemRef(i.itemRef)));
    const kept = new Set(items.filter((i) => placeable(i.kind)).map((i) => hostOfItemRef(i.itemRef)));
    out.hosts = pf.hosts.filter((h) => kept.has(h.ref) || !planned.has(h.ref));
  }
  if (pf.cutover) {
    // the hint lists hosts, not items: a host counts for this run when a kept item serves it as its primary domain
    const served = new Set(items.map((i) => (typeof i.proposed.domain === "string" ? i.proposed.domain.trim().toLowerCase() : "")).filter(Boolean));
    out.cutover = { ...pf.cutover, generatedHosts: pf.cutover.generatedHosts.filter((h) => served.has(h)), counterpartHosts: pf.cutover.counterpartHosts.filter((h) => served.has(h)) };
  }
  return out;
}
