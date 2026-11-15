/** The size of one relayed part of an app move (MOVE_PART_MIB): one definition for the env schema and the preflight. */
export const DEFAULT_PART_MIB = 256;
export const MIN_PART_MIB = 32;
export const MAX_PART_MIB = 1024;

/** A configured MiB value clamped into [MIN, MAX]; a non-number (or NaN) is the default. */
export function clampPartMib(n: number): number {
  return Number.isFinite(n) ? Math.min(MAX_PART_MIB, Math.max(MIN_PART_MIB, Math.floor(n))) : DEFAULT_PART_MIB;
}
