import type { ProjectMoveItemView, ProjectMoveReport } from "@tugra/shared";
import type { MoveAckInput } from "../app-moves/dto";

/**
 * What a project move remembers between steps (`ProjectMove.plan`, JSON). Ids, names and fixed stages only: no env value, no credential, no
 * connection string. Every runner step reads its stage first and does only what is left, so a hub restart in the middle resumes instead of
 * repeating (a database is never copied twice, an app is never unlinked twice).
 */

export type DbStage = "pending" | "created" | "provisioned" | "backed_up" | "restored" | "source_stopped";
export interface StoredDb {
  stage: DbStage;
  configOnly: boolean;
  /** The copy on the target. */
  targetDbId?: string;
  backupId?: string;
  /** The source database's name before it was set aside as the safety copy. */
  oldName: string;
  /** The source database was renamed and stopped: it is now the safety copy. */
  setAside?: boolean;
  /** Names of the extra volumes already copied to the target (an interrupted copy resumes with the rest). */
  volumesDone?: string[];
  /** The source database was stopped early so its extra volumes could be copied as they are: a rollback starts it again. */
  sourceStopped?: boolean;
}

/**
 * The owner's undo of a move that ended FAILED. Each app and database has its own stage so an interrupted undo resumes where it stopped
 * (an app is never moved back twice, a database is never brought up to date twice).
 */
export type UndoAppStage = "pending" | "stopped" | "unlinked" | "moving" | "moved" | "relinked" | "done";
export type UndoDbStage = "pending" | "synced" | "unset" | "copy_removed";
export interface UndoState {
  apps: Record<string, { stage: UndoAppStage; moveId?: string }>;
  dbs: Record<string, { stage: UndoDbStage; backupId?: string }>;
}

/** `unlinking`: the links and flags are recorded, removal is under way (a crash here still leaves what rollback needs). */
export type AppStage = "pending" | "unlinking" | "unlinked" | "moving" | "moved" | "relinked" | "redeployed";
export interface StoredApp {
  stage: AppStage;
  moveId?: string;
  /** The managed-database links the move removed and puts back on the copies: envVar and the SOURCE database id. */
  links: Array<{ envVar: string; databaseId: string }>;
  hadDbNetwork: boolean;
  wasRunning: boolean;
}

export interface StoredPlan {
  v: 1;
  acks: MoveAckInput;
  repointDns: boolean;
  confirmName: string;
  dbs: Record<string, StoredDb>;
  apps: Record<string, StoredApp>;
  /** Apps the move stopped so no write reaches a database while it is copied (they were running). */
  frozen: string[];
  targetIp: string | null;
  report?: ProjectMoveReport;
  /** The safety copy (set-aside databases) was removed. */
  safetyPurged?: boolean;
  /** The owner asked for the undo of a failed move (the runner then runs the full rollback, not the automatic one). */
  ownerRollback?: boolean;
  undo?: UndoState;
  warnings: string[];
}

/** Something happened that an undo would have to put back: an app left its first step, or a database copy exists. */
export const hasUndoable = (p: StoredPlan): boolean => Object.values(p.apps).some((a) => a.stage !== "pending") || Object.values(p.dbs).some((d) => !!d.targetDbId);

export function parsePlan(v: unknown): StoredPlan {
  const o = v && typeof v === "object" && !Array.isArray(v) ? (v as Partial<StoredPlan>) : {};
  return {
    v: 1,
    acks: (o.acks ?? {}) as MoveAckInput,
    repointDns: o.repointDns === true,
    confirmName: typeof o.confirmName === "string" ? o.confirmName : "",
    dbs: o.dbs && typeof o.dbs === "object" ? o.dbs : {},
    apps: o.apps && typeof o.apps === "object" ? o.apps : {},
    frozen: Array.isArray(o.frozen) ? o.frozen.filter((x): x is string => typeof x === "string") : [],
    targetIp: typeof o.targetIp === "string" ? o.targetIp : null,
    report: o.report,
    safetyPurged: o.safetyPurged === true,
    ownerRollback: o.ownerRollback === true,
    ...(o.undo && typeof o.undo === "object" ? { undo: { apps: o.undo.apps ?? {}, dbs: o.undo.dbs ?? {} } } : {}),
    warnings: Array.isArray(o.warnings) ? o.warnings.filter((x): x is string => typeof x === "string") : [],
  };
}

export function parseItems(v: unknown): ProjectMoveItemView[] {
  return Array.isArray(v) ? (v as ProjectMoveItemView[]) : [];
}
