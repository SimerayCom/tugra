/**
 * Parsers for the marker lines the object-migration scripts print. STRICT by design: a marker the script should have
 * printed but did not (a missing `*_END`, an unparsable value) is reported as such so the caller fails CLOSED. mc text is
 * never trusted: it arrives base64-wrapped (`TUGRA_OBJ_OUT <name> <b64>`) and is only ever read with strict JSON.parse
 * per line, never interpolated anywhere.
 */

const lines = (output: string): string[] => (output ?? "").split(/\r?\n/);

/** True when the exact marker line is present (whole-line match, so a base64 payload can never fake one). */
export function hasMarker(output: string, marker: string): boolean {
  return lines(output).some((l) => l.trim() === marker);
}

const B64 = /^[A-Za-z0-9+/]*={0,2}$/;
const OUT_NAME = /^[A-Za-z0-9._-]{1,200}$/;

/** Decode every `TUGRA_OBJ_OUT <name> <b64>` line into name -> text. Garbage (bad base64, bad name) is skipped, never thrown. */
export function decodeOutputs(output: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const l of lines(output)) {
    const mm = /^TUGRA_OBJ_OUT (\S+)(?: (\S*))?$/.exec(l.trim());
    if (!mm || !OUT_NAME.test(mm[1])) continue;
    const b64 = mm[2] ?? "";
    if (!B64.test(b64) || b64.length % 4 !== 0) continue;
    try {
      m.set(mm[1], Buffer.from(b64, "base64").toString("utf8"));
    } catch {
      /* skip */
    }
  }
  return m;
}

/** Strict JSON-lines: each non-empty line that parses as a JSON object. Everything else is ignored. */
export function jsonLines(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const l of (text ?? "").split(/\r?\n/)) {
    const t = l.trim();
    if (!t.startsWith("{")) continue;
    try {
      const j: unknown = JSON.parse(t);
      if (j && typeof j === "object" && !Array.isArray(j)) out.push(j as Record<string, unknown>);
    } catch {
      /* not JSON */
    }
  }
  return out;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/** An S3 bucket name as the DTO accepts it (so a hostile/odd listing entry never becomes a bucket row). */
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

/** Bucket names from `mc ls --json <alias>` (folder entries with a trailing "/"). */
export function parseLsBuckets(text: string): string[] {
  const names: string[] = [];
  for (const j of jsonLines(text)) {
    if (j.status !== "success" || typeof j.key !== "string") continue;
    const name = j.key.replace(/\/+$/, "");
    if (BUCKET.test(name)) names.push(name);
  }
  return [...new Set(names)].sort();
}

/** `mc du --json <alias/bucket>` => { objects, bytes } | null (null = missing/unparsable/timed out: size unknown, never 0). */
export function parseDu(text: string): { objects: number; bytes: number } | null {
  for (const j of jsonLines(text)) {
    if (j.status !== "success") continue;
    const bytes = num(j.size) ?? num(j.totalSize);
    const objects = num(j.objects) ?? num(j.totalObjects);
    if (bytes !== null && objects !== null) return { objects, bytes };
  }
  return null;
}

/** Informational versioning state from `mc version info`: "enabled" | "suspended" | "unversioned" | null (unknown). */
export function parseVersioning(text: string): "enabled" | "suspended" | "unversioned" | null {
  for (const j of jsonLines(text)) {
    const v = (j.versioning as { status?: unknown } | undefined)?.status;
    if (typeof v === "string") {
      const s = v.toLowerCase();
      return s === "enabled" ? "enabled" : s === "suspended" ? "suspended" : "unversioned";
    }
  }
  const t = (text ?? "").toLowerCase();
  if (/\bunversioned\b/.test(t)) return "unversioned";
  if (/\bsuspended\b/.test(t)) return "suspended";
  if (/\benabled\b/.test(t)) return "enabled";
  return null;
}

