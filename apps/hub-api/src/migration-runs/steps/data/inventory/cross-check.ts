/**
 * The docker-vs-API cross-check (R2/C6, R6/C19, R8, R14/N4): what the HOST really holds against what the run's plan (derived
 * from the source API) lists. Pure: no I/O, no clock.
 *
 * The coverage ledger of a run is API-derived, so a database container the API does not list is invisible to it and its data
 * would be silently left behind. This module turns the host inventory into GATE CHECKS:
 *  - a database container (recognised by its image) that no plan item of that host accounts for is a BLOCKING `unlisted-db`
 *    finding until the owner decides: `unlistedDbPolicy` skip/carry (an explicit input) or an operator attestation on that exact
 *    finding, `inventory-excluded` (accepted: not migrated) or `inventory-mapped` (it IS this plan item, named in the note);
 *  - a named volume no container mounts (LINKS 0) that no plan `volume:` item accounts for is a blocking `orphan-volume` finding
 *    until `orphanVolumePolicy: skip` or an `inventory-excluded` attestation (a volume the plan carries is not an orphan, even when
 *    its container was removed);
 *  - every blocking finding carries `attestable`: the attestation check ids that settle IT (the panel offers one row per finding);
 *  - an unmeasurable size is reported as unknown (a warn with the count), never as zero;
 *  - the hub reach probe must have passed the CURRENT part size through the host's path to the hub (a proxy that caps request
 *    bodies caps a part), else the check fails and recommends the largest part size that did pass.
 */
import type { GateCheck } from "../../../core/dto";
import type { OrphanVolumePolicy, UnlistedDbPolicy } from "../../../core/run-contract";
import { containerNameMatches } from "../source-control/source-scripts";
import { checkKey } from "../data-logic";
import { coolifyRefOf } from "../../../../importer/sources/coolify-control";
import { dbEngineOfImage, type HostInventory, type InvContainer, type ReachReport } from "./host-protocol";

export const INVENTORY_CODES = {
  notTaken: "inventory.not-taken",
  truncated: "inventory.truncated",
  rejectedLines: "inventory.rejected-lines",
  unlistedDb: "inventory.unlisted-db",
  unlistedDbSkipped: "inventory.unlisted-db-skipped",
  unlistedDbCarry: "inventory.unlisted-db-carry",
  unlistedDbExcluded: "inventory.unlisted-db-excluded",
  unlistedDbMapped: "inventory.unlisted-db-mapped",
  orphanVolume: "inventory.orphan-volume",
  orphanVolumeSkipped: "inventory.orphan-volume-skipped",
  orphanVolumeExcluded: "inventory.orphan-volume-excluded",
  sizeUnknown: "inventory.size-unknown",
  reachOk: "inventory.reach-ok",
  reachFailed: "inventory.reach-failed",
  reachUnknown: "inventory.reach-unknown",
  partSizeExceedsCap: "inventory.part-size-exceeds-cap",
} as const;

/** The attestation check ids an operator may use on a finding (listed in the wait's `attest`). */
export const INVENTORY_ATTEST = { excluded: "inventory-excluded", mapped: "inventory-mapped" } as const;

/** Infrastructure containers that are never "data to migrate": the Coolify control plane and Tugra's own. */
const INFRA_NAMES = new Set(["coolify", "coolify-db", "coolify-redis", "coolify-realtime", "coolify-proxy", "coolify-sentinel", "coolify-helper", "coolify-testing-host"]);
export const isInfraContainer = (name: string): boolean => INFRA_NAMES.has(name) || name.startsWith("tugra-");

/** An anonymous docker volume (a 64-hex name): leftovers of removed containers, reported as a count, not as a blocker each. */
export const isAnonymousVolume = (name: string): boolean => /^[0-9a-f]{64}$/.test(name);

/** The part sizes (MiB) the hub accepts, descending: the recommendation is the largest one the path to the hub passed. */
const PART_SIZES_MIB = [512, 256, 128, 64, 32] as const;

/** The largest valid `MIGRATION_VX_PART_MIB` a path that accepted `acceptedMiB` can carry, or 0 when even 32 fails. */
export function recommendPartMib(acceptedMiB: number): number {
  return PART_SIZES_MIB.find((p) => p <= acceptedMiB) ?? 0;
}

export interface CrossCheckInput {
  /** The source hosts the run covers (labels). Empty = only the inventories that arrived are judged. */
  hosts: readonly string[];
  /** True for the host-loop runner: a host without an inventory (or reach report) is `unknown`, which fails. */
  required: boolean;
  inventories: ReadonlyMap<string, HostInventory>;
  reach: ReadonlyMap<string, ReachReport>;
  /** Every itemRef of the run's plan (apps, services, databases, volumes). */
  planRefs: readonly string[];
  unlistedDbPolicy: UnlistedDbPolicy;
  orphanVolumePolicy: OrphanVolumePolicy;
  attestations: ReadonlyArray<{ checkId: string; subject?: string; note?: string }>;
  /** The hub's CURRENT part size (MiB), or null when it cannot be read. */
  currentPartMiB: number | null;
  /** Judge only what decides whether data is left behind (not-taken / truncated / unlisted databases / orphan volumes): no reach, size or rejected-line checks. */
  findingsOnly?: boolean;
}

