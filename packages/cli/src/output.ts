import type { Row } from "./client";

export interface Column {
  key: string;
  header: string;
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v);
}

/** Pretty-printed JSON (the `--json` output). */
export function formatJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

/** A plain aligned text table — no color/box dependencies. Defensive against a non-array input. */
export function formatTable(rows: Row[], columns: Column[]): string {
  if (!Array.isArray(rows) || rows.length === 0) return "(none)";
  const widths = columns.map((c) => Math.max(c.header.length, ...rows.map((r) => cell(r[c.key]).length)));
  const line = (cells: string[]) => cells.map((v, i) => v.padEnd(widths[i])).join("  ").replace(/\s+$/, "");
  const out = [line(columns.map((c) => c.header))];
  for (const r of rows) out.push(line(columns.map((c) => cell(r[c.key]))));
  return out.join("\n");
}

export function printJson(data: unknown): void {
  process.stdout.write(`${formatJson(data)}\n`);
}

export function printTable(rows: Row[], columns: Column[]): void {
  process.stdout.write(`${formatTable(rows, columns)}\n`);
}

export function printLine(text: string): void {
  process.stdout.write(`${text}\n`);
}

export function printError(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`error: ${msg}\n`);
}
