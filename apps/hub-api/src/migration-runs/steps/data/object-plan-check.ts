/**
 * The DATA_SEED object-storage plan check (R33): a plan that has object storage in it must have its object data accounted for
 * BEFORE any data moves. The import copies a MinIO service's compose project and never its buckets ("object data is not copied by
 * this import"); those move only through an Object migration (`mc mirror`, run by the target agent) attached to the run. A plan with
 * a MinIO service, or with apps whose env names an object store, and no such migration attached would otherwise reach the cutover with
 * the buckets still on the source, and the first dark app that reads an image would find an empty bucket.
 *
 * The owner's `minioPolicy` (Q6) decides what is expected:
 *  - `external`: the store stays where it is and the apps keep its public endpoint, so there is nothing to migrate: no row.
 *  - any other policy (`mirror`, `hold`): the object data must be accounted for before data moves, so an attached migration with at
 *    least one selected bucket is required: FAIL without one (`migration-missing`; the fix is to attach one or to declare the store
 *    external). `hold` that nobody answered (the default) fails with its own code (`policy-unanswered`) that asks the question first.
 *    An attached migration that selects a bucket accounts for the object data under any policy: PASS.
 * A pure function of the snapshot, the attached migrations and the owner inputs: no I/O.
 */
import type { GateCheck } from "../../core/dto";
import { resolveOwnerInput, type RunSnapshot } from "../../core/run-contract";
import type { DataSnapshot, ObjectView } from "./data-contract";

/** The gate check id of the plan check (one per run). */
export const OBJECT_PLAN_ID = "object-plan";

export const OBJECT_PLAN_CODES = {
  /** FAIL: object storage is in the plan and no object migration with a selected bucket is attached. */
  migrationMissing: "data-seed.object-migration-missing",
  /** FAIL: object storage is in the plan and the owner has not said what happens to it (default `hold`). */
  policyUnanswered: "data-seed.object-policy-unanswered",
  /** PASS: an object migration is attached. */
  migrationAttached: "data-seed.object-migration-attached",
} as const;

/** What the plan has in object storage, summarised for the check (names only). */
export interface ObjectPlanFacts {
  stores: number;
  dependants: number;
  unreadable: number;
}

export function objectPlanFacts(snap: Pick<DataSnapshot, "objectStorage">): ObjectPlanFacts {
  const o = snap.objectStorage;
  return { stores: o?.stores.length ?? 0, dependants: o?.dependants.length ?? 0, unreadable: o?.unreadable ?? 0 };
}

/** Did the owner give the minioPolicy answer (a recorded request value), as opposed to the unanswered default? */
function policyAnswered(run: Pick<RunSnapshot, "inputs">): boolean {
  const rec = run.inputs.minioPolicy as { value: unknown; source?: string } | undefined;
  return !!rec && rec.value !== "unknown" && rec.source !== "default";
}

export function objectPlanChecks(run: Pick<RunSnapshot, "inputs">, snap: Pick<DataSnapshot, "objectStorage">, objects: readonly ObjectView[]): GateCheck[] {
  const facts = objectPlanFacts(snap);
  // an env that could not be read counts as a possible dependant (fail closed), exactly like the cutover holds
  if (facts.stores + facts.dependants + facts.unreadable === 0) return [];
  const policy = resolveOwnerInput(run.inputs, "minioPolicy") ?? "hold";
  if (policy === "external") return [];
  const selected = objects.reduce((n, o) => n + o.buckets.filter((b) => b.selected).length, 0);
  const params = { stores: facts.stores, dependants: facts.dependants, unreadable: facts.unreadable, policy, attached: objects.length, selected };
  const id = OBJECT_PLAN_ID;
  // an attached migration that actually selects a bucket accounts for the object data under any policy
  if (objects.length > 0 && selected > 0) return [{ id, status: "pass", code: OBJECT_PLAN_CODES.migrationAttached, params, evidence: "hub-verified" }];
  // nobody answered the question (default hold): ask it before anything else
  if (policy === "hold" && !policyAnswered(run)) return [{ id, status: "fail", code: OBJECT_PLAN_CODES.policyUnanswered, params, ownerInput: "minioPolicy", evidence: "hub-verified" }];
  return [{ id, status: "fail", code: OBJECT_PLAN_CODES.migrationMissing, params, ownerInput: "minioPolicy", evidence: "hub-verified" }];
}
