/**
 * The VERIFY suite (design 4.1): a PURE function from what the world looks like to a list of checks, each with an honest
 * evidence kind, plus the hash the point-of-no-return approval is bound to. No I/O here; the handler gathers the inputs.
 *
 * Trust model (never upgraded silently):
 *  - `hub-verified`: the hub measured it itself (transfer rows, hub-run statements on the target agent, app/DB status,
 *    cutover host state, object-migration diffs the target agent ran, a fresh source re-discovery),
 *  - `migrator-reported`: the number came from the untrusted source host (the source side of DB parity, volume entry counts),
 *  - `operator-attested`: a human said so (an explicitly excluded volume).
 *
 * Ackable vs not: a check a human may accept through the approval (`ackable`) is something a person can legitimately decide
 * ("this app does not need to run", "the source could not be re-read, I checked"). Losing data is never ackable: a volume or
 * a table that did not arrive blocks until the data steps are retried.
 */
import type { GateCheck } from "../../../core/dto";
import { DATA_CODES, type DataSnapshot, type DbStats, type FlipPlanLite, type ObjectView, type RuntimeSnapshot } from "../data-contract";
import { canonicalJson, checkKey, sha256Hex } from "../data-logic";
import { objectPlanChecks } from "../object-plan-check";
import type { RunSnapshot } from "../../../core/run-contract";
import { PARITY_CODES, compareDbStats } from "./db-stats";

export interface SuiteInputs {
  snap: DataSnapshot;
  runtime: RuntimeSnapshot;
  objects: readonly ObjectView[];
  /** itemRef -> what the migrator reported for the source (absent = never reported). */
  sourceStats: ReadonlyMap<string, DbStats>;
  /** itemRef -> what the hub measured on the target (absent = not measured yet). */
  targetStats: ReadonlyMap<string, DbStats>;
  drift: "same" | "changed" | "unknown";
  flip: FlipPlanLite;
  /** The run's owner inputs (the object storage policy); absent = the unanswered default. */
  runInputs?: RunSnapshot["inputs"];
}

/** A gate check plus the stable (checkId, subject) pair it is stored under in `MigrationRunCheck`. */
export interface SuiteCheck extends GateCheck {
  checkId: string;
  subject: string;
}

const SUITE_HOST_PASS = new Set(["READY", "VERIFIED", "SWITCHED", "SWITCHING"]);

function mk(checkId: string, subject: string, c: Omit<GateCheck, "id" | "subject">): SuiteCheck {
  return { ...c, id: checkKey(checkId, subject), checkId, subject };
}

/** The wire form of a check (the engine stores gate checks as JSON: no helper fields, no empty subject). */
export function toGateCheck(c: SuiteCheck, acked = false): GateCheck {
  const { checkId: _checkId, subject, ...rest } = c;
  return { ...rest, ...(subject ? { subject } : {}), ...(acked ? { acked: true } : {}) };
}

