/**
 * The stored host reports of a run, decoded back into the typed views the handlers judge. The rows were validated by
 * `parseReportBody` before they were stored, but they live in a JSON column, so each decoder still checks the shape and
 * drops what does not fit (a hand-edited row can never crash a step).
 */
import { HOST_REPORT_KINDS, type HostReport, type HostReportPort } from "./inventory-contract";
import { LOOP_STATES, LOOP_STEPS, type HostInventory, type LoopState, type LoopStatus, type LoopStep, type ReachReport } from "./host-protocol";
import { asFreezePayload, type FreezePayload, type FreezeState, FREEZE_STATES } from "./report-merge";

export interface HostView {
  /** The latest loop status per (step, host). */
  loop: LoopStatus[];
  inventories: Map<string, HostInventory>;
  reach: Map<string, ReachReport>;
  freeze: Map<string, { state: FreezeState; payload: FreezePayload; at: Date }>;
  /** Ids of the stored inventory rows (what `attach` points at), per host. */
  inventoryIds: Map<string, string>;
}

export const emptyHostView = (): HostView => ({ loop: [], inventories: new Map(), reach: new Map(), freeze: new Map(), inventoryIds: new Map() });

const isArr = (v: unknown): v is unknown[] => Array.isArray(v);

function decodeInventory(r: HostReport): HostInventory | null {
  const p = r.payload;
  if (!p || !isArr(p.containers) || !isArr(p.mounts) || !isArr(p.volumes) || !isArr(p.binds)) return null;
  return { ...(p as unknown as HostInventory), ref: r.sourceServerRef, complete: r.state === "complete" };
}

function decodeReach(r: HostReport): ReachReport | null {
  const p = r.payload;
  if (!p || typeof p.pingCode !== "number") return null;
  const n = (v: unknown): number | null => (typeof v === "number" ? v : null);
  return { ref: r.sourceServerRef, pingCode: p.pingCode, hubPartMiB: n(p.hubPartMiB), maxPassedMiB: n(p.maxPassedMiB), failedAtMiB: n(p.failedAtMiB), seconds: n(p.seconds) };
}

export function decodeHostReports(rows: readonly HostReport[]): HostView {
  const v = emptyHostView();
  for (const r of rows) {
    if (!(HOST_REPORT_KINDS as readonly string[]).includes(r.kind)) continue;
    if (r.kind === "loop") {
      if (!(LOOP_STEPS as readonly string[]).includes(r.stepKey) || !(LOOP_STATES as readonly string[]).includes(r.state)) continue;
      v.loop.push({ ref: r.sourceServerRef, step: r.stepKey as LoopStep, state: r.state as LoopState, code: typeof r.payload?.code === "string" ? r.payload.code : "unknown", rc: typeof r.payload?.rc === "number" ? r.payload.rc : null });
    } else if (r.kind === "inventory") {
      const inv = decodeInventory(r);
      if (inv) {
        v.inventories.set(r.sourceServerRef, inv);
        v.inventoryIds.set(r.sourceServerRef, r.id);
      }
    } else if (r.kind === "reach") {
      const reach = decodeReach(r);
      if (reach) v.reach.set(r.sourceServerRef, reach);
    } else if (r.kind === "freeze") {
      if ((FREEZE_STATES as readonly string[]).includes(r.state)) v.freeze.set(r.sourceServerRef, { state: r.state as FreezeState, payload: asFreezePayload(r.payload), at: r.reportedAt });
    }
  }
  return v;
}

export async function loadHostView(port: HostReportPort | undefined, runId: string): Promise<HostView> {
  if (!port) return emptyHostView();
  return decodeHostReports(await port.list(runId));
}

/** The latest loop status of `step` per host. */
export const loopByHost = (v: HostView, step: LoopStep): Map<string, LoopStatus> => new Map(v.loop.filter((l) => l.step === step).map((l) => [l.ref, l]));
