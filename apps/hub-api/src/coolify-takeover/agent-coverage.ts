import type { ImportMappingDoc } from "../importer/import-mapping";
import { hostOfItemRef, UNKNOWN_HOST } from "../migration-runs/core/run-scope";

/**
 * "A move starts only when both ends have an agent" (Coolify hub takeover, lane C): which SOURCE servers of a plan have no agent online.
 * Pure. The target side is already gated by the run's own readiness check. A server counts as covered when the plan matched it to a registered
 * Tugra server whose agent is online (`agentOnline`); otherwise it is flagged with why, and the owner is shown how to install one: over
 * Coolify's keys in one click when the Coolify host is connected through its agent, or with the install command (or a cloud console / cloud-init
 * snippet) when only the API token is.
 */

export type AgentGapState = "no_agent" | "offline";

export interface AgentGap {
  ref: string;
  name: string;
  state: AgentGapState;
}

export interface CoveragePlan {
  items: ReadonlyArray<{ itemRef: string; kind: string }>;
  preflight?: { hosts?: ReadonlyArray<{ ref: string; name?: string; tugra?: { serverId: string }; agentOnline?: boolean }> };
}

const placeable = (kind: string): boolean => kind === "app" || kind === "database" || kind === "service";

/**
 * The source servers a move would take something from and that have no online agent. `mapping` is the run's frozen mapping: an item it
 * leaves out (`include: false`) takes no part, so a server whose items are all left out needs no agent. `unverified` is true when the plan
 * carries no placement facts at all (the lookup failed): nothing can be said, and the caller must not start a move on that.
 */
export function sourceAgentGaps(plan: CoveragePlan, mapping?: Pick<ImportMappingDoc, "items"> | null): { gaps: AgentGap[]; unverified: boolean } {
  const used = new Set<string>();
  for (const it of plan.items) {
    if (!placeable(it.kind)) continue;
    if (mapping?.items?.[it.itemRef]?.include === false) continue;
    const h = hostOfItemRef(it.itemRef);
    if (h !== UNKNOWN_HOST) used.add(h);
  }
  if (used.size === 0) return { gaps: [], unverified: false };
  const hosts = plan.preflight?.hosts;
  if (!hosts || hosts.length === 0) return { gaps: [], unverified: true };
  const byRef = new Map(hosts.map((h) => [h.ref, h] as const));
  const gaps: AgentGap[] = [];
  for (const ref of [...used].sort()) {
    const h = byRef.get(ref);
    if (!h) return { gaps: [], unverified: true }; // an item on a server the plan does not describe
    if (h.agentOnline === true) continue;
    if (h.agentOnline === undefined) return { gaps: [], unverified: true };
    gaps.push({ ref, name: h.name ?? ref, state: h.tugra ? "offline" : "no_agent" });
  }
  return { gaps, unverified: false };
}
