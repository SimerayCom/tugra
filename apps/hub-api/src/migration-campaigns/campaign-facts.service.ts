import { ConflictException, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { ImporterService } from "../importer/importer.service";
import type { PreflightHost } from "../importer/foreign-fleet";
import type { PlacementHostFact, PlacementTarget } from "./campaign-plan";

/** The facts a placement is checked against: the source servers of a fresh plan, and the Tugra servers it may name. */
export interface CampaignFacts {
  planHash: string;
  hosts: PlacementHostFact[];
  targets: Map<string, PlacementTarget>;
  /** The app item refs of the plan (what a rebuild choice is checked against). */
  appRefs: ReadonlySet<string>;
}

/** One source server of the plan as a placement fact. The verdict comes from the host match when the plan has one, else from the older address verdict. */
export function hostFactOf(h: PreflightHost, onlineIds: ReadonlySet<string>, teamMap?: Readonly<Record<string, string | null>>): PlacementHostFact {
  const status = h.match?.status ?? (h.tugra ? (h.tugra.confidence === "certain" ? "certain" : "probable") : "none");
  const matchedServerId = status === "certain" || status === "probable" ? (h.tugra?.serverId ?? null) : null;
  return {
    ref: h.ref,
    name: h.name ?? h.ref,
    controlPlane: h.controlPlane === true,
    matchStatus: status,
    linkedBy: h.match?.linkedBy ?? null,
    evidence: h.match?.evidence ?? [],
    matchedServerId,
    agentOnline: matchedServerId !== null && onlineIds.has(matchedServerId),
    ...(h.team && teamMap?.[h.team.ref] ? { mappedTeamId: teamMap[h.team.ref] as string } : {}),
  };
}

@Injectable()
export class CampaignFactsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly importer: ImporterService,
  ) {}

  /**
   * Read the plan of the session (the importer checks the session belongs to the caller) and the readiness of the servers named. A plan
   * that no longer has the hash the owner reviewed is a 409: a placement is never decided on facts the owner did not see.
   */
  async read(userId: string, input: { sessionId: string; planHash: string; serverIds: readonly string[] }): Promise<CampaignFacts> {
    const plan = await this.importer.plan(userId, { sourceKind: "coolify", sessionId: input.sessionId });
    if (plan.planHash !== input.planHash) throw new ConflictException("plan-changed");
    const matched = (plan.preflight?.hosts ?? []).map((h) => h.tugra?.serverId).filter((x): x is string => !!x);
    const ids = [...new Set([...matched, ...input.serverIds])];
    const rows = ids.length ? await this.prisma.server.findMany({ where: { id: { in: ids } }, select: { id: true, teamId: true, status: true, capabilities: true } }) : [];
    const online = new Set(rows.filter((r) => r.status === "ONLINE").map((r) => r.id));
    const targets = new Map<string, PlacementTarget>();
    for (const r of rows) targets.set(r.id, { id: r.id, teamId: r.teamId, ready: r.status === "ONLINE" && r.capabilities.includes("deploy") });
    return { planHash: plan.planHash, hosts: (plan.preflight?.hosts ?? []).map((h) => hostFactOf(h, online, plan.preflight?.teamMap)), targets, appRefs: new Set(plan.items.filter((i) => i.kind === "app").map((i) => i.itemRef)) };
  }
}
