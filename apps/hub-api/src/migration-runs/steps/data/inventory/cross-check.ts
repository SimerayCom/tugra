/**
 * The docker-vs-API cross-check (R2/C6, R6/C19, R8, R14/N4): what the HOST really holds against what the run's plan (derived
 * from the source API) lists. Pure: no I/O, no clock.
 *
 * The coverage ledger of a run is API-derived, so a database container the API does not list is invisible to it and its data
 * would be silently left behind. This module turns the host inventory into GATE CHECKS:
 *  - a database container (recognised by its image) that no plan item of that host accounts for is a BLOCKING `unlisted-db`
 *    finding until the owner decides: `unlistedDbPolicy` skip/carry (an explicit input) or an operator attestation on that exact
 *    finding, `inventory-excluded` (accepted: not migrated) or `inventory-mapped` (it IS this plan item, named in the note);
 *  - `unlistedDbPolicy: carry` is a REAL carry (R2): every unlisted database the inventory proves carryable is bound to a NEW
 *    database plan item (see {@link carryDecisions}) which the DATA_SEED step creates; the normal database lane then moves it. A
 *    container whose data cannot be carried in full (an engine the migrator cannot dump, a password it cannot discover, an ACL
 *    user, no known version...) is REFUSED with a `inventory.carry-refused-<reason>` code: never a silent warning;
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
import { versionFromImage } from "../../../../importer/sources/coolify-map";

export const INVENTORY_CODES = {
  notTaken: "inventory.not-taken",
  truncated: "inventory.truncated",
  rejectedLines: "inventory.rejected-lines",
  unlistedDb: "inventory.unlisted-db",
  unlistedDbSkipped: "inventory.unlisted-db-skipped",
  unlistedDbCarry: "inventory.unlisted-db-carry",
  unlistedDbCarryPending: "inventory.unlisted-db-carry-pending",
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

/** One gate code per reason a carry is refused (so each has its own sentence in the locale), keyed by {@link CarryRefusal}. */
export const CARRY_REFUSED_CODES = {
  "engine-unsupported": "inventory.carry-refused-engine-unsupported",
  "name-unsupported": "inventory.carry-refused-name-unsupported",
  "not-running": "inventory.carry-refused-not-running",
  "meta-missing": "inventory.carry-refused-meta-missing",
  "credentials-not-discoverable": "inventory.carry-refused-credentials-not-discoverable",
  "secret-file-unsupported": "inventory.carry-refused-secret-file-unsupported",
  "acl-user-unsupported": "inventory.carry-refused-acl-user-unsupported",
  "db-not-discoverable": "inventory.carry-refused-db-not-discoverable",
  "version-unknown": "inventory.carry-refused-version-unknown",
} as const;
const CARRY_REFUSED_SET: ReadonlySet<string> = new Set(Object.values(CARRY_REFUSED_CODES));

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

// ───────────────────────────── carry (R2) ─────────────────────────────

/** The engines the migrator can dump and the hub can restore (`MIGRATOR_ENGINES`): the only ones an unlisted container can be carried as. */
export type CarryEngine = "POSTGRES" | "MYSQL" | "MARIADB" | "REDIS" | "KEYDB" | "DRAGONFLY";

/** Why a container cannot be carried in full. Fixed, value-free codes (they travel in gate params and the locale has a sentence each). */
export const CARRY_REFUSALS = ["engine-unsupported", "name-unsupported", "not-running", "meta-missing", "credentials-not-discoverable", "secret-file-unsupported", "acl-user-unsupported", "db-not-discoverable", "version-unknown"] as const;
export type CarryRefusal = (typeof CARRY_REFUSALS)[number];

/** What the DATA_SEED step needs to bind a container to a new database plan item. No secret: the password is read by the migrator on the source host. */
export interface CarrySpec {
  host: string;
  container: string;
  engine: CarryEngine;
  version: string;
  image: string;
  user: string | null;
  database: string | null;
  /** The display name of the new Tugra database. */
  name: string;
}

/** The Tugra engine a database IMAGE is carried as, or null when it has none the migrator can move (MongoDB, ClickHouse, Valkey, Redis Stack...). */
export function carryEngineOfImage(image: string): CarryEngine | null {
  const family = dbEngineOfImage(image);
  const base = (image.split("@")[0].split("/").pop() ?? "").split(":")[0].toLowerCase();
  if (family === "POSTGRES") return "POSTGRES";
  if (family === "MARIADB") return "MARIADB";
  if (family === "MYSQL") return "MYSQL";
  if (family === "REDIS") return /keydb/.test(base) ? "KEYDB" : /dragonfly/.test(base) ? "DRAGONFLY" : base === "redis" ? "REDIS" : null;
  return null;
}

/**
 * Can this unlisted database container be carried IN FULL, and as what? Pure. Every refusal is a fixed reason:
 *  - the engine must be one the migrator dumps; the container name must be a plain reference (letters, digits, `_`, `-`; no dot);
 *    the container must be running (the migrator opens a running source);
 *  - the inventory must carry the database facts (an older script's report does not: run the inventory again);
 *  - the migrator must be able to discover the password (`env`); a `*_FILE` secret, no password or an ACL user is refused;
 *  - a MySQL / MariaDB container must name its database (the dump covers exactly one) and every engine needs a known version
 *    (the image tag, else the version variable of the image): a copy on another major could not open the data.
 */
