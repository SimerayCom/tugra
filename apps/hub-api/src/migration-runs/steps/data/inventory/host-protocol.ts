/**
 * The line protocol between the source-host scripts (the `coolify-host-loop` script, the host inventory, the remote freeze
 * script) and the hub. Every line a script prints is self-labelled with the source server it concerns:
 *
 *   TUGRA_AT <tab> <serverRef> <tab> TUGRA_<KIND> <tab> field <tab> field ...
 *
 * and the same text is both shown on the operator's terminal and POSTed (`text/plain`) to `POST /import/migration/host-report`,
 * authenticated only by the migration token. The source host is UNTRUSTED: the parser here validates every field against a
 * narrow charset and bound, drops what does not match (counting it in `rejected`) and never trusts a count or a label. The
 * hub additionally validates the label against the hosts of the run before anything is stored (see the ingest service).
 *
 * Nothing in this protocol can carry a secret: names, ids, sizes and fixed codes only.
 */
import type { RecordedContainer } from "../data-contract";

export const AT_MARK = "TUGRA_AT";
export const HOST_MARK = "TUGRA_HOST";
export const INV_MARK = "TUGRA_INV";
export const REACH_MARK = "TUGRA_REACH";
export const FREEZE_MARK = "TUGRA_FZ";
/** The marks the existing identity-checked source scripts already print (see `source-scripts.ts`). */
const CTR_MARK = "TUGRA_CTR";
const STOP_MARK = "TUGRA_STOP";
const START_MARK = "TUGRA_START";

/** The largest report body the ingest accepts. */
export const REPORT_MAX_BYTES = 1024 * 1024;
export const REPORT_MAX_LINES = 20_000;
export const INV_MAX = { containers: 2000, mounts: 20_000, volumes: 5000, binds: 5000 } as const;

export const REF_RE = /^[A-Za-z0-9_-]{1,128}$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/;
const STATE_RE = /^[a-z]{3,12}$/;
const PATH_RE = /^\/[A-Za-z0-9._@+/-]{0,500}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const ITEMREF_RE = /^[a-z]+:[A-Za-z0-9_-]{1,128}:[A-Za-z0-9_-]{1,128}(:[A-Za-z0-9_-]{1,64})?$/;
const FREE_RE = /^[A-Za-z0-9 ._()/+-]{0,80}$/;

// ───────────────────────────── per-host loop status ─────────────────────────────

/** The steps a host-loop script can run for. */
export const LOOP_STEPS = ["DATA_SEED", "FREEZE", "DATA_FINAL", "INVENTORY"] as const;
export type LoopStep = (typeof LOOP_STEPS)[number];

/**
 * Per-host state of the loop for one step:
 *  - `connecting`: the host is being reached; `unreachable`: ssh could not connect (after the retries); `no-key` / `no-host`: the
 *    Coolify host has no key file / no record of this server;
 *  - `no-items`: nothing of the run lives on this host (skipped, not an error);
 *  - `launched` / `already`: the migrator was started / was already started by an earlier run of the script;
 *  - `running`: the migrator is still working; `finished`: it ended (see `rc`); `died`: it vanished without a result;
 *  - `failed`: anything else that went wrong (see `code`).
 */
export const LOOP_STATES = ["connecting", "unreachable", "no-key", "no-host", "no-items", "launched", "already", "running", "finished", "failed", "died"] as const;
export type LoopState = (typeof LOOP_STATES)[number];

/** States that mean "this host did not run": they fail the gate until a later run of the script overwrites them. */
export const LOOP_BAD_STATES: readonly LoopState[] = ["unreachable", "no-key", "no-host", "failed", "died"];

export interface LoopStatus {
  ref: string;
  step: LoopStep;
  state: LoopState;
  code: string;
  rc: number | null;
}

/** Did the migrator on this host end acceptably (exit 0 = ok, 1 = partial: the data steps' own gates judge what is missing)? */
export const loopFinishedOk = (s: Pick<LoopStatus, "state" | "rc">): boolean => s.state === "finished" && (s.rc === 0 || s.rc === 1);

/** A host's loop outcome as a verdict for a gate: `bad` (fail), `pending` (unknown) or `ok`. */
export function loopVerdict(s: Pick<LoopStatus, "state" | "rc"> | null): "ok" | "pending" | "bad" {
  if (!s) return "pending";
  if (s.state === "no-items") return "ok";
  if (s.state === "finished") return loopFinishedOk(s) ? "ok" : "bad";
  if (LOOP_BAD_STATES.includes(s.state)) return "bad";
  return "pending";
}

