import type { GateResult } from "./vx-gates";
import type { VxInventoryItem } from "./vx.dto";
import type { VxVolumeTarget } from "./vx-targets";

/** The user-facing, secret-free view of one streamed volume (what `GET /import/operations/:opId/volumes` returns). */
export interface VolumeTransferView {
  itemRef: string;
  resourceName: string | null;
  mountPath: string;
  destType: "app-volume" | "db-data";
  destVolume: string;
  /** NONE until the migrator begins; EXCLUDED when the owner explicitly chose not to migrate it. */
  state: "NONE" | "EXCLUDED" | "PENDING" | "COPYING" | "COPIED" | "APPLYING" | "DONE" | "FAILED" | "ABORTED";
  phase: string | null;
  partsDone: number;
  bytesDone: number;
  rawBytesDone: number;
  rawBytesTotal: number | null;
  bps: number | null;
  etaSec: number | null;
  inventory: Pick<VxInventoryItem, "found" | "rawBytes" | "entries" | "mountType" | "running" | "exitCode" | "image" | "pgMajor" | "pgLayout" | "mountDest" | "specials"> | null;
  diskVerdict: { ok: boolean; unknown: boolean; details: Record<string, number | boolean | string | null> } | null;
  gates: GateResult[] | null;
  /** The quiescence/inventory facts come from the (untrusted) source host: the UI must label them as such. */
  evidenceNote: "reported by the migrator";
  excluded: { reason: string } | null;
  error: string | null;
  steps: Array<{ name: string; status: string }>;
  canAbort: boolean;
  canReset: boolean;
}

export interface TransferRowLite {
  state: string;
  phase: string | null;
  partsDone: number;
  bytesDone: bigint | number;
  rawBytesDone: bigint | number;
  rawBytesTotal: bigint | number | null;
  bps: bigint | number | null;
  error: string | null;
  startedAt: Date | null;
}

const num = (v: bigint | number | null | undefined): number => (v == null ? 0 : Number(v));

/** Seconds left at the current rate, or null when there is no rate / total yet. Never negative, never NaN. */
export function etaSeconds(rawDone: number, rawTotal: number | null, bps: number | null): number | null {
  if (!rawTotal || rawTotal <= 0 || !bps || bps <= 0) return null;
  const left = Math.max(0, rawTotal - rawDone);
  return Math.ceil(left / bps);
}

export function buildVolumeView(o: {
  target: VxVolumeTarget;
  resourceName: string | null;
  destVolume: string;
  transfer: TransferRowLite | null;
  inventory: VxInventoryItem | undefined;
  disk: VolumeTransferView["diskVerdict"];
  gates: GateResult[] | null;
  steps: unknown;
}): VolumeTransferView {
  const t = o.transfer;
  const live = !!t && ["PENDING", "COPYING", "COPIED", "APPLYING"].includes(t.state);
  const state: VolumeTransferView["state"] = o.target.excluded && !t ? "EXCLUDED" : ((t?.state as VolumeTransferView["state"]) ?? "NONE");
  const rawDone = num(t?.rawBytesDone);
  const rawTotal = t?.rawBytesTotal != null ? num(t.rawBytesTotal) : o.inventory?.found ? o.inventory.rawBytes : null;
  const bps = t?.bps != null ? num(t.bps) : null;
  return {
    itemRef: o.target.itemRef,
    resourceName: o.resourceName,
    mountPath: o.target.mountPath,
    destType: o.target.destType,
    destVolume: o.destVolume,
    state,
    phase: t?.phase ?? null,
    partsDone: t?.partsDone ?? 0,
    bytesDone: num(t?.bytesDone),
    rawBytesDone: rawDone,
    rawBytesTotal: rawTotal,
    bps,
    etaSec: state === "COPYING" ? etaSeconds(rawDone, rawTotal, bps) : null,
    inventory: o.inventory
      ? {
          found: o.inventory.found,
          rawBytes: o.inventory.rawBytes,
          entries: o.inventory.entries,
          mountType: o.inventory.mountType,
          running: o.inventory.running,
          exitCode: o.inventory.exitCode,
          image: o.inventory.image,
          pgMajor: o.inventory.pgMajor,
          pgLayout: o.inventory.pgLayout,
          mountDest: o.inventory.mountDest,
          specials: o.inventory.specials,
        }
      : null,
    diskVerdict: o.disk,
    gates: o.gates,
    evidenceNote: "reported by the migrator",
    excluded: o.target.excluded ? { reason: o.target.excluded.reason } : null,
    error: t?.error ?? null,
    steps: Array.isArray(o.steps) ? (o.steps as Array<{ name: string; status: string }>) : [],
    canAbort: live,
    // Reset wipes the destination volume: never while applying, and never once DONE (that data is the migration's result).
    canReset: !!t && ["PENDING", "COPYING", "FAILED", "ABORTED"].includes(t.state),
  };
}
