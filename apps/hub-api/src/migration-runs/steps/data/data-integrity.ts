/**
 * What the final report says about the data of each migrated database: how it travelled (one dump, a checked stream, a file copy),
 * how many bytes and parts, ONE checksum for the whole artifact, and whether the rows on the target match the rows on the source.
 *
 * Pure: the caller supplies rows it already read. Nothing here is a secret (sizes, counts, hex digests, relation names).
 *
 * The checksum of a streamed copy is the sha256 of its ordered part list (`idx:rawOffset:rawLen:rawSha256` lines): every part's own
 * sha256 was checked at the relay and again on the target, so one digest over the list proves that the same bytes, in the same
 * order, were committed. The checksum of a one-dump copy is the sha256 the hub computed itself while staging the artifact.
 */
import { createHash } from "node:crypto";
import type { RunReport } from "../../core/dto";

export type DataIntegrityItem = RunReport["dataIntegrity"][number];

export interface IntegrityTask {
  itemRef: string | null;
  kind: string;
  status: string;
  resourceType: string | null;
  resourceId: string | null;
  name?: string | null;
  /** `BulkTask.result` (the artifact route stores `{ sha256, bytes }` on the `data:<itemRef>` task). */
  result?: unknown;
}

export interface IntegrityTransfer {
  resourceId: string;
  destType: string;
  state: string;
  partsDone: number;
  rawBytesDone: bigint | number;
  rawBytesFinal: bigint | number | null;
  parts: ReadonlyArray<{ idx: number; rawOffset: bigint | number; rawLen: number; rawSha256: string }>;
}

export interface IntegrityParityRow {
  subject: string;
  status: string;
  evidence: Record<string, unknown> | null;
}

const HEX64 = /^[0-9a-f]{64}$/;
const num = (v: bigint | number | null | undefined): number => (v == null ? 0 : Number(v));

/** sha256 over the ordered part list of a streamed copy; null when there are no parts. */
export function partListChecksum(parts: IntegrityTransfer["parts"]): string | null {
  if (parts.length === 0) return null;
  const h = createHash("sha256");
  for (const p of [...parts].sort((a, b) => a.idx - b.idx)) h.update(`${p.idx}:${num(p.rawOffset)}:${p.rawLen}:${p.rawSha256}\n`);
  return h.digest("hex");
}

const intOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);

/** The row-count verdict of one database, from its stored `db-logical-parity` check. */
export function rowsVerdict(row: IntegrityParityRow | undefined): DataIntegrityItem["rows"] {
  if (!row) return { status: "unverified", mode: null, relations: null, differing: null, sourceRows: null, targetRows: null, names: [] };
  const params = ((row.evidence as { params?: Record<string, unknown> } | null)?.params ?? {}) as Record<string, unknown>;
  const names = Array.isArray(params.names) ? params.names.filter((n): n is string => typeof n === "string").slice(0, 10).map((n) => n.slice(0, 200)) : [];
  const status: DataIntegrityItem["rows"]["status"] = row.status === "pass" ? "match" : row.status === "warn" ? "close" : row.status === "fail" ? "mismatch" : "unverified";
  return {
    status,
    mode: params.mode === "exact" || params.mode === "estimate" ? params.mode : null,
    relations: intOrNull(params.relations),
    differing: intOrNull(params.differing),
    sourceRows: intOrNull(params.sourceRows),
    targetRows: intOrNull(params.targetRows),
    names,
  };
}

export function buildDataIntegrity(i: {
  tasks: readonly IntegrityTask[];
  transfers: readonly IntegrityTransfer[];
  /** The databases whose data moved by the streamed dump lane / a physical copy (from the op's plan and meta). */
  streamRefs: ReadonlySet<string>;
  volumeRefs: ReadonlySet<string>;
  parity: readonly IntegrityParityRow[];
  /** Engine by database id. */
  engineOf: ReadonlyMap<string, string>;
  /** Display name by database id (falls back to the task's own name, then the item ref). */
  nameOf?: ReadonlyMap<string, string>;
}): DataIntegrityItem[] {
  const parityBy = new Map(i.parity.map((r) => [r.subject, r]));
  const out: DataIntegrityItem[] = [];
  for (const t of i.tasks) {
    if (t.kind !== "database" || t.status !== "DONE" || t.resourceType !== "database" || !t.resourceId || !t.itemRef) continue;
    const engine = i.engineOf.get(t.resourceId) ?? "";
    const base = { itemRef: t.itemRef.slice(0, 300), name: (i.nameOf?.get(t.resourceId) ?? t.name ?? t.itemRef).slice(0, 300), engine: engine.slice(0, 40), rows: rowsVerdict(parityBy.get(t.itemRef)) };
    if (i.streamRefs.has(t.itemRef) || i.volumeRefs.has(t.itemRef)) {
      const stream = i.streamRefs.has(t.itemRef);
      const tr = i.transfers.find((x) => x.resourceId === t.resourceId && x.destType === (stream ? "db-dump" : "db-data"));
      out.push({
        ...base,
        lane: stream ? "stream" : "files",
        bytes: tr ? num(tr.rawBytesFinal ?? tr.rawBytesDone) : null,
        parts: tr ? tr.partsDone : null,
        sha256: tr && tr.state === "DONE" ? partListChecksum(tr.parts) : null,
      });
      continue;
    }
    const data = i.tasks.find((x) => x.itemRef === `data:${t.itemRef}`);
    const r = (data?.result && typeof data.result === "object" ? data.result : {}) as { sha256?: unknown; bytes?: unknown };
    out.push({
      ...base,
      lane: "dump",
      bytes: intOrNull(r.bytes),
      parts: null,
      sha256: typeof r.sha256 === "string" && HEX64.test(r.sha256) ? r.sha256 : null,
    });
  }
  return out.sort((a, b) => (a.itemRef < b.itemRef ? -1 : 1));
}