export const CONFIG_DOC_MAX = 64 * 1024;

export interface ExportedConfig {
  policy?: string; // validated JSON text
  lifecycle?: string; // validated JSON text
  tags?: Array<[string, string]>;
}

const TAG_RE = /^[A-Za-z0-9._:/@+ -]{1,128}$/;

function jsonDoc(text: string | undefined): string | undefined {
  const t = (text ?? "").trim();
  if (!t || Buffer.byteLength(t, "utf8") > CONFIG_DOC_MAX) return undefined;
  try {
    const j: unknown = JSON.parse(t);
    return j && typeof j === "object" ? t : undefined;
  } catch {
    return undefined;
  }
}

/** Parse the read-only config export of one bucket. A policy with no statements and an empty lifecycle count as absent. */
export function parseExportedConfig(policy: string | undefined, ilm: string | undefined, tags: string | undefined): ExportedConfig {
  const out: ExportedConfig = {};
  const p = jsonDoc(policy);
  if (p) {
    const stmts = (JSON.parse(p) as { Statement?: unknown }).Statement;
    if (!(Array.isArray(stmts) && stmts.length === 0)) out.policy = p;
  }
  const l = jsonDoc(ilm);
  if (l) {
    const rules = (JSON.parse(l) as { Rules?: unknown }).Rules;
    if (!(Array.isArray(rules) && rules.length === 0)) out.lifecycle = l;
  }
  for (const j of jsonLines(tags ?? "")) {
    const set = (j.tagset ?? j.tags) as Record<string, unknown> | undefined;
    if (!set || typeof set !== "object") continue;
    const pairs: Array<[string, string]> = [];
    for (const [k, v] of Object.entries(set)) if (typeof v === "string" && TAG_RE.test(k) && TAG_RE.test(v)) pairs.push([k, v]);
    if (pairs.length) out.tags = pairs.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }
  return out;
}

export interface ProbeResult {
  /** The `TUGRA_OBJ_PROBE_END` marker was seen: the output is complete. Absent => treat as truncated (fail closed). */
  complete: boolean;
  /** Marker `TUGRA_OBJ_PROBE v1` seen. */
  protocol: boolean;
  noAgentImage: boolean;
  tool: { present: boolean; version?: string } | null;
  reach: { src?: { ok: boolean; ms: number }; dst?: { ok: boolean; ms: number } };
  srcBuckets: string[];
  dstBuckets: string[];
  dfAvailKb: number | null;
}

export function parseProbe(output: string): ProbeResult {
  const r: ProbeResult = { complete: hasMarker(output, "TUGRA_OBJ_PROBE_END"), protocol: hasMarker(output, "TUGRA_OBJ_PROBE v1"), noAgentImage: false, tool: null, reach: {}, srcBuckets: [], dstBuckets: [], dfAvailKb: null };
  for (const l of lines(output)) {
    const t = l.trim();
    if (t === "TUGRA_OBJ_ERR no-agent-image") r.noAgentImage = true;
    let m = /^TUGRA_OBJ_TOOL mc ([01]) (\S+)$/.exec(t);
    if (m) r.tool = m[1] === "1" ? { present: true, version: m[2] } : { present: false };
    m = /^TUGRA_OBJ_REACH (src|dst) (ok|fail) (-?\d+)$/.exec(t);
    if (m) r.reach[m[1] as "src" | "dst"] = { ok: m[2] === "ok", ms: Math.max(0, Number(m[3])) };
    m = /^TUGRA_OBJ_DF (\d+)$/.exec(t);
    if (m) r.dfAvailKb = Number(m[1]);
  }
  const outs = decodeOutputs(output);
  r.srcBuckets = parseLsBuckets(outs.get("ls_src") ?? "");
  r.dstBuckets = parseLsBuckets(outs.get("ls_dst") ?? "");
  return r;
}