// ───────────────────────────── inventory ─────────────────────────────

export interface InvContainer {
  id: string;
  name: string;
  image: string;
  state: string;
}
export interface InvMount {
  ctrId: string;
  type: "volume" | "bind";
  /** Volume name (type volume) or null. */
  name: string | null;
  source: string;
  dest: string;
  rw: boolean;
}
export interface InvVolume {
  name: string;
  mountpoint: string;
  /** KiB measured with `du`; null = UNKNOWN (never 0). */
  sizeKiB: number | null;
  /** Containers (any state) that mount it. 0 = orphan. */
  links: number;
}
export interface InvBind {
  source: string;
  sizeKiB: number | null;
}

export interface HostInventory {
  ref: string;
  host: { name: string; docker: string; os: string };
  containers: InvContainer[];
  mounts: InvMount[];
  volumes: InvVolume[];
  binds: InvBind[];
  /** The `end` marker arrived and its line count matched: the report is whole. */
  complete: boolean;
  /** Lines of this host's inventory that failed validation and were dropped. */
  rejected: number;
}

export interface ReachReport {
  ref: string;
  /** HTTP status of the hub ping from the source host (000 = could not connect). */
  pingCode: number;
  /** The part size the hub is configured with, as the ping said (null when it did not answer). */
  hubPartMiB: number | null;
  /** The largest probed upload size the hub accepted (null = no probe ran, 0 = none passed). */
  maxPassedMiB: number | null;
  /** The smallest probed size that failed (null = none failed). */
  failedAtMiB: number | null;
  seconds: number | null;
}

/** What a freeze script reported for one host. */
export interface FreezePart {
  ref: string;
  recorded: Array<Pick<RecordedContainer, "id" | "name" | "image" | "ports" | "itemRef">>;
  /** container id -> `stopped | gone | mismatch | failed`. */
  stopped: Record<string, string>;
  /** container id -> `started | gone | mismatch | failed`. */
  started: Record<string, string>;
  unresolved: string[];
  /** `done` (the script ran to its end) | `error` (it stopped early, see `errorCode`) | null (not reported). */
  outcome: "done" | "error" | null;
  errorCode: string | null;
  action: "freeze" | "unfreeze" | null;
}

export interface ParsedReport {
  loop: LoopStatus[];
  inventory: Map<string, HostInventory>;
  reach: ReachReport[];
  freeze: Map<string, FreezePart>;
  rejected: number;
  lines: number;
}

const emptyInv = (ref: string): HostInventory & { _n: number; _end: number | null } => ({
  ref,
  host: { name: "", docker: "", os: "" },
  containers: [],
  mounts: [],
  volumes: [],
  binds: [],
  complete: false,
  rejected: 0,
  _n: 0,
  _end: null,
});

const emptyFreeze = (ref: string): FreezePart => ({ ref, recorded: [], stopped: {}, started: {}, unresolved: [], outcome: null, errorCode: null, action: null });

const asKiB = (v: string): number | null | undefined => {
  if (v === "unknown") return null;
  if (!/^[0-9]{1,15}$/.test(v)) return undefined; // undefined = invalid
  return Number(v);
};

