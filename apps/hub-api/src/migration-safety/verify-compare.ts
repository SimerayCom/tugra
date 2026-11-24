/**
 * Pure logic of the migration verification report (item 92): turn what was measured on the source and on the target into
 * rows with a verdict, and the rows into one answer, "Source and target match" or a list of differences. Nothing here
 * does I/O and nothing carries a secret: page bodies are hashed and dropped, env values are never read (key names only).
 */
import { createHash } from "node:crypto";

export const VERDICTS = ["same", "similar", "differs", "unknown"] as const;
export type Verdict = (typeof VERDICTS)[number];

/** What one side answered for one page. `error` is a fixed code (never the response text). */
export interface PageSample {
  status: number | null;
  /** sha256 (hex) of the normalized body; null when there was no body or no answer. */
  hash: string | null;
  bytes: number;
  title: string | null;
  /** Location header of a redirect, reduced by {@link redirectTarget}. */
  location: string | null;
  truncated: boolean;
  error: string | null;
}

export const EMPTY_SAMPLE: PageSample = { status: null, hash: null, bytes: 0, title: null, location: null, truncated: false, error: null };

const sha256 = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");

/**
 * Strip what changes between two correct copies of the same page (scripts, styles, comments, nonces, hidden form
 * fields, build ids and long tokens, whitespace), so a hash difference means the content really differs.
 */