/** Build every check of the suite, in a stable order. */
export function buildVerifySuite(i: SuiteInputs): SuiteCheck[] {
  const out: SuiteCheck[] = [];
  const dbItems = new Map(i.snap.databases.map((d) => [d.itemRef, d]));

  // 1. volume parity + postgres physical copy (hub-verified: the transfer rows and the apply script)
  for (const v of i.snap.volumes) {
    if (v.excluded) {
      out.push(mk("volume-parity", v.itemRef, { status: "warn", code: DATA_CODES.verifyCoverage, params: { kind: "volume", outcome: "excluded" }, evidence: "operator-attested" }));
      continue;
    }
    if (v.destType === "db-dump") {
      // a streamed dump has no entry count to compare: every part was hash-verified at the relay and on the target, the restore's own exit
      // status is the apply's, and the rows are compared by the logical parity check below. Hub-verified, never migrator-reported.
      out.push(mk("volume-parity", v.itemRef, { status: v.state === "DONE" ? "pass" : "fail", code: DATA_CODES.verifyVolumeParity, params: { state: v.state, entries: null, inspectedEntries: null, lane: "stream" }, evidence: "hub-verified" }));
      continue;
    }
    const copied = v.state === "DONE" && v.entries !== null;
    const entriesAgree = !v.inventory?.found || v.inventory.entries === v.entries;
    out.push(
      mk("volume-parity", v.itemRef, {
        status: copied && entriesAgree ? "pass" : "fail",
        code: DATA_CODES.verifyVolumeParity,
        params: { state: v.state, entries: v.entries, inspectedEntries: v.inventory?.found ? v.inventory.entries : null },
        evidence: v.inventory?.found ? "migrator-reported" : "hub-verified",
      }),
    );
    if (v.destType === "db-data") {
      const major = v.gates?.find((g) => g.id === "major");
      out.push(
        mk("pg-physical", v.itemRef, {
          status: v.state === "DONE" && major?.status === "pass" ? "pass" : v.state === "DONE" && !major ? "unknown" : "fail",
          code: DATA_CODES.verifyPgVersion,
          params: { state: v.state, major: major?.status ?? "absent" },
          evidence: "hub-verified",
        }),
      );
    }
  }

  // 2. DB logical parity: the source side is migrator-reported, the target side hub-measured
  for (const d of i.snap.databases) {
    if (d.plane === "unsupported") {
      out.push(mk("coverage-db", d.itemRef, { status: "fail", code: DATA_CODES.verifyCoverage, params: { kind: "database", outcome: "not-migrated", engine: d.engine, reason: d.unsupportedReason }, ackable: true, evidence: "hub-verified" }));
      continue;
    }
    const src = i.sourceStats.get(d.itemRef);
    // a physically copied database is normally stopped on the source: its parity is the volume's, so an absent source
    // report is not evidence missing for it (but a measured one is still compared)
    if (d.plane === "volume" && (!src || src.state !== "measured")) continue;
    const r = compareDbStats(src, i.targetStats.get(d.itemRef));
    out.push(
      mk("db-logical-parity", d.itemRef, {
        status: r.status,
        code: r.code,
        params: r.params,
        // a measurement that FAILED can be accepted by a human who checked another way; one that has not run YET cannot
        // be (it will), and a LOSS never can
        ackable: r.status === "unknown" && !(r.code === PARITY_CODES.targetUnavailable && r.params.reason === "not-measured"),
        evidence: "migrator-reported",
      }),
    );
  }

  // 3. objects: every selected bucket VERIFIED by the target agent's diff
  for (const o of i.objects) {
    for (const b of o.buckets.filter((x) => x.selected)) {
      const subject = `${o.id}/${b.srcBucket}`;
      out.push(mk("bucket", subject, { status: b.status === "VERIFIED" ? "pass" : "fail", code: DATA_CODES.verifyObjects, params: { status: b.status, missing: b.diffMissing ?? 0, differ: b.diffDiffer ?? 0 }, evidence: "hub-verified" }));
    }
  }

  // 4. runtime (all hub-verified)
  for (const a of i.runtime.apps) {
    out.push(mk("app-running", a.itemRef, { status: a.status === "RUNNING" ? "pass" : "fail", code: DATA_CODES.verifyRuntimeApp, params: { status: a.status, name: a.name }, ackable: true, evidence: "hub-verified" }));
    if (a.envUnresolved > 0 || a.envDropped > 0) {
      out.push(mk("env-carried", a.itemRef, { status: "warn", code: DATA_CODES.verifyEnv, params: { unresolved: a.envUnresolved, dropped: a.envDropped, name: a.name }, evidence: "hub-verified" }));
    }
  }
  for (const d of i.runtime.databases) {
    out.push(mk("database-running", d.itemRef, { status: d.status === "RUNNING" ? "pass" : "fail", code: DATA_CODES.verifyRuntimeDb, params: { status: d.status, name: d.name }, evidence: "hub-verified" }));
  }
  for (const h of i.runtime.hosts) {
    const state = h.state;
    const status = SUITE_HOST_PASS.has(state) ? "pass" : state === "EXCLUDED" ? "warn" : state === "BLOCKED" || state === "CONFLICT" ? "fail" : "fail";
    out.push(mk("host-ready", h.hostname, { status, code: DATA_CODES.verifyHost, params: { state, reason: h.blockReason, stateful: h.stateful }, ackable: state === "BLOCKED" || state === "CONFLICT", evidence: "hub-verified" }));
  }

  // 5. coverage ledger: every provisioned thing is DONE, or the human accepted it is not
  if (i.runtime.incomplete.length === 0) out.push(mk("coverage", "", { status: "pass", code: DATA_CODES.verifyCoverage, params: { incomplete: 0 }, evidence: "hub-verified" }));
  for (const t of i.runtime.incomplete) {
    out.push(mk("coverage", t.itemRef, { status: "fail", code: DATA_CODES.verifyCoverage, params: { kind: t.kind, status: t.status, known: dbItems.has(t.itemRef) }, ackable: true, evidence: "hub-verified" }));
  }

  // 5b. compose-service volumes the streamed lane did NOT move (R53): a search engine's index, a converter's cache, a 58 GB analytics
  // store. Each one is a row of its own, so the coverage ledger never reads "everything moved" while a service volume stayed behind.
  // A volume the stream moved is already judged by its `volume-parity` row above.
  out.push(...serviceVolumeCoverage(i.snap));
  out.push(...objectPlanCoverage(i));

  // 6. source drift: re-discover and compare
  out.push(
    mk("source-drift", "", {
      status: i.drift === "same" ? "pass" : i.drift === "changed" ? "fail" : "unknown",
      code: DATA_CODES.verifyDrift,
      params: { result: i.drift },
      ackable: i.drift !== "same",
      evidence: "hub-verified",
    }),
  );

  // 7. the plan the approval will be bound to must exist
  out.push(
    mk("flip-plan", "", {
      status: i.flip.planHash ? "pass" : "fail",
      code: DATA_CODES.verifyFlipPlan,
      params: i.flip.planHash ? { hosts: i.flip.hosts.length, stateful: i.flip.statefulHosts.length } : { reason: i.flip.unavailable ?? "unavailable" },
      evidence: "hub-verified",
    }),
  );
  return out;
}

