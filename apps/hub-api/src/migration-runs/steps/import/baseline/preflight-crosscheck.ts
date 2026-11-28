/**
 * The docker-vs-API inventory cross-check at PREFLIGHT, for EARLY VISIBILITY (R2/C6), pure. A database container the source API
 * does not list (or a named volume nothing accounts for) is found by the host inventory; DATA_SEED stays the gate that BLOCKS on
 * it (an unlisted database must be decided before data moves). PREFLIGHT only says it as early as an inventory exists, so the
 * owner can decide the policy while the run is still free: every finding is a warning here, never a block, and carries no
 * attestation (the attestation belongs to the step that blocks).
 *
 * Judges what arrived: a run with no inventory yet reports nothing (the inventory script needs the op IMPORT creates, so a real
 * run usually has none at PREFLIGHT and a re-run of PREFLIGHT or the dry run of a run that already has one shows it).
 */
import type { GateCheck } from "../../../core/dto";
import { hostLoopTargets, resolveOwnerInput, type RunSnapshot } from "../../../core/run-contract";
import { crossCheckChecks } from "../../data/inventory/cross-check";
import { serverRefOfItem } from "../../data/inventory/host-hosts";
import { containerPrefixesOf } from "../../../../importer/container-prefix";
import type { HostView } from "../../data/inventory/host-view";

/** The plan item kinds the cross-check accounts containers and volumes against. */
const ACCOUNTED_KINDS = new Set(["app", "database", "service", "volume"]);

type PlanItems = ReadonlyArray<{ itemRef: string; kind: string; proposed?: Record<string, unknown> | null }>;

/**
 * `included` = the run's own items: only the source servers they live on are judged. The accounting still reads every item of the plan, so a
 * container that belongs to an item of another server on the same host is not reported as unlisted.
 */
export function preflightCrossCheck(run: RunSnapshot, plan: { items: PlanItems }, view: HostView | undefined, included: PlanItems = plan.items): GateCheck[] {
  if (!view || view.inventories.size === 0) return [];
  // every plan item carries its source server in its ref (`app:<serverRef|_>:<uuid>`); the unknown `_` is not a host
  const refs = plan.items.filter((i) => ACCOUNTED_KINDS.has(i.kind)).map((i) => i.itemRef);
  const own = included.filter((i) => ACCOUNTED_KINDS.has(i.kind)).map((i) => i.itemRef);
  const hosts = [...new Set([...hostLoopTargets(run).map((t) => t.sourceServerRef), ...own.map(serverRefOfItem).filter((h) => h !== "_")])].sort();
  return crossCheckChecks({
    hosts,
    required: false,
    inventories: view.inventories,
    reach: view.reach,
    planRefs: refs,
    containerPrefixes: containerPrefixesOf(plan.items),
    unlistedDbPolicy: resolveOwnerInput(run.inputs, "unlistedDbPolicy") ?? "block",
    orphanVolumePolicy: resolveOwnerInput(run.inputs, "orphanVolumePolicy") ?? "block",
    attestations: [],
    currentPartMiB: null,
    findingsOnly: true,
  })
    .filter((c) => c.status !== "pass")
    .map((c) => {
      const { attestable: _attestable, ...rest } = c;
      return { ...rest, id: `preflight.${c.id}`.slice(0, 80), status: c.status === "fail" || c.status === "unknown" ? ("warn" as const) : c.status };
    });
}