export interface DuBucketResult {
  src: { objects: number; bytes: number } | null;
  dst: { objects: number; bytes: number } | null;
  versioning: "enabled" | "suspended" | "unversioned" | null;
  config: ExportedConfig;
}

/** Per-bucket results of a du script, keyed by SOURCE bucket. Only buckets whose `TUGRA_OBJ_DU_BUCKET` marker was seen
 *  are returned (a bucket the script never reached is absent, so the caller leaves its sizes unknown). */
export function parseDuOutput(output: string): Map<string, DuBucketResult> {
  const outs = decodeOutputs(output);
  const res = new Map<string, DuBucketResult>();
  for (const l of lines(output)) {
    const m = /^TUGRA_OBJ_DU_BUCKET (\S+)$/.exec(l.trim());
    if (!m || !BUCKET.test(m[1])) continue;
    const b = m[1];
    res.set(b, {
      src: parseDu(outs.get(`du_src_${b}`) ?? ""),
      dst: parseDu(outs.get(`du_dst_${b}`) ?? ""),
      versioning: parseVersioning(outs.get(`ver_${b}`) ?? ""),
      config: parseExportedConfig(outs.get(`cfg_policy_${b}`), outs.get(`cfg_ilm_${b}`), outs.get(`cfg_tags_${b}`)),
    });
  }
  return res;
}

/** idx -> container id prefix for every `TUGRA_OBJ_STARTED`, plus the idxs that reported `run-failed`. */
export function parseStarted(output: string): { started: Map<number, string>; failed: Set<number>; complete: boolean; noAgentImage: boolean } {
  const started = new Map<number, string>();
  const failed = new Set<number>();
  let noAgentImage = false;
  for (const l of lines(output)) {
    const t = l.trim();
    let m = /^TUGRA_OBJ_STARTED (\d+) ([0-9a-f]{1,64})$/.exec(t);
    if (m) started.set(Number(m[1]), m[2]);
    m = /^TUGRA_OBJ_ERR (\d+) run-failed$/.exec(t);
    if (m) failed.add(Number(m[1]));
    if (t === "TUGRA_OBJ_ERR no-agent-image") noAgentImage = true;
  }
  return { started, failed, complete: hasMarker(output, "TUGRA_OBJ_START_END"), noAgentImage };
}

export type HelperState = "running" | "exited" | "absent" | "created" | "paused" | "restarting" | "dead" | "removing" | "unknown";

export interface HelperStatus {
  state: HelperState;
  exitCode: number | null;
  errors: number | null;
  doneObjects: number | null;
  doneBytes: number | null;
  /** The last raw mc line, decoded (used ONLY for error classification; never stored). */
  last: string;
}

const STATES = new Set<string>(["running", "exited", "absent", "created", "paused", "restarting", "dead", "removing"]);

/** Per-idx helper status. Returns null when the END marker is missing (the whole output is untrusted: fail closed). */
export function parseStatus(output: string): Map<number, HelperStatus> | null {
  if (!hasMarker(output, "TUGRA_OBJ_STATUS_END")) return null;
  const outs = decodeOutputs(output);
  const res = new Map<number, HelperStatus>();
  const get = (i: number): HelperStatus => {
    let s = res.get(i);
    if (!s) {
      s = { state: "unknown", exitCode: null, errors: null, doneObjects: null, doneBytes: null, last: "" };
      res.set(i, s);
    }
    return s;
  };
  for (const l of lines(output)) {
    const t = l.trim();
    let m = /^TUGRA_OBJ_STATE (\d+) (\S+) (-?\d+)$/.exec(t);
    if (m) {
      const s = get(Number(m[1]));
      s.state = STATES.has(m[2]) ? (m[2] as HelperState) : "unknown";
      s.exitCode = Number(m[3]);
      continue;
    }
    m = /^TUGRA_OBJ_ERRS (\d+) (\d+)$/.exec(t);
    if (m) {
      get(Number(m[1])).errors = Number(m[2]);
      continue;
    }
    m = /^TUGRA_OBJ_PROG (\d+) (\d+) (\d+)$/.exec(t);
    if (m) {
      const s = get(Number(m[1]));
      s.doneObjects = Number(m[2]);
      s.doneBytes = Number(m[3]);
    }
  }
  for (const [i, s] of res) s.last = outs.get(`last_${i}`) ?? "";
  return res;
}