export interface Finding {
  kind: "unlisted-db" | "orphan-volume";
  host: string;
  /** The key an attestation's `subject` must equal: `<host>/<container>` or `<host>/volume:<name>`. */
  key: string;
  name: string;
  image?: string;
  engine?: string;
  state?: string;
  sizeKiB?: number | null;
}

const serverRefOf = (itemRef: string): string => itemRef.split(":")[1] ?? "_";

/** Does a plan item of kind app/service/database account for this container? */
function accountedFor(c: Pick<InvContainer, "name">, host: string, planRefs: readonly string[]): boolean {
  for (const ref of planRefs) {
    const sr = serverRefOf(ref);
    if (sr !== host && sr !== "_" && host !== "_") continue;
    const parsed = coolifyRefOf(ref);
    if (parsed && containerNameMatches(c.name, parsed.uuid, parsed.kind)) return true;
  }
  return false;
}

/**
 * Does a plan `volume:<host>:<sourceRef>:<volName>` item account for this docker volume? Coolify names an application's, a service's
 * and a database's named volume `<sourceRef>_<volName>` (compose) or `<sourceRef>-<volName>`; a volume the plan carries is NOT an
 * orphan even when its container was removed (a stopped Coolify resource keeps its volumes and loses its containers).
 */
function volumeAccountedFor(volume: string, host: string, planRefs: readonly string[]): boolean {
  for (const ref of planRefs) {
    const parts = ref.split(":");
    if (parts[0] !== "volume" || parts.length !== 4) continue;
    const [, sr, source, vol] = parts;
    if (sr !== host && sr !== "_" && host !== "_") continue;
    if (volume === `${source}_${vol}` || volume === `${source}-${vol}`) return true;
  }
  return false;
}

/** The unlisted database containers and orphan volumes of one host inventory. Pure. */
export function findingsOf(inv: HostInventory, planRefs: readonly string[]): Finding[] {
  const out: Finding[] = [];
  for (const c of inv.containers) {
    if (isInfraContainer(c.name)) continue;
    const engine = dbEngineOfImage(c.image);
    if (!engine || accountedFor(c, inv.ref, planRefs)) continue;
    out.push({ kind: "unlisted-db", host: inv.ref, key: `${inv.ref}/${c.name}`, name: c.name, image: c.image, engine, state: c.state });
  }
  for (const v of inv.volumes) {
    if (v.links > 0 || isAnonymousVolume(v.name) || volumeAccountedFor(v.name, inv.ref, planRefs)) continue;
    out.push({ kind: "orphan-volume", host: inv.ref, key: `${inv.ref}/volume:${v.name}`, name: v.name, sizeKiB: v.sizeKiB });
  }
  return out;
}

const HOST_EVIDENCE = "host-loop-reported" as const;

