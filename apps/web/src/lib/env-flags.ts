/** Pure helpers for the per-variable env flags (build time / runtime / literal / multiline) in the env editor.
 *
 * Mirrors only the cheap, non-security rules of the hub's validator, each mapped to an i18n key. The hub's
 * reserved-host-name deny list is deliberately NOT mirrored here (it would drift); the server's message is shown. */
import type { EnvFlagView } from "./api";
import type { EnvRow } from "./dotenv";

export type { EnvFlagView };

// Pinned to the hub's limits (common/env-flags.ts); env-flags.test.ts pins the numbers.
export const ML_VALUE_MAX_BYTES = 16 * 1024;
export const ML_KEYS_MAX = 32;
export const ML_TOTAL_MAX_BYTES = 48 * 1024;
export const BUILD_TOTAL_MAX_BYTES = 48 * 1024;

const POSIX_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BUILD_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export const DEFAULT_FLAGS: EnvFlagView = { buildTime: false, runtime: true, literal: false, multiline: false };

/** Fill defaults so two flag objects compare regardless of key order or omitted fields. */
export function canonicalFlags(f?: Partial<EnvFlagView> | null): EnvFlagView {
  return {
    buildTime: f?.buildTime === true,
    runtime: f?.runtime !== false,
    literal: f?.literal === true,
    multiline: f?.multiline === true,
  };
}

export function flagsEqual(a?: Partial<EnvFlagView> | null, b?: Partial<EnvFlagView> | null): boolean {
  const x = canonicalFlags(a);
  const y = canonicalFlags(b);
  return x.buildTime === y.buildTime && x.runtime === y.runtime && x.literal === y.literal && x.multiline === y.multiline;
}

export function isDefaultFlags(f?: Partial<EnvFlagView> | null): boolean {
  return flagsEqual(f, DEFAULT_FLAGS);
}

export const hasLineBreak = (v: string): boolean => /[\r\n]/.test(v);

const byteLen = (s: string): number => new TextEncoder().encode(s).length;

export interface RowIssue {
  code: "nul" | "newline" | "runtimeOffNeedsBuild" | "buildKey" | "multilineKey" | "literalKey" | "buildSource" | "tooLarge";
  /** i18n key under `apps.` */
  i18nKey: string;
  params?: Record<string, string | number>;
}

export interface FlagCtx {
  applicable: { buildTime: boolean; literal: boolean };
}

/** Per-row problems (blocking). `row.flags` undefined = the row carries no flags. */
export function rowIssues(row: { key: string; value: string; flags?: Partial<EnvFlagView> | null }, ctx: FlagCtx): RowIssue[] {
  const f = canonicalFlags(row.flags);
  const key = row.key.trim();
  const out: RowIssue[] = [];
  if (row.value.includes("\u0000")) out.push({ code: "nul", i18nKey: "envRowNul" });
  else if (hasLineBreak(row.value) && !f.multiline) out.push({ code: "newline", i18nKey: "envRowNewline" });
  if (f.multiline) {
    if (key && !POSIX_KEY.test(key)) out.push({ code: "multilineKey", i18nKey: "envRowMultilineKey" });
    if (byteLen(row.value) > ML_VALUE_MAX_BYTES) out.push({ code: "tooLarge", i18nKey: "envRowTooLarge", params: { max: "16 KiB" } });
  }
  if (f.literal && ctx.applicable.literal && key && !POSIX_KEY.test(key)) out.push({ code: "literalKey", i18nKey: "envRowLiteralKey" });
  if (f.buildTime) {
    if (!ctx.applicable.buildTime) out.push({ code: "buildSource", i18nKey: "envRowBuildSource" });
    if (key && !BUILD_KEY.test(key)) out.push({ code: "buildKey", i18nKey: "envRowBuildKey" });
  }
  if (!f.runtime && !f.buildTime) out.push({ code: "runtimeOffNeedsBuild", i18nKey: "envRowRuntimeOffNeedsBuild" });
  return out;
}

export interface BudgetIssue {
  i18nKey: string;
  params: Record<string, string | number>;
}

/** Whole-card budgets (multiline count/total, build-time total). */
export function budgetIssues(rows: { key: string; value: string; flags?: Partial<EnvFlagView> | null }[]): BudgetIssue[] {
  let mlCount = 0;
  let mlBytes = 0;
  let buildBytes = 0;
  for (const r of rows) {
    const f = canonicalFlags(r.flags);
    const k = r.key.trim();
    if (!k) continue;
    if (f.multiline) {
      mlCount += 1;
      mlBytes += byteLen(r.value);
    }
    if (f.buildTime) buildBytes += byteLen(`${k}=${r.value}`);
  }
  const out: BudgetIssue[] = [];
  if (mlCount > ML_KEYS_MAX || mlBytes > ML_TOTAL_MAX_BYTES) out.push({ i18nKey: "envMultilineBudget", params: { max: "48 KiB" } });
  if (buildBytes > BUILD_TOTAL_MAX_BYTES) out.push({ i18nKey: "envBuildBudget", params: { max: "48 KiB" } });
  return out;
}

/** After a bulk apply: keep the flags a key already had, and switch Multiline on for any value with a line break.
 *  Returns the rows plus how many rows were auto-switched (for the toast). */
export function applyBulkFlags(parsed: EnvRow[], previous: { key: string; flags?: EnvFlagView }[]): { rows: (EnvRow & { flags: EnvFlagView })[]; autoCount: number } {
  const prev = new Map(previous.map((r) => [r.key.trim(), r.flags]));
  let autoCount = 0;
  const rows = parsed.map((r) => {
    const flags = canonicalFlags(prev.get(r.key.trim()));
    // An unterminated quote swallowed the rest of the text: that is a typo, not a multiline value (the editor
    // blocks Apply for it; never turn it into a Multiline variable here either).
    if (hasLineBreak(r.value) && !flags.multiline && !r.unterminated) {
      flags.multiline = true;
      autoCount += 1;
    }
    return { ...r, flags };
  });
  return { rows, autoCount };
}

/** Sparse request body for PUT /env: only rows that carry non-default flags, full booleans. */
export function flagsPayload(rows: { key: string; flags?: Partial<EnvFlagView> | null }[]): Record<string, EnvFlagView> {
  const out: Record<string, EnvFlagView> = {};
  for (const r of rows) {
    const k = r.key.trim();
    if (k && !isDefaultFlags(r.flags)) out[k] = canonicalFlags(r.flags);
    else if (k) delete out[k]; // a later duplicate row wins, like the env map
  }
  return out;
}

/** Number of lines for the masked multiline block. */
export function lineCount(v: string): number {
  return v === "" ? 0 : v.split(/\r\n|\r|\n/).length;
}

/** Same pattern as the hub's looksSensitiveKey (deploy/build-args.ts); used only for a non-blocking advisory. */
export function looksSensitiveKey(key: string): boolean {
  return /(^|[_-])(secret|token|passw(or)?d|private[_-]?key|api[_-]?key|access[_-]?key|credential|auth[_-]?(key|token|secret))s?($|[_-])/i.test(key);
}
