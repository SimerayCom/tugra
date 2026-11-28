import { inPlaceCount, overallPlacement, type ImportScope } from "./import-scope";

// The preview's one start action: what it says, and why it is off. Pure, so the label and the reason are tested without the page.

/** Where the review page has to jump to for the owner to answer. */
export const START_ANCHOR = { warnings: "import-env-blockers", services: "import-services", consent: "import-consent" } as const;

export interface StartInput {
  scope: Pick<ImportScope, "placed" | "placementKind" | "multiTeam"> | null;
  /** The plan is being read again. */
  replanning: boolean;
  /** An agent session without the consent for secret values. */
  consentMissing: boolean;
  /** Items that can be created after the acknowledgements (0 = nothing can move). */
  runnable: number;
  /** Warnings that still need an answer. */
  unackedCount: number;
  /** Service stacks that still need a target server. */
  missingTargets: number;
  /** The one Tugra server every copied source lands on, when there is exactly one. */
  targetName?: string;
}

export interface StartLabel {
  key: string;
  params: Record<string, string | number>;
}

/** What the start button says: the servers it moves and how (in place, to another server, or both). */
export function startLabel(i: Pick<StartInput, "scope" | "targetName">): StartLabel {
  const s = i.scope;
  if (!s) return { key: "migrationRun.launch.start.generic", params: {} };
  const total = Object.keys(s.placed).length;
  const inPlace = inPlaceCount(s);
  const placement = overallPlacement(s);
  if (placement === "in-place") return { key: inPlace === 1 ? "migrationRun.launch.start.inPlaceOne" : "migrationRun.launch.start.inPlaceMany", params: { count: inPlace } };
  if (placement === "mixed") return { key: "migrationRun.launch.start.mixed", params: { copy: total - inPlace, inPlace } };
  const targets = new Set(Object.values(s.placed));
  if (targets.size === 1 && i.targetName) return { key: "migrationRun.launch.start.toServer", params: { server: i.targetName } };
  return { key: "migrationRun.launch.start.toServers", params: { count: Math.max(total, 1) } };
}

export interface StartBlock {
  key: string;
  params: Record<string, string | number>;
  /** The element id on the page that holds the answer (absent = nothing to jump to). */
  anchor?: string;
}

/** Why the start button is off, in the order the owner can fix it (null = ready). One line, with where to go. */
export function startBlock(i: StartInput): StartBlock | null {
  if (i.replanning) return { key: "migrationRun.launch.start.why.reading", params: {} };
  if (i.consentMissing) return { key: "migrationRun.launch.start.why.consent", params: {}, anchor: START_ANCHOR.consent };
  if (i.unackedCount > 0) return { key: "migrationRun.launch.start.why.warnings", params: { count: i.unackedCount }, anchor: START_ANCHOR.warnings };
  if (i.missingTargets > 0) return { key: "migrationRun.launch.start.why.services", params: { count: i.missingTargets }, anchor: START_ANCHOR.services };
  if (i.runnable === 0) return { key: "migrationRun.launch.start.why.nothing", params: {} };
  return null;
}
