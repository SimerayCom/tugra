import type { AppMovePhase } from "@prisma/client";

/** One entry of AppMove.volumes (JSON). `state` is the transfer state machine, not the plan's move/skip choice. */
export interface StoredVolume {
  name: string;
  dockerName: string;
  kind: "app" | "compose";
  sizeBytes: number | null;
  /** PENDING -> PACKED -> TRANSFERRED -> APPLIED, or SKIPPED (absent on the source / external). */
  state: "PENDING" | "PACKED" | "TRANSFERRED" | "APPLIED" | "SKIPPED";
  parts: number;
  partsDone: number;
  bytesDone: number;
  /** Entry count the pack reported (`find | wc -l`); the apply must reproduce it. */
  entries: number | null;
  /** Created by this move's prepare (so rollback may remove it); false = it already existed (never removed). */
  createdOnTarget: boolean;
  /** The destination volume held an archive of an earlier move that the apply overwrites. */
  archiveOverwritten: boolean;
}

export interface MoveWarning {
  code: string;
  details?: Record<string, unknown>;
}

export type MovePhaseName = AppMovePhase;

export function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}