/**
 * One coverage row per service volume that is not on the streamed lane (an object store's volume says it is moved by Object migration). `copy` that cannot be streamed and `skip` (an explicit choice
 * not to carry the data) fail and need an acknowledgement; `empty` starts empty by design and is a warning, so it is listed but does
 * not hold the approval. An excluded volume has its own `volume-parity` row.
 */
export function serviceVolumeCoverage(snap: DataSnapshot): SuiteCheck[] {
  const out: SuiteCheck[] = [];
  for (const v of snap.serviceVolumes ?? []) {
    if (v.streamed) continue;
    if (v.objectStore) {
      // an object store's volume is never streamed: its buckets move through Object migration (judged by the object checks and the DATA_SEED plan check)
      out.push(mk("coverage-service-volume", `${v.serviceItemRef}/${v.key}`, { status: "warn", code: DATA_CODES.verifyServiceVolumeObjectStore, params: { service: v.serviceName ?? v.serviceItemRef, key: v.key, outcome: "moved-by-object-migration", reason: "object-store" }, ackable: false, evidence: "hub-verified" }));
      continue;
    }
    const reason = v.policy === "copy" ? "not-streamable" : v.policy === "skip" ? "policy-skip" : "starts-empty";
    const code = v.policy === "copy" ? DATA_CODES.verifyServiceVolume : v.policy === "skip" ? DATA_CODES.verifyServiceVolumeSkipped : DATA_CODES.verifyServiceVolumeEmpty;
    out.push(
      mk("coverage-service-volume", `${v.serviceItemRef}/${v.key}`, {
        status: v.policy === "empty" ? "warn" : "fail",
        code,
        params: { service: v.serviceName ?? v.serviceItemRef, key: v.key, outcome: v.policy === "empty" ? "starts-empty" : "not-migrated", reason },
        ackable: v.policy !== "empty",
        evidence: "hub-verified",
      }),
    );
  }
  return out;
}

/**
 * The R33 object storage plan check again, at the last gate before the cutover: DATA_SEED is skippable, and skipping it must not let a plan with
 * object storage and no attached object migration (a selected bucket) reach the cutover looking clean. Only the failure is a row: when a
 * migration is attached its buckets have their own `bucket` rows, and policy `external` has nothing to migrate. A person who moved the
 * buckets by other means acknowledges it in the approval.
 */
export function objectPlanCoverage(i: Pick<SuiteInputs, "snap" | "objects" | "runInputs">): SuiteCheck[] {
  return objectPlanChecks({ inputs: i.runInputs ?? {} }, i.snap, i.objects)
    .filter((c) => c.status === "fail")
    .map((c) => mk("coverage-object-plan", "", { status: "fail", code: c.code, ...(c.params ? { params: c.params } : {}), ackable: true, evidence: "hub-verified" }));
}

/** `blocked` = a fail/unknown that no human may accept; `pending` = needs an acknowledgement in the approval. */
export function classifySuite(checks: readonly SuiteCheck[], acks: ReadonlySet<string> = new Set()): { blocked: SuiteCheck[]; pending: SuiteCheck[]; acked: SuiteCheck[] } {
  const blocked: SuiteCheck[] = [];
  const pending: SuiteCheck[] = [];
  const acked: SuiteCheck[] = [];
  for (const c of checks) {
    if (c.status === "pass" || c.status === "warn") continue;
    if (c.ackable) (acks.has(c.id) ? acked : pending).push(c);
    else blocked.push(c);
  }
  return { blocked, pending, acked };
}

/**
 * The hash of what the human reviewed. Only STABLE facts: per check its id, status and code (never params, which carry
 * counters that move while a dark app runs), so an approval is not voided by noise. Acks are NOT part of it.
 */
export function reportHash(checks: readonly SuiteCheck[]): string {
  return sha256Hex(canonicalJson(checks.map((c) => [c.id, c.status, c.code])));
}

/** The point-of-no-return binding: `H(verifyReportHash || flipPlanHash || statefulHosts)`. */
export function ponrBindingHash(report: string, flip: Pick<FlipPlanLite, "planHash" | "statefulHosts">): string {
  return sha256Hex(`verify|${report}|${flip.planHash ?? "none"}|${[...flip.statefulHosts].sort().join(",")}`);
}
