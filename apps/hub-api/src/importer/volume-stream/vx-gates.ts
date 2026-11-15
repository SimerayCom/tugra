import type { VxInventoryItem } from "./vx.dto";
import { PG_DATA_MOUNT, pgMajorOf } from "./vx-targets";
import { VX_409 } from "./vx-constants";

/**
 * The gates a Postgres data volume must pass before a PHYSICAL copy is offered (spec 6.6). Pure: the caller supplies
 * what it knows (the carried-credentials flag, the Tugra record, the migrator's inventory) and gets one result per gate.
 * `unknown` (no inventory yet) is treated as a failure wherever a copy would start: the gate fails closed and is never
 * reported "OK" without evidence.
 */
export type GateId = "inventory" | "credentials" | "major" | "layout" | "image" | "state" | "quiesced";
export type GateStatus = "pass" | "fail" | "unknown";
export interface GateResult {
  id: GateId;
  status: GateStatus;
  /** What the operator reads: the exact reason on a failure, the evidence on a pass. */
  text: string;
}

export interface DbGateInput {
  /** `result.credentialsCarried` of the DONE database task (undefined = not recorded = not carried). */
  credentialsCarried: boolean | undefined;
  record: { version: string; image: string; status: string; restores: number; backups: number };
  inventory: VxInventoryItem | undefined;
}

export const GATE_TEXT = {
  inventoryMissing: "the source has not been inspected yet: run the migrator with --dry-run to read its image, PostgreSQL major and data layout",
  credentials: "this database's credentials were not carried from the source, so a copied data directory would not match them; use the logical dump",
  layoutNested: "PostgreSQL 18 data layout is not supported by Tugra database volumes yet",
} as const;

export function evaluateDbGates(i: DbGateInput): GateResult[] {
  const inv = i.inventory;
  const g: GateResult[] = [];

  g.push(
    inv
      ? { id: "inventory", status: "pass", text: "the migrator inspected the source volume" }
      : { id: "inventory", status: "unknown", text: GATE_TEXT.inventoryMissing },
  );

  g.push(
    i.credentialsCarried === true
      ? { id: "credentials", status: "pass", text: "the source credentials were carried to the Tugra database, so the copied cluster's passwords match" }
      : { id: "credentials", status: "fail", text: GATE_TEXT.credentials },
  );

  const want = pgMajorOf(i.record.version);
  if (!inv || !inv.found) g.push({ id: "major", status: "unknown", text: GATE_TEXT.inventoryMissing });
  else if (!inv.pgMajor) g.push({ id: "major", status: "fail", text: "no PG_VERSION was found at the volume root, so the PostgreSQL major could not be proven" });
  else if (!want || want !== inv.pgMajor) g.push({ id: "major", status: "fail", text: `the source PostgreSQL major (${inv.pgMajor}) differs from the Tugra database version (${i.record.version}); use the logical dump` });
  else g.push({ id: "major", status: "pass", text: `PostgreSQL major ${inv.pgMajor} matches the Tugra database (PG_VERSION read by the migrator)` });

  if (!inv || !inv.found) g.push({ id: "layout", status: "unknown", text: GATE_TEXT.inventoryMissing });
  else if (inv.pgLayout === "nested") g.push({ id: "layout", status: "fail", text: GATE_TEXT.layoutNested });
  else if (inv.pgLayout !== "root") g.push({ id: "layout", status: "fail", text: "no PostgreSQL data directory (PG_VERSION) was found at the volume root" });
  else if (inv.mountDest !== PG_DATA_MOUNT) g.push({ id: "layout", status: "fail", text: `the source mounts its data at ${inv.mountDest ?? "an unknown path"}, Tugra mounts ${PG_DATA_MOUNT}` });
  else g.push({ id: "layout", status: "pass", text: `PGDATA is at the volume root and mounted at ${PG_DATA_MOUNT}` });

  if (!inv || !inv.found || !inv.image) g.push({ id: "image", status: "unknown", text: GATE_TEXT.inventoryMissing });
  else if (inv.image !== i.record.image) g.push({ id: "image", status: "fail", text: `the Tugra database runs ${i.record.image} but the source runs ${inv.image}; a physical copy needs the same image` });
  else g.push({ id: "image", status: "pass", text: `the same image on both sides (${inv.image})` });

  const clean = i.record.status === "NEW" && i.record.restores === 0 && i.record.backups === 0;
  g.push(clean ? { id: "state", status: "pass", text: "the destination database is as-provisioned: never started, nothing restored" } : { id: "state", status: "fail", text: VX_409.destDirty });

  if (!inv || !inv.found) g.push({ id: "quiesced", status: "unknown", text: GATE_TEXT.inventoryMissing });
  else if (inv.running) g.push({ id: "quiesced", status: "fail", text: "the source container is running; stop it first (a physical copy of a live cluster is not consistent)" });
  else g.push({ id: "quiesced", status: "pass", text: `the source container is stopped (exit code ${inv.exitCode ?? "unknown"}, reported by the migrator)` });

  return g;
}

/** The first gate that is not a pass (unknown counts: fail closed), or null when every gate passes. */
export function firstBlockingGate(gates: GateResult[]): GateResult | null {
  return gates.find((x) => x.status !== "pass") ?? null;
}