export function carryAssessment(host: string, c: InvContainer): { ok: true; spec: CarrySpec } | { ok: false; reason: CarryRefusal } {
  const engine = carryEngineOfImage(c.image);
  if (!engine) return { ok: false, reason: "engine-unsupported" };
  // the plan item is `database:<host>:<container>`, matched byte-exactly by the migrator and by the plan's own reference rules: a name outside them cannot be one
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(c.name)) return { ok: false, reason: "name-unsupported" };
  if (c.state !== "running") return { ok: false, reason: "not-running" };
  if (!c.db) return { ok: false, reason: "meta-missing" };
  if (c.db.cred === "file") return { ok: false, reason: "secret-file-unsupported" };
  if (c.db.cred === "acl") return { ok: false, reason: "acl-user-unsupported" };
  if (c.db.cred !== "env") return { ok: false, reason: "credentials-not-discoverable" };
  if ((engine === "MYSQL" || engine === "MARIADB") && !c.db.database) return { ok: false, reason: "db-not-discoverable" };
  const version = versionFromImage(c.image) ?? c.db.version;
  if (!version) return { ok: false, reason: "version-unknown" };
  return { ok: true, spec: { host, container: c.name, engine, version, image: c.image, user: c.db.user, database: c.db.database, name: `unlisted-${engine.toLowerCase()}-${c.name.slice(0, 8)}` } };
}

/** The plan itemRef a carried container becomes. `data:`-free and in the same namespace the migrator resolves by container name. */
export const carriedItemRef = (host: string, container: string): string => `database:${host}:${container}`;

type Settled = Pick<CrossCheckInput, "attestations" | "planRefs">;
const settledBy = (i: Settled, key: string): boolean => i.attestations.some((x) => (x.checkId === INVENTORY_ATTEST.excluded && x.subject === key) || (x.checkId === INVENTORY_ATTEST.mapped && x.subject === key && !!x.note && i.planRefs.includes(x.note.trim())));

/**
 * The containers the run must still carry: under `unlistedDbPolicy: carry`, every unlisted database of a COMPLETE inventory that no
 * operator attestation settled and that {@link carryAssessment} accepts. Empty under any other policy. A container the plan
 * accounts for (including one an earlier carry already created) is not an unlisted finding, so a second call returns nothing for it.
 */
export function carryDecisions(i: Pick<CrossCheckInput, "inventories" | "planRefs" | "unlistedDbPolicy" | "attestations">): CarrySpec[] {
  if (i.unlistedDbPolicy !== "carry") return [];
  const out: CarrySpec[] = [];
  for (const [host, inv] of [...i.inventories].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (!inv.complete) continue;
    for (const f of findingsOf(inv, i.planRefs)) {
      if (f.kind !== "unlisted-db" || settledBy(i, f.key)) continue;
      const c = inv.containers.find((x) => x.name === f.name);
      const a = c ? carryAssessment(host, c) : null;
      if (a?.ok) out.push(a.spec);
    }
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
        else if (i.unlistedDbPolicy === "carry") {
          const c = inv.containers.find((x) => x.name === f.name);
          const a = c ? carryAssessment(host, c) : ({ ok: false, reason: "meta-missing" } as const);
          // `findingsOnly` is the judgement after a SKIPPED DATA_SEED (the step that carries): a carryable container still unlisted here was
          // never carried, and nothing later will, so it blocks until an operator settles it instead of passing as if it were handled
          if (a.ok && i.findingsOnly) checks.push({ ...base, id: checkKey("inventory-unlisted-db", f.key), status: "fail", code: INVENTORY_CODES.unlistedDbCarryPending, params: { ...params, name: a.spec.name, version: a.spec.version }, attestable: [INVENTORY_ATTEST.excluded, INVENTORY_ATTEST.mapped] });
          else if (a.ok) checks.push({ ...base, id: checkKey("inventory-unlisted-db", f.key), status: "warn", code: INVENTORY_CODES.unlistedDbCarry, params: { ...params, name: a.spec.name, version: a.spec.version } });
          else checks.push({ ...base, id: checkKey("inventory-unlisted-db", f.key), status: "fail", code: CARRY_REFUSED_CODES[a.reason], params: { ...params, reason: a.reason }, attestable: [INVENTORY_ATTEST.excluded, INVENTORY_ATTEST.mapped] });
        } else checks.push({ ...base, id: checkKey("inventory-unlisted-db", f.key), status: "fail", code: INVENTORY_CODES.unlistedDb, params, attestable: [INVENTORY_ATTEST.excluded, INVENTORY_ATTEST.mapped] });
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
  if (failing(INVENTORY_CODES.unlistedDb) || failing(INVENTORY_CODES.unlistedDbCarryPending) || checks.some((c) => c.status === "fail" && CARRY_REFUSED_SET.has(c.code ?? ""))) return [INVENTORY_ATTEST.excluded, INVENTORY_ATTEST.mapped];
  return failing(INVENTORY_CODES.orphanVolume) ? [INVENTORY_ATTEST.excluded] : [];
}