/** The gate checks of the cross-check (see the module comment). */
export function crossCheckChecks(i: CrossCheckInput): GateCheck[] {
  const checks: GateCheck[] = [];
  const hosts = [...new Set([...i.hosts, ...i.inventories.keys()])].sort();
  const mappedTo = (key: string): string | null => {
    const a = i.attestations.find((x) => x.checkId === INVENTORY_ATTEST.mapped && x.subject === key);
    return a?.note && i.planRefs.includes(a.note.trim()) ? a.note.trim() : null;
  };
  const excluded = (key: string): boolean => i.attestations.some((x) => x.checkId === INVENTORY_ATTEST.excluded && x.subject === key);

  for (const host of hosts) {
    const inv = i.inventories.get(host);
    if (!inv) {
      if (i.required) checks.push({ id: checkKey("inventory-taken", host), status: "unknown", code: INVENTORY_CODES.notTaken, subject: host, params: { host }, evidence: HOST_EVIDENCE });
      continue;
    }
    if (!inv.complete) {
      // a partial report cannot prove the ABSENCE of an unlisted database: fail rather than judge a truncated list
      checks.push({ id: checkKey("inventory-complete", host), status: "fail", code: INVENTORY_CODES.truncated, subject: host, params: { host }, evidence: HOST_EVIDENCE });
      continue;
    }
    if (inv.rejected > 0 && !i.findingsOnly) checks.push({ id: checkKey("inventory-rejected", host), status: "warn", code: INVENTORY_CODES.rejectedLines, subject: host, params: { host, count: inv.rejected }, evidence: HOST_EVIDENCE });

    for (const f of findingsOf(inv, i.planRefs)) {
      if (f.kind === "unlisted-db") {
        const base = { subject: f.key, evidence: HOST_EVIDENCE, ownerInput: "unlistedDbPolicy" as const };
        const params = { host, container: f.name, image: f.image ?? "", engine: f.engine ?? "", state: f.state ?? "" };
        const mapped = mappedTo(f.key);
        if (mapped) checks.push({ ...base, id: checkKey("inventory-unlisted-db", f.key), status: "warn", code: INVENTORY_CODES.unlistedDbMapped, params: { ...params, item: mapped } });
        else if (excluded(f.key)) checks.push({ ...base, id: checkKey("inventory-unlisted-db", f.key), status: "warn", code: INVENTORY_CODES.unlistedDbExcluded, params });
        else if (i.unlistedDbPolicy === "skip") checks.push({ ...base, id: checkKey("inventory-unlisted-db", f.key), status: "warn", code: INVENTORY_CODES.unlistedDbSkipped, params });
        else if (i.unlistedDbPolicy === "carry") checks.push({ ...base, id: checkKey("inventory-unlisted-db", f.key), status: "warn", code: INVENTORY_CODES.unlistedDbCarry, params });
        else checks.push({ ...base, id: checkKey("inventory-unlisted-db", f.key), status: "fail", code: INVENTORY_CODES.unlistedDb, params, attestable: [INVENTORY_ATTEST.excluded, INVENTORY_ATTEST.mapped] });
      } else {
        const base = { subject: f.key, evidence: HOST_EVIDENCE, ownerInput: "orphanVolumePolicy" as const };
        const params = { host, volume: f.name, sizeKiB: f.sizeKiB ?? null };
        if (excluded(f.key)) checks.push({ ...base, id: checkKey("inventory-orphan-volume", f.key), status: "warn", code: INVENTORY_CODES.orphanVolumeExcluded, params });
        else if (i.orphanVolumePolicy === "skip") checks.push({ ...base, id: checkKey("inventory-orphan-volume", f.key), status: "warn", code: INVENTORY_CODES.orphanVolumeSkipped, params });
        else checks.push({ ...base, id: checkKey("inventory-orphan-volume", f.key), status: "fail", code: INVENTORY_CODES.orphanVolume, params, attestable: [INVENTORY_ATTEST.excluded] });
      }
    }

    // C19: sizes that could not be measured are unknown, said once per host with the count (they are not zero)
    if (i.findingsOnly) continue;
    const unknown = [...inv.binds.filter((b) => b.sizeKiB === null).map((b) => b.source), ...inv.volumes.filter((v) => v.sizeKiB === null && v.links > 0).map((v) => v.name)];
    if (unknown.length) checks.push({ id: checkKey("inventory-size-unknown", host), status: "warn", code: INVENTORY_CODES.sizeUnknown, subject: host, params: { host, count: unknown.length, first: unknown.slice(0, 5).join(", ").slice(0, 300) }, evidence: HOST_EVIDENCE });

    checks.push(...reachChecks(host, i.reach.get(host) ?? null, i.currentPartMiB, i.required));
  }
  return checks;
}

function reachChecks(host: string, r: ReachReport | null, partMiB: number | null, required: boolean): GateCheck[] {
  if (!r) return required ? [{ id: checkKey("inventory-reach", host), status: "unknown", code: INVENTORY_CODES.reachUnknown, subject: host, params: { host }, evidence: HOST_EVIDENCE }] : [];
  if (r.pingCode !== 200) return [{ id: checkKey("inventory-reach", host), status: "fail", code: INVENTORY_CODES.reachFailed, subject: host, params: { host, httpCode: r.pingCode }, evidence: HOST_EVIDENCE }];
  const need = partMiB ?? r.hubPartMiB;
  if (need === null || r.maxPassedMiB === null) return [{ id: checkKey("inventory-reach", host), status: "unknown", code: INVENTORY_CODES.reachUnknown, subject: host, params: { host }, evidence: HOST_EVIDENCE }];
  if (r.maxPassedMiB < need) {
    return [
      {
        id: checkKey("inventory-reach", host),
        status: "fail",
        code: INVENTORY_CODES.partSizeExceedsCap,
        subject: host,
        params: { host, partMiB: need, acceptedMiB: r.maxPassedMiB, recommendMiB: recommendPartMib(r.maxPassedMiB) },
        evidence: HOST_EVIDENCE,
      },
    ];
  }
  return [{ id: checkKey("inventory-reach", host), status: "pass", code: INVENTORY_CODES.reachOk, subject: host, params: { host, partMiB: need, acceptedMiB: r.maxPassedMiB }, evidence: HOST_EVIDENCE }];
}

/** The attestation ids a wait should list when the checks contain a blocking finding the operator may settle. */
export function attestableFindings(checks: readonly GateCheck[]): string[] {
  const failing = (code: string) => checks.some((c) => c.status === "fail" && c.code === code);
  if (failing(INVENTORY_CODES.unlistedDb)) return [INVENTORY_ATTEST.excluded, INVENTORY_ATTEST.mapped];
  return failing(INVENTORY_CODES.orphanVolume) ? [INVENTORY_ATTEST.excluded] : [];
}