/** Parse + VALIDATE a report body. A line that fails any check is dropped (and counted), never trusted. */
export function parseReportBody(text: string): ParsedReport {
  const out: ParsedReport = { loop: [], inventory: new Map(), reach: [], freeze: new Map(), rejected: 0, lines: 0 };
  const invs = new Map<string, ReturnType<typeof emptyInv>>();
  const inv = (ref: string) => {
    let i = invs.get(ref);
    if (!i) {
      i = emptyInv(ref);
      invs.set(ref, i);
    }
    return i;
  };
  const fz = (ref: string): FreezePart => {
    let f = out.freeze.get(ref);
    if (!f) {
      f = emptyFreeze(ref);
      out.freeze.set(ref, f);
    }
    return f;
  };
  const rawLines = text.split("\n");
  for (const raw of rawLines.slice(0, REPORT_MAX_LINES)) {
    const line = raw.replace(/\r$/, "");
    if (!line) continue;
    out.lines++;
    const f = line.split("\t");
    if (f[0] !== AT_MARK || f.length < 4 || !REF_RE.test(f[1])) {
      out.rejected++;
      continue;
    }
    const ref = f[1];
    const mark = f[2];
    const a = f.slice(3);
    if (mark === HOST_MARK) {
      // step, state, code, rc
      const [step, state, code, rc] = a;
      if (a.length !== 4 || !(LOOP_STEPS as readonly string[]).includes(step) || !(LOOP_STATES as readonly string[]).includes(state) || !/^[a-z0-9-]{1,40}$/.test(code) || !(rc === "-" || /^[0-9]{1,3}$/.test(rc))) {
        out.rejected++;
        continue;
      }
      out.loop.push({ ref, step: step as LoopStep, state: state as LoopState, code, rc: rc === "-" ? null : Number(rc) });
    } else if (mark === INV_MARK) {
      const i = inv(ref);
      const kind = a[0];
      const bad = () => {
        i.rejected++;
        out.rejected++;
      };
      if (kind === "end") {
        if (a.length !== 2 || !/^[0-9]{1,6}$/.test(a[1])) bad();
        else i._end = Number(a[1]);
        continue;
      }
      i._n++;
      if (kind === "host") {
        if (a.length !== 4 || !NAME_RE.test(a[1] || "x") || !/^[A-Za-z0-9._+~:-]{0,40}$/.test(a[2]) || !FREE_RE.test(a[3])) bad();
        else i.host = { name: a[1], docker: a[2], os: a[3] };
      } else if (kind === "ctr") {
        if (a.length !== 5 || !HEX64_RE.test(a[1]) || !NAME_RE.test(a[2]) || !IMAGE_RE.test(a[3]) || !STATE_RE.test(a[4])) bad();
        else if (i.containers.length >= INV_MAX.containers) bad();
        else i.containers.push({ id: a[1], name: a[2], image: a[3], state: a[4] });
      } else if (kind === "mount") {
        // ctrId, type, name|-, source, dest, rw
        const ok = a.length === 7 && HEX64_RE.test(a[1]) && (a[2] === "volume" || a[2] === "bind") && (a[3] === "-" || NAME_RE.test(a[3])) && PATH_RE.test(a[4]) && /^\/[A-Za-z0-9._@+/-]{0,500}$/.test(a[5]) && (a[6] === "true" || a[6] === "false");
        if (!ok) bad();
        else if (i.mounts.length >= INV_MAX.mounts) bad();
        else i.mounts.push({ ctrId: a[1], type: a[2] as "volume" | "bind", name: a[3] === "-" ? null : a[3], source: a[4], dest: a[5], rw: a[6] === "true" });
      } else if (kind === "vol") {
        const size = a.length === 5 ? asKiB(a[3]) : undefined;
        if (a.length !== 5 || !NAME_RE.test(a[1]) || !PATH_RE.test(a[2]) || size === undefined || !/^[0-9]{1,6}$/.test(a[4])) bad();
        else if (i.volumes.length >= INV_MAX.volumes) bad();
        else i.volumes.push({ name: a[1], mountpoint: a[2], sizeKiB: size, links: Number(a[4]) });
      } else if (kind === "bind") {
        const size = a.length === 3 ? asKiB(a[2]) : undefined;
        if (a.length !== 3 || !PATH_RE.test(a[1]) || size === undefined) bad();
        else if (i.binds.length >= INV_MAX.binds) bad();
        else i.binds.push({ source: a[1], sizeKiB: size });
      } else bad();
    } else if (mark === REACH_MARK) {
      // pingCode, hubPartMiB|-, maxPassedMiB|-, failedAtMiB|-, seconds|-
      const num = (v: string, re = /^[0-9]{1,6}$/): number | null | undefined => (v === "-" ? null : re.test(v) ? Number(v) : undefined);
      const [ping, part, max, failed, secs] = [a[0], num(a[1] ?? ""), num(a[2] ?? ""), num(a[3] ?? ""), num(a[4] ?? "")];
      if (a.length !== 5 || !/^[0-9]{3}$/.test(ping) || part === undefined || max === undefined || failed === undefined || secs === undefined) {
        out.rejected++;
        continue;
      }
      out.reach.push({ ref, pingCode: Number(ping), hubPartMiB: part, maxPassedMiB: max, failedAtMiB: failed, seconds: secs });
    } else if (mark === CTR_MARK) {
      // itemRef, id, name, image, ports, state (the identity-checked script's own line)
      const [itemRef, id, name, image, ports, state] = a;
      if (a.length !== 6 || !ITEMREF_RE.test(itemRef) || !HEX64_RE.test(id) || !NAME_RE.test(name) || !IMAGE_RE.test(image) || !/^[\x20-\x7e]{0,500}$/.test(ports) || !STATE_RE.test(state)) {
        out.rejected++;
        continue;
      }
      const part = fz(ref);
      if (state === "running" && part.recorded.length < 2000 && !part.recorded.some((c) => c.id === id)) part.recorded.push({ id, name, image, ports, itemRef });
    } else if (mark === STOP_MARK || mark === START_MARK) {
      const [id, outcome] = a;
      const allowed = mark === STOP_MARK ? ["stopped", "gone", "mismatch", "failed"] : ["started", "gone", "mismatch", "failed"];
      if (a.length !== 2 || !HEX64_RE.test(id) || !allowed.includes(outcome)) {
        out.rejected++;
        continue;
      }
      const part = fz(ref);
      if (mark === STOP_MARK) part.stopped[id] = outcome;
      else part.started[id] = outcome;
    } else if (mark === FREEZE_MARK) {
      const part = fz(ref);
      if (a[0] === "action" && a.length === 2 && (a[1] === "freeze" || a[1] === "unfreeze")) part.action = a[1];
      else if (a[0] === "unresolved" && a.length === 2 && ITEMREF_RE.test(a[1])) {
        if (part.unresolved.length < 500 && !part.unresolved.includes(a[1])) part.unresolved.push(a[1]);
      } else if (a[0] === "done" && a.length === 1) part.outcome = "done";
      else if (a[0] === "error" && a.length === 2 && /^[a-z0-9-]{1,40}$/.test(a[1])) {
        part.outcome = "error";
        part.errorCode = a[1];
      } else out.rejected++;
    } else out.rejected++;
  }
  for (const [ref, i] of invs) {
    const { _n, _end, ...rest } = i;
    out.inventory.set(ref, { ...rest, complete: _end !== null && _end === _n });
  }
  return out;
}