export function normalizeHtml(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/\s(?:nonce|integrity|data-reactroot|data-build-id)(?:="[^"]*")?/gi, "")
    .replace(/<input\b[^>]*type=["']?hidden["']?[^>]*>/gi, "")
    .replace(/<meta\b[^>]*name=["']?csrf[^>]*>/gi, "")
    .replace(/\b[0-9a-f]{16,}\b/gi, "#")
    .replace(/[A-Za-z0-9_-]{24,}/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

export function pageTitle(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const t = m ? m[1].replace(/\s+/g, " ").trim().slice(0, 160) : "";
  return t || null;
}

const isHtml = (contentType: string | null, head: string): boolean => /html/i.test(contentType ?? "") || /^\s*<(?:!doctype|html)/i.test(head);

/** Where a redirect goes, comparable across the two sides: same-host redirects reduce to their path. */
export function redirectTarget(location: string | null, host: string): string | null {
  if (!location) return null;
  try {
    const u = new URL(location, `https://${host}`);
    return u.hostname === host ? `${u.pathname}${u.search}` : `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return null;
  }
}

/** Reduce one raw answer to a {@link PageSample}. The body is hashed here and never kept. */
export function samplePage(raw: { status: number; contentType: string | null; location: string | null; body: Buffer; truncated: boolean }, host: string): PageSample {
  const text = raw.body.toString("utf8");
  const html = isHtml(raw.contentType, text.slice(0, 200));
  return {
    status: raw.status,
    hash: raw.body.length ? sha256(html ? normalizeHtml(text) : raw.body) : null,
    bytes: raw.body.length,
    title: html ? pageTitle(text) : null,
    location: redirectTarget(raw.location, host),
    truncated: raw.truncated,
    error: null,
  };
}

export interface PageVerdict {
  verdict: Verdict;
  /** Fixed code; the web maps it to `migrationRun.verifyReport.page.<code>`. */
  code: string;
}

/**
 * Compare one page. `same` = same status and same normalized content; `similar` = same status and title but the body
 * differs a little (a counter, a date), reported but not a difference; `differs` = another status, another redirect, or
 * another page; `unknown` = a side did not answer (never a pass).
 */
export function comparePage(source: PageSample, target: PageSample): PageVerdict {
  if (source.error || source.status === null) return { verdict: "unknown", code: "source-unreachable" };
  if (target.error || target.status === null) return { verdict: "unknown", code: target.error === "dark-proxy" ? "same-host-needs-agent" : "target-unreachable" };
  if (source.status !== target.status) return { verdict: "differs", code: "status" };
  if (source.status >= 500) return { verdict: "similar", code: "both-failing" };
  if (source.status >= 300 && source.status < 400) return source.location === target.location ? { verdict: "same", code: "same-redirect" } : { verdict: "differs", code: "redirect" };
  if (source.hash === target.hash) return { verdict: "same", code: "same-content" };
  if (source.title && source.title === target.title) return { verdict: "similar", code: "content-close" };
  return { verdict: "differs", code: "content" };
}

export interface PageRow {
  host: string;
  path: string;
  source: PageSample;
  target: PageSample;
  verdict: Verdict;
  code: string;
}

export function pageRow(host: string, path: string, source: PageSample, target: PageSample): PageRow {
  return { host, path, source, target, ...comparePage(source, target) };
}

// ───────────────────────────── databases ─────────────────────────────

export interface TableLite {
  name: string;
  rows: number;
}
export interface DbRow {
  itemRef: string;
  name: string | null;
  engine: string | null;
  verdict: Verdict;
  /** Parity code of the logical comparison (`parity.*`), or `not-measured`. */
  code: string;
  sourceRows: number | null;
  targetRows: number | null;
  /** The tables whose counts differ (capped), source vs target; -1 = not counted on that side. */
  tables: Array<{ name: string; source: number; target: number }>;
}

/** The tables of two sides whose counts disagree (a side missing a table counts as -1). Capped so a hostile report stays small. */
export function tableDiffs(source: readonly TableLite[], target: readonly TableLite[], cap = 20): DbRow["tables"] {
  const s = new Map(source.map((t) => [t.name, t.rows]));
  const t = new Map(target.map((x) => [x.name, x.rows]));
  const out: DbRow["tables"] = [];
  for (const name of [...new Set([...s.keys(), ...t.keys()])].sort()) {
    const a = s.get(name) ?? -1;
    const b = t.get(name) ?? -1;
    if (a !== b) out.push({ name, source: a, target: b });
    if (out.length >= cap) break;
  }
  return out;
}

// ───────────────────────────── volumes ─────────────────────────────

export interface VolumeRow {
  itemRef: string;
  name: string | null;
  verdict: Verdict;
  code: string;
  files: number | null;
  /** Raw bytes the migrator says it read on the source / raw bytes the hub committed on the target. */
  sourceBytes: number | null;
  targetBytes: number | null;
}

export interface VolumeFacts {
  itemRef: string;
  name: string | null;
  state: string;
  entries: number | null;
  rawBytesFinal: number | null;
  rawBytesDone: number;
}

export function volumeRow(v: VolumeFacts): VolumeRow {
  const base = { itemRef: v.itemRef, name: v.name, files: v.entries, sourceBytes: v.rawBytesFinal, targetBytes: v.rawBytesDone };
  if (v.state !== "DONE") return { ...base, verdict: "differs", code: "not-copied" };
  if (v.rawBytesFinal === null || v.entries === null) return { ...base, verdict: "unknown", code: "not-reported" };
  return v.rawBytesFinal === v.rawBytesDone ? { ...base, verdict: "same", code: "same-size" } : { ...base, verdict: "differs", code: "size" };
}

// ───────────────────────────── env keys ─────────────────────────────

export interface EnvRow {
  itemRef: string;
  name: string | null;
  verdict: Verdict;
  code: string;
  targetKeys: number | null;
  /** Variable NAMES the source has and the target does not (never values), with the importer's reason. */
  missing: Array<{ key: string; reason: string }>;
}

/**
 * `sourceKeys` = the variable names the source app had (recorded by the import, names only); `targetKeyNames` = the names the
 * target app holds now. A source name the target lacks is `missing`; the importer's own unresolved / invalid reasons win over
 * that for the same name. Without the recorded source names (a run imported before they were kept) only the importer's own
 * list is judged.
 */
export function envRow(f: {
  itemRef: string;
  name: string | null;
  targetKeys: number | null;
  unresolved: readonly string[];
  dropped: readonly string[];
  sourceKeys?: readonly string[] | null;
  targetKeyNames?: readonly string[] | null;
}): EnvRow {
  const found = [...f.unresolved.map((key) => ({ key, reason: "unresolved" })), ...f.dropped.map((key) => ({ key, reason: "invalid" }))];
  if (f.sourceKeys && f.targetKeyNames) {
    const have = new Set(f.targetKeyNames);
    const known = new Set(found.map((m) => m.key));
    for (const key of f.sourceKeys) if (!have.has(key) && !known.has(key)) found.push({ key, reason: "missing" });
  }
  const missing = found.slice(0, 50);
  return { itemRef: f.itemRef, name: f.name, targetKeys: f.targetKeys, missing, verdict: missing.length ? "differs" : f.targetKeys === null ? "unknown" : "same", code: missing.length ? "keys-missing" : f.targetKeys === null ? "target-unreadable" : "same-keys" };
}

// ───────────────────────────── the report ─────────────────────────────

export type ReportState = "match" | "differences" | "incomplete";

export interface VerificationReport {
  runId: string;
  at: string;
  state: ReportState;
  counts: { checked: number; same: number; similar: number; differs: number; unknown: number };
  pages: PageRow[];
  databases: DbRow[];
  volumes: VolumeRow[];
  env: EnvRow[];
  /** The target address pages were fetched from (an IP) is never shown; `previewHosts` are the names the owner can open on the target. */
  previewHosts: string[];
}

/** `match` only when every row is same or similar; any difference wins over a gap; no rows at all is `incomplete`. */
export function summarize(rows: ReadonlyArray<{ verdict: Verdict }>): { state: ReportState; counts: VerificationReport["counts"] } {
  const counts = { checked: rows.length, same: 0, similar: 0, differs: 0, unknown: 0 };
  for (const r of rows) counts[r.verdict]++;
  const state: ReportState = rows.length === 0 ? "incomplete" : counts.differs > 0 ? "differences" : counts.unknown > 0 ? "incomplete" : "match";
  return { state, counts };
}
