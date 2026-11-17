import { isValidUserEnvKey } from "../common/env-key";
import type { ForeignApp } from "./foreign-fleet";

/**
 * Pure classification of a Coolify `/applications/<uuid>/envs` row list. ONE helper feeds both the discover-time
 * {@link ForeignApp.envReport} (key NAMES + reason codes, never values) and the apply-time `fetchSecrets` (so the
 * plan and the executor can never disagree about which variable is carried).
 *
 * VALUES NEVER LEAVE THIS FILE: a value is inspected in memory only to detect an unexpanded shared reference and
 * is not copied into any output (the report carries key names + reason codes only).
 */

export type EnvReport = NonNullable<ForeignApp["envReport"]>;
export type EnvUnresolvedReason = EnvReport["unresolved"][number]["reason"];

/** The Coolify env row fields the classifier reads (structural, so the helper needs no adapter import). */
export interface EnvRowLike {
  key?: unknown;
  value?: unknown;
  real_value?: unknown;
  is_preview?: unknown;
  is_shared?: unknown;
  is_coolify?: unknown;
  is_literal?: unknown;
  /** Coolify "Lock": the value is shown once and never returned again, even to a read:sensitive token. */
  is_shown_once?: unknown;
}

/** Caps so a hostile or huge variable list can never bloat the plan. */
export const ENV_REPORT_MAX_ENTRIES = 200;
export const ENV_REPORT_KEY_MAX = 128;

/** A Coolify shared-variable reference that the API did not expand (`{{team.X}}`, `{{project.X}}`, `{{environment.X}}`). */
const SHARED_REF_RE = /\{\{\s*(team|project|environment)\./;

export type RowClass =
  | { kind: "skip" } // no usable key
  | { kind: "preview" }
  | { kind: "invalid"; key: string }
  | { kind: "value"; key: string; value: string }
  | { kind: "unresolved"; key: string; reason: EnvUnresolvedReason };

/** Classify ONE row. A literal row (`is_literal`) is never interpolated by Coolify, so brace text in it is real data. */
export function classifyEnvRow(e: EnvRowLike | null | undefined): RowClass {
  if (!e || typeof e.key !== "string") return { kind: "skip" };
  if (e.is_preview === true) return { kind: "preview" };
  const key = e.key;
  if (!isValidUserEnvKey(key)) return { kind: "invalid", key };
  const v = e.real_value ?? e.value; // real_value resolves shared/magic references
  if (typeof v === "string") {
    if (e.is_literal !== true && SHARED_REF_RE.test(v)) return { kind: "unresolved", key, reason: "SHARED_UNEXPANDED" };
    return { kind: "value", key, value: v };
  }
  // A locked row has no value for ANY token (not a permission problem): its own reason, checked before the others.
  if (e.is_shown_once === true) return { kind: "unresolved", key, reason: "LOCKED" };
  if (e.is_shared === true) return { kind: "unresolved", key, reason: "SHARED_UNEXPANDED" };
  if (e.is_coolify === true) return { kind: "unresolved", key, reason: "MAGIC" };
  return { kind: "unresolved", key, reason: "NO_VALUE" };
}

const byKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const clip = (k: string): string => (k.length > ENV_REPORT_KEY_MAX ? k.slice(0, ENV_REPORT_KEY_MAX) : k);

/**
 * The discover-time report for one app. `rows` is the raw `/envs` payload (anything non-array is treated as no
 * rows). `tokenReadOnly` = there ARE readable variables but NO row carried a string value: the API token lacks
 * `read:sensitive`, so every variable is unreadable (reported once, not once per key). Locked rows (`is_shown_once`) never
 * carry a value, whatever the token: they are reported as LOCKED and do not count towards a token problem.
 */
export function buildEnvReport(rows: unknown): EnvReport {
  const list = Array.isArray(rows) ? (rows as EnvRowLike[]) : [];
  let total = 0;
  let previewSkipped = 0;
  let anyValue = false;
  let locked = 0;
  const unresolved: EnvReport["unresolved"] = [];
  const invalid: string[] = [];
  for (const row of list) {
    const c = classifyEnvRow(row);
    if (c.kind === "skip") continue;
    if (c.kind === "preview") {
      previewSkipped++;
      continue;
    }
    total++;
    if (c.kind === "invalid") invalid.push(clip(c.key));
    else if (c.kind === "unresolved") {
      unresolved.push({ key: clip(c.key), reason: c.reason });
      if (c.reason === "LOCKED") locked++;
    }
    // A string value that is an unexpanded reference still proves the token can READ values.
    const r = row as EnvRowLike;
    if (typeof (r.real_value ?? r.value) === "string") anyValue = true;
  }
  unresolved.sort((a, b) => byKey(a.key, b.key));
  invalid.sort(byKey);
  return {
    total,
    previewSkipped,
    unresolved: unresolved.slice(0, ENV_REPORT_MAX_ENTRIES),
    invalidKeys: invalid.slice(0, ENV_REPORT_MAX_ENTRIES),
    tokenReadOnly: total - locked > 0 && !anyValue,
  };
}