// ───────────────────────────── cross-check helpers shared by script and parser ─────────────────────────────

/** Engines recognised from a container image (the repository part, registry and tag stripped). `null` = not a database. */
const DB_IMAGE_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/^(postgres|postgresql|postgis|pgvector|pgvecto-rs|timescaledb|supabase\/postgres|bitnami\/postgresql|bitnami\/postgresql-repmgr|crunchydata\/crunchy-postgres)$/, "POSTGRES"],
  [/^(mariadb|bitnami\/mariadb|mariadb-galera)$/, "MARIADB"],
  [/^(mysql|bitnami\/mysql|mysql-server|percona|percona-server)$/, "MYSQL"],
  [/^(mongo|mongodb|bitnami\/mongodb|percona-server-mongodb)$/, "MONGODB"],
  [/^(redis|redis-stack|redis-stack-server|bitnami\/redis|valkey|valkey-bundle|bitnami\/valkey|keydb|eqalpha\/keydb|dragonfly|dragonflydb\/dragonfly)$/, "REDIS"],
  [/^(clickhouse|clickhouse-server|yandex\/clickhouse-server|clickhouse\/clickhouse-server|bitnami\/clickhouse)$/, "CLICKHOUSE"],
];

/** The engine family of a database image, or null when the image is not a database. */
export function dbEngineOfImage(image: string): string | null {
  const noDigest = image.split("@")[0];
  const lastColon = noDigest.lastIndexOf(":");
  const repoFull = lastColon > noDigest.lastIndexOf("/") ? noDigest.slice(0, lastColon) : noDigest;
  const parts = repoFull.split("/");
  // strip a registry host (has a dot or a colon, or is `localhost`)
  if (parts.length > 1 && (/[.:]/.test(parts[0]) || parts[0] === "localhost")) parts.shift();
  const repo = parts.join("/").toLowerCase();
  const base = parts[parts.length - 1].toLowerCase();
  for (const [re, engine] of DB_IMAGE_PATTERNS) if (re.test(repo) || re.test(base)) return engine;
  return null;
}