/**
 * A FIXED classification of a failed mirror (never mc's text: it carries object keys, which are customer data). The code
 * set is closed; anything unrecognised is `mirror-failed`.
 */
export type ObjErrorCode = "access-denied" | "no-such-bucket" | "unreachable" | "signature" | "quota" | "timeout" | "run-failed" | "mirror-failed" | "mirror-errors" | "helper-missing" | "agent-offline";

export function classifyMirrorError(text: string): ObjErrorCode {
  const t = (text ?? "").toLowerCase();
  if (/access ?denied|forbidden|not authorized|invalidaccesskeyid/.test(t)) return "access-denied";
  if (/signaturedoesnotmatch|signature we calculated/.test(t)) return "signature";
  if (/nosuchbucket|bucket does not exist|specified bucket/.test(t)) return "no-such-bucket";
  if (/connection refused|no such host|dial tcp|i\/o timeout|network is unreachable|eof|tls:|x509/.test(t)) return "unreachable";
  if (/quota|no space left|insufficient/.test(t)) return "quota";
  if (/timeout|deadline exceeded/.test(t)) return "timeout";
  return "mirror-failed";
}

export interface DiffCounts {
  bucket: string;
  missing: number;
  differ: number;
  extra: number;
  errors: number;
  rc: number;
}

/** `TUGRA_OBJ_DIFF <bucket> <missing> <differ> <extra> <errors> <rc>` per bucket; complete only with the END marker. */
export function parseDiff(output: string): { rows: Map<string, DiffCounts>; complete: boolean; du: Map<string, { src: ReturnType<typeof parseDu>; dst: ReturnType<typeof parseDu> }> } {
  const rows = new Map<string, DiffCounts>();
  for (const l of lines(output)) {
    const m = /^TUGRA_OBJ_DIFF (\S+) (\d+) (\d+) (\d+) (\d+) (\d+)$/.exec(l.trim());
    if (m && BUCKET.test(m[1])) rows.set(m[1], { bucket: m[1], missing: Number(m[2]), differ: Number(m[3]), extra: Number(m[4]), errors: Number(m[5]), rc: Number(m[6]) });
  }
  const outs = decodeOutputs(output);
  const du = new Map<string, { src: ReturnType<typeof parseDu>; dst: ReturnType<typeof parseDu> }>();
  for (const b of rows.keys()) du.set(b, { src: parseDu(outs.get(`du_src_${b}`) ?? ""), dst: parseDu(outs.get(`du_dst_${b}`) ?? "") });
  return { rows, complete: hasMarker(output, "TUGRA_OBJ_DIFF_END"), du };
}

/** `TUGRA_OBJ_CFG <bucket> <policy|ilm|tag> <ok|fail>`; complete only with the END marker. */
export function parseCfgResults(output: string): { results: Array<{ bucket: string; kind: "policy" | "ilm" | "tag"; ok: boolean }>; complete: boolean } {
  const results: Array<{ bucket: string; kind: "policy" | "ilm" | "tag"; ok: boolean }> = [];
  for (const l of lines(output)) {
    const m = /^TUGRA_OBJ_CFG (\S+) (policy|ilm|tag) (ok|fail)$/.exec(l.trim());
    if (m && BUCKET.test(m[1])) results.push({ bucket: m[1], kind: m[2] as "policy" | "ilm" | "tag", ok: m[3] === "ok" });
  }
  return { results, complete: hasMarker(output, "TUGRA_OBJ_CFG_END") };
}
