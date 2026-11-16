import { createHash, X509Certificate, createPrivateKey } from "node:crypto";

/**
 * Pure logic of the SSL/DNS cutover (no I/O): the per-hostname state machine, the DNS record planner with its
 * rollback ledger, the confirm-token hash, probe classification, TTL math, marker parsers and the acme.json
 * merge. Everything stateful (Prisma, Cloudflare, probes) lives in cutover.service.ts and calls into here.
 */

// ── state machine ────────────────────────────────────────────────────────────────────────────

export type CutoverState =
  | "PLANNED" | "CERT_PENDING" | "CERT_READY" | "READY" | "SWITCHING" | "SWITCHED" | "VERIFIED" | "VERIFY_FAILED"
  | "REVERTING" | "ROLLED_BACK" | "BLOCKED" | "EXCLUDED" | "CONFLICT";

export const CUTOVER_STATES: readonly CutoverState[] = [
  "PLANNED", "CERT_PENDING", "CERT_READY", "READY", "SWITCHING", "SWITCHED", "VERIFIED", "VERIFY_FAILED",
  "REVERTING", "ROLLED_BACK", "BLOCKED", "EXCLUDED", "CONFLICT",
];

const SIDE: CutoverState[] = ["BLOCKED", "EXCLUDED", "CONFLICT"];

const TRANSITIONS: Record<CutoverState, readonly CutoverState[]> = {
  PLANNED: ["CERT_PENDING", "CERT_READY", ...SIDE],
  CERT_PENDING: ["CERT_READY", "PLANNED", ...SIDE],
  CERT_READY: ["READY", "CERT_PENDING", "PLANNED", ...SIDE],
  READY: ["SWITCHING", "CERT_PENDING", "PLANNED", ...SIDE],
  SWITCHING: ["SWITCHED", "READY", "CONFLICT"],
  SWITCHED: ["VERIFIED", "VERIFY_FAILED", "REVERTING"],
  VERIFIED: ["REVERTING"],
  VERIFY_FAILED: ["SWITCHED", "REVERTING"],
  REVERTING: ["ROLLED_BACK", "CONFLICT"],
  ROLLED_BACK: ["PLANNED"],
  BLOCKED: ["PLANNED", "EXCLUDED"],
  EXCLUDED: ["PLANNED"],
  CONFLICT: ["PLANNED", "BLOCKED", "EXCLUDED", "REVERTING"], // REVERTING: a half-applied / drifted flip (its ledger exists) can be rolled back, with force if needed
};

/** Is `from -> to` a legal step? Every service transition is additionally a DB compare-and-set on `from`. */
export function canTransition(from: CutoverState, to: CutoverState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** States whose DNS records may carry our writes (a revert is possible). */
export const REVERTIBLE: readonly CutoverState[] = ["SWITCHED", "VERIFIED", "VERIFY_FAILED"];

// ── hostnames ────────────────────────────────────────────────────────────────────────────────

/** Coolify-generated hostnames (e.g. app-ek8c4gk8s8kwk8go4kwc4skc.sytrase.com): excluded by default. */
export const GENERATED_HOST_RE = /^[a-z0-9-]+-[a-z0-9]{24}\./;
export function isGeneratedHost(host: string): boolean {
  return GENERATED_HOST_RE.test(host.toLowerCase());
}

/** A hostname shape check shared by every request DTO that names hosts (lowercase, no scheme/port/wildcard). */
export const CUTOVER_HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/** The www/bare sibling of a host. With a known Cloudflare zone only the apex (and its www) have one; without a
 *  zone (manual DNS) a 2-label host gets `www.<host>` and a `www.` host gets the bare name. Null = no counterpart. */
export function counterpartOf(host: string, zoneName?: string | null): string | null {
  const h = host.toLowerCase();
  if (zoneName) {
    const z = zoneName.toLowerCase();
    if (h === z) return `www.${z}`;
    if (h === `www.${z}`) return z;
    return null;
  }
  if (h.startsWith("www.")) {
    const rest = h.slice(4);
    return rest.split(".").length >= 2 ? rest : null;
  }
  return h.split(".").length === 2 ? `www.${h}` : null;
}

export type CandidateRole = "primary" | "alias" | "service";
export interface DerivedEntry {
  hostname: string;
  role: CandidateRole;
  blockReason?: string;
  excluded?: boolean;
}

/** Pure: the hostnames of one imported app that Cutover should track. The counterpart is added by the service
 *  (it needs live DNS evidence), not here. A clustered app is BLOCKED; a Coolify-generated host is EXCLUDED. */
export function deriveEntries(app: { domain: string | null; extraDomains: string[]; clusterId: string | null }, serviceHosts: string[]): DerivedEntry[] {
  const seen = new Set<string>();
  const out: DerivedEntry[] = [];
  const push = (raw: string | null | undefined, role: CandidateRole) => {
    const hostname = String(raw ?? "").trim().toLowerCase().replace(/\.$/, "");
    if (!hostname || seen.has(hostname) || !CUTOVER_HOSTNAME_RE.test(hostname)) return;
    seen.add(hostname);
    const e: DerivedEntry = { hostname, role };
    if (app.clusterId) e.blockReason = "cluster-app";
    else if (isGeneratedHost(hostname)) e.excluded = true;
    out.push(e);
  };
  push(app.domain, "primary");
  for (const h of app.extraDomains) push(h, "alias");
  for (const h of serviceHosts) push(h, "service");
  return out;
}

export interface OpTaskLite { itemRef: string | null; kind: string; status: string; dependsOn: string[]; result?: unknown }

/**
 * How many volumes of an imported compose SERVICE carry data to the target (a volume whose policy is `skip` is created empty
 * by design). Read from the task result the importer stored; 0 for anything else. A service has no `dependsOn` rows, so this
 * is what makes a MinIO / Meilisearch service count as stateful.
 */
export function serviceDataVolumes(result: unknown): number {
  const v = result && typeof result === "object" ? (result as { volumes?: unknown }).volumes : undefined;
  if (!Array.isArray(v)) return 0;
  return v.filter((x) => x && typeof x === "object" && (x as { policy?: unknown }).policy !== "skip").length;
}

/** Pure: an app is `stateful` when it depends on a database or volume whose DATA task is not DONE. A database's data
 *  arrives either as a dump restore (`data:database:<s>:<r>`) or, for a volume-mode Postgres, as the streamed physical
 *  copy (`data:volume:<s>:<r>:data`); an app volume either via the v1 hub-staged restore (`data:vol:<appRef>:<name>`) or
 *  the streamed copy (`data:volume:<s>:<r>:<name>`, appRef = `app:<s>:<r>`). The two lanes are mutually exclusive per
 *  volume/database, so the counts add without double counting. A volume dependency is satisfied only when at least as
 *  many DONE volume data tasks exist as volume dependencies. */
export function isStateful(appItemRef: string | null, tasks: OpTaskLite[]): boolean {
  const app = tasks.find((t) => t.itemRef === appItemRef && (t.kind === "app" || t.kind === "service"));
  if (!app) return false;
  if (app.kind === "service") {
    // A compose service: its data volumes arrive as streamed copies `data:volume:<s>:<r>:<key>` (the service ref is `service:<s>:<r>`).
    const want = serviceDataVolumes(app.result);
    if (want === 0) return false;
    const prefix = `data:${String(appItemRef ?? "").replace(/^service:/, "volume:")}:`;
    const done = tasks.filter((t) => t.kind === "data" && t.status === "DONE" && (t.itemRef ?? "").startsWith(prefix)).length;
    return done < want;
  }
  const deps = app.dependsOn ?? [];
  const dbDeps = deps.filter((d) => d.startsWith("database:"));
  const volDeps = deps.filter((d) => d.startsWith("volume:"));
  const dataDone = (ref: string) => tasks.some((t) => t.kind === "data" && t.status === "DONE" && t.itemRef === ref);
  for (const d of dbDeps) if (!dataDone(`data:${d}`) && !dataDone(`data:${d.replace(/^database:/, "volume:")}:data`)) return true;
  if (volDeps.length > 0) {
    const v1Prefix = `data:vol:${appItemRef}:`;
    const vxPrefix = `data:${String(appItemRef ?? "").replace(/^app:/, "volume:")}:`;
    const doneVols = tasks.filter((t) => t.kind === "data" && t.status === "DONE" && ((t.itemRef ?? "").startsWith(v1Prefix) || (t.itemRef ?? "").startsWith(vxPrefix))).length;
    if (doneVols < volDeps.length) return true;
  }
  return false;
}

// ── DNS record planning + ledger ─────────────────────────────────────────────────────────────

export interface RecVal { content: string; ttl: number; proxied: boolean }
export interface ProviderRec { id: string; type: string; name: string; content: string; ttl: number; proxied: boolean }
export interface TargetIps { v4: string[]; v6: string[] }
export interface LedgerRecord {
  type: "A" | "AAAA" | "CNAME";
  name: string;
  recordId: string | null; // null => did not exist before (revert = delete)
  old: RecVal | null;
  new: RecVal | null; // null => planned delete (stale AAAA / replaced CNAME / surplus A)
  written: boolean;
  writtenAt?: string;
}
export type StepAction = "create" | "update" | "delete" | "noop";

export function stepAction(s: Pick<LedgerRecord, "old" | "new">): StepAction {
  if (!s.old && s.new) return "create";
  if (s.old && !s.new) return "delete";
  if (s.old && s.new) return s.old.content === s.new.content && s.old.ttl === s.new.ttl && s.old.proxied === s.new.proxied ? "noop" : "update";
  return "noop";
}

export const CF_AUTO_TTL = 1;
/** Cloudflare TTL=1 means "auto"; for wait math it is treated as 300 s. */
export function effectiveTtl(ttl: number | null | undefined): number {
  if (!ttl || ttl <= 1) return 300;
  return ttl;
}

export interface PlanRecordsResult {
  steps: LedgerRecord[];
  warnings: string[];
  blocked: string | null; // machine reason when nothing may be planned (tunnel-routed, no-target-ip)
}

/**
 * Pure: turn the provider's current records at ONE hostname into the ordered ledger steps that point it at the
 * target IPs. Never touches non-A/AAAA/CNAME records (TXT/MX/CAA/NS), keeps the `proxied` flag (orange stays
 * orange unless `keepProxied` is false), updates same-name A records in place (keeping the record id), deletes a
 * stale AAAA when the target has no IPv6 and any surplus A, replaces a CNAME with A records, and creates an
 * explicit record for a wildcard-only host. `before` must hold every record at the exact name.
 */
export function planRecords(
  before: ProviderRec[],
  target: TargetIps,
  opts: { hostname: string; targetTtl: number; keepProxied: boolean; viaWildcard: boolean },
): PlanRecordsResult {
  const warnings: string[] = [];
  const name = opts.hostname;
  const at = before.filter((r) => r.name.toLowerCase() === name.toLowerCase() && (r.type === "A" || r.type === "AAAA" || r.type === "CNAME"));
  if (at.some((r) => r.type === "CNAME" && /\.cfargotunnel\.com\.?$/i.test(r.content))) return { steps: [], warnings, blocked: "tunnel-routed" };
  if (target.v4.length === 0) return { steps: [], warnings, blocked: "no-target-ip" };

  const steps: LedgerRecord[] = [];
  const cnames = at.filter((r) => r.type === "CNAME");
  const as = at.filter((r) => r.type === "A");
  const aaaas = at.filter((r) => r.type === "AAAA");
  const proxiedBefore = at.some((r) => r.proxied);
  const proxiedNew = opts.keepProxied ? proxiedBefore : false;
  const newTtl = proxiedNew ? CF_AUTO_TTL : opts.targetTtl;
  const val = (content: string): RecVal => ({ content, ttl: newTtl, proxied: proxiedNew });
  const oldVal = (r: ProviderRec): RecVal => ({ content: r.content, ttl: r.ttl, proxied: r.proxied });

  // A CNAME cannot coexist with A/AAAA: remove it first, then create the A set.
  for (const c of cnames) {
    steps.push({ type: "CNAME", name, recordId: c.id, old: oldVal(c), new: null, written: false });
    warnings.push("cname-replaced");
  }
  if (as.length === 0 && aaaas.length === 0 && cnames.length === 0 && opts.viaWildcard) warnings.push("wildcard-explicit-record");

  const reconcile = (type: "A" | "AAAA", existing: ProviderRec[], wanted: string[]) => {
    const sorted = [...existing].sort((x, y) => x.id.localeCompare(y.id));
    const matched = new Set<string>();
    const todo: string[] = [];
    for (const ip of wanted) {
      const m = sorted.find((e) => !matched.has(e.id) && e.content === ip);
      if (m) {
        matched.add(m.id);
        steps.push({ type, name, recordId: m.id, old: oldVal(m), new: val(ip), written: false });
      } else todo.push(ip);
    }
    const spare = sorted.filter((e) => !matched.has(e.id));
    for (const ip of todo) {
      const e = spare.shift();
      if (e) steps.push({ type, name, recordId: e.id, old: oldVal(e), new: val(ip), written: false });
      else steps.push({ type, name, recordId: null, old: null, new: val(ip), written: false });
    }
    for (const e of spare) steps.push({ type, name, recordId: e.id, old: oldVal(e), new: null, written: false });
    return spare.length;
  };

  const surplusA = reconcile("A", as, target.v4);
  if (surplusA > 0) warnings.push("surplus-a-deleted");
  if (target.v6.length > 0) reconcile("AAAA", aaaas, target.v6);
  else if (aaaas.length > 0) {
    for (const e of aaaas) steps.push({ type: "AAAA", name, recordId: e.id, old: oldVal(e), new: null, written: false });
    warnings.push("stale-aaaa-deleted");
  }
  if (proxiedBefore && opts.keepProxied) warnings.push("proxied-kept");
  if (proxiedBefore && !opts.keepProxied) warnings.push("proxied-dropped");
  return { steps, warnings: [...new Set(warnings)], blocked: null };
}

/** True when applying the steps changes nothing (every step is a noop). */
export function allNoop(steps: LedgerRecord[]): boolean {
  return steps.every((s) => stepAction(s) === "noop");
}

/** Pure model of the provider: the exact-name record set after applying the ledger steps to `before`. Records the
 *  steps create get the id `new-<step index>`. Used by the planner round-trip property test. */
export function simulateApply(before: ProviderRec[], steps: LedgerRecord[]): ProviderRec[] {
  const out = new Map(before.map((r) => [r.id, { ...r }]));
  steps.forEach((s, i) => {
    const a = stepAction(s);
    if (a === "noop") return;
    if (a === "delete") out.delete(s.recordId!);
    else if (a === "update") out.set(s.recordId!, { id: s.recordId!, type: s.type, name: s.name, ...s.new! });
    else out.set(`new-${i}`, { id: `new-${i}`, type: s.type, name: s.name, ...s.new! });
  });
  return [...out.values()];
}

/** Pure model of the revert: undo the steps in reverse order against the applied record set. */
export function simulateRevert(after: ProviderRec[], steps: LedgerRecord[]): ProviderRec[] {
  const out = new Map(after.map((r) => [r.id, { ...r }]));
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    const a = stepAction(s);
    if (a === "noop") continue;
    if (a === "create") out.delete(`new-${i}`);
    else out.set(s.recordId!, { id: s.recordId!, type: s.type, name: s.name, ...s.old! });
  }
  return [...out.values()];
}

/** Records compared by content only (ids differ for recreated records): a stable sorted fingerprint. */
export function recordSetKey(recs: Array<Pick<ProviderRec, "type" | "name" | "content" | "ttl" | "proxied">>): string {
  return JSON.stringify(recs.map((r) => [r.type, r.name.toLowerCase(), r.content, r.ttl, r.proxied]).sort());
}

// ── confirm token ────────────────────────────────────────────────────────────────────────────

export interface PlanHashEntry {
  id: string;
  hostname: string;
  steps: LedgerRecord[];
}

/** The flip confirmToken: sha256 over the op, the pacing inputs and, per READY entry (sorted by id), every
 *  record's id / old / new / action. It includes each record's OLD content so a provider-side change since the
 *  review aborts the flip, not only a state change. */
export function planHash(opId: string, params: { targetTtl: number; keepProxied: boolean }, entries: PlanHashEntry[]): string {
  const body = {
    opId,
    targetTtl: params.targetTtl,
    keepProxied: params.keepProxied,
    entries: [...entries]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((e) => ({
        id: e.id,
        hostname: e.hostname,
        state: "READY",
        records: e.steps.map((s) => [s.type, s.name, s.recordId, s.old?.content ?? null, s.old?.ttl ?? null, s.old?.proxied ?? null, s.new?.content ?? null, s.new?.ttl ?? null, s.new?.proxied ?? null, stepAction(s)]),
      })),
  };
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

// ── probes: classification + markers ─────────────────────────────────────────────────────────

export interface HealthClass { pass: boolean; kind: "ok" | "redirect" | "auth" | "app-404" | "traefik-404" | "server-error" | "unreachable" | "other"; warn?: boolean }

/** Pure: how a status from the target proxy (Host header + SNI, no redirect following) counts for readiness. */
export function classifyHealth(status: number | null, traefik404: boolean): HealthClass {
  if (status === null) return { pass: false, kind: "unreachable" };
  if (status === 404) return traefik404 ? { pass: false, kind: "traefik-404" } : { pass: true, kind: "app-404", warn: true };
  if (status >= 200 && status < 300) return { pass: true, kind: "ok" };
  if (status >= 300 && status < 400) return { pass: true, kind: "redirect" };
  if (status === 401 || status === 403) return { pass: true, kind: "auth" };
  if (status >= 500) return { pass: false, kind: "server-error" };
  return { pass: false, kind: "other" };
}

/**
 * Source health baseline (R52) on a two-box host: `SOURCE_DEGRADED` marks a host whose app was already failing at the source (set by the
 * guided run; never shown), `HEALTH_PRE_EXISTING` records that this host's health failure was excused because of it (shown as a warning).
 */
export const SOURCE_DEGRADED_TAG = "source-degraded";
export const HEALTH_PRE_EXISTING_TAG = "health-pre-existing";

/** Only a failure of the APP's answer can be excused by the source baseline; a missing router (traefik-404) or no answer at all cannot. */
export const isExcusableHealth = (kind: string | null | undefined): boolean => kind === "server-error" || kind === "other";

export type DnsObserved = "source" | "target" | "mixed" | "proxied" | "tunnel" | "unknown";

/** Pure: where a hostname resolves today relative to the Tugra target. `proxied`/`tunnel` win (public DNS then shows
 *  Cloudflare edge addresses, so the answer says nothing about the origin). */
export function classifyObserved(addrs: string[], target: TargetIps, ctx: { proxied: boolean; tunnel: boolean }): DnsObserved {
  if (ctx.tunnel) return "tunnel";
  if (ctx.proxied) return "proxied";
  if (addrs.length === 0) return "unknown";
  const t = new Set([...target.v4, ...target.v6]);
  const hit = addrs.filter((a) => t.has(a)).length;
  if (hit === addrs.length) return "target";
  return hit === 0 ? "source" : "mixed";
}

/** Pure: does a CAA record set permit Let's Encrypt to issue? No `issue` tag at all = anyone may issue. */
export function caaAllowsLetsEncrypt(caaValues: string[]): boolean {
  const issuers = caaValues
    .map((v) => /^\s*\d+\s+(issue|issuewild)\s+"?([^";\s]*)/i.exec(v))
    .filter((m): m is RegExpExecArray => !!m && m[1].toLowerCase() === "issue")
    .map((m) => m[2].toLowerCase());
  if (issuers.length === 0) return true;
  return issuers.includes("letsencrypt.org");
}

/** Port 80 should answer with a permanent redirect to https. */
export function classifyPort80(status: number | null, location: string | null): boolean {
  return (status === 301 || status === 308 || status === 302 || status === 307) && !!location && /^https:\/\//i.test(location);
}

export const PROBE_PATH_RE = /^\/[\x21-\x7e]{0,200}$/;

/** SSL mode of a Cloudflare zone vs what an origin with a valid certificate needs. */
export function sslModeVerdict(mode: string | null | undefined): "ok" | "weak" | "bad" | "unknown" {
  if (mode === "strict") return "ok";
  if (mode === "full") return "weak";
  if (mode === "flexible" || mode === "off") return "bad";
  return "unknown";
}

const PROBE_MARKER_RE = /^TUGRA_CUTOVER_PROBE status=(\d{3})$/;
export function parseCutoverProbeMarkers(out: string): { status: number | null } | null {
  for (const line of out.split(/\r?\n/)) {
    const m = PROBE_MARKER_RE.exec(line);
    if (m) {
      const n = Number(m[1]);
      return { status: n === 0 ? null : n };
    }
  }
  return null;
}

const ACME_HAS_RE = /^TUGRA_ACME_HAS host=([a-z0-9.-]{1,253}) n=(\d{1,4})$/;
const ACME_ERR_RE = /^TUGRA_ACME_ERR=([\x20-\x7e]{0,400})$/;
export function parseAcmeDiagMarkers(out: string): { has: number | null; err: string | null } {
  let has: number | null = null;
  let err: string | null = null;
  for (const line of out.split(/\r?\n/)) {
    const h = ACME_HAS_RE.exec(line);
    if (h) has = Number(h[2]);
    const e = ACME_ERR_RE.exec(line);
    if (e && e[1]) err = e[1];
  }
  return { has, err };
}

/** Printable ASCII only, capped — the form every provider/agent string takes before it is stored or shown. */
export function sanitizeText(s: unknown, max = 400): string {
  return String(s ?? "").replace(/[^\x20-\x7e]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

// ── TTL guidance ─────────────────────────────────────────────────────────────────────────────

export const MIN_TTL = 60;
export interface TtlGuidance {
  oldTtl: number; // effective seconds (auto = 300)
  lowerBefore: Date; // lower the TTL at the latest here to be safe for plannedFlipAt
  waitSeconds: number;
  floor: number;
}

/** Pure: when to lower the TTL so every resolver cache has expired by the flip. `lowerBefore = flip - oldTtl - 10min`. */
export function ttlGuidance(oldTtlRaw: number | null | undefined, plannedFlipAt: Date): TtlGuidance {
  const oldTtl = effectiveTtl(oldTtlRaw);
  return { oldTtl, lowerBefore: new Date(plannedFlipAt.getTime() - (oldTtl + 600) * 1000), waitSeconds: oldTtl, floor: MIN_TTL };
}

/** earliestFlipAt for a Cloudflare record whose TTL was lowered at `loweredAt` from `originalTtl`. */
export function earliestFlip(loweredAt: Date, originalTtl: number | null | undefined, proxied: boolean): Date {
  return proxied ? loweredAt : new Date(loweredAt.getTime() + effectiveTtl(originalTtl) * 1000);
}

// ── acme.json merge (seeding) ────────────────────────────────────────────────────────────────

export interface SeedCert { main: string; sans?: string[]; certPem: string; keyPem: string }
export interface AcmeStoreCert { domain: { main: string; sans?: string[] }; certificate: string; key: string; Store?: string; [k: string]: unknown }
export const MIN_SEED_DAYS = 14;

export function pemNotAfter(certPem: string): Date | null {
  try {
    return new Date(new X509Certificate(certPem).validTo);
  } catch {
    return null;
  }
}

/**
 * Pure: merge seeded certs into Traefik's own acme.json for resolver `resolver` ("le"). The target's resolver
 * object is kept untouched (its Account and any unknown keys) — a missing Account is NOT created, so Traefik
 * registers its own. Seeded certs are appended with Store "default"; a duplicate `main` keeps the later
 * notAfter; certs with < 14 days left are skipped. Throws on a corrupt existing file (never overwrite what we
 * cannot parse).
 */
export function mergeAcmeStore(existing: string | null, seeds: SeedCert[], resolver: string, now: Date = new Date()): { json: string; added: number; skipped: Array<{ main: string; reason: "short-lived" | "older-than-existing" | "malformed" }> } {
  let root: Record<string, Record<string, unknown>> = {};
  if (existing && existing.trim() !== "") {
    const parsed = JSON.parse(existing) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("acme.json is not an object");
    root = parsed as Record<string, Record<string, unknown>>;
  }
  const res = (root[resolver] && typeof root[resolver] === "object" ? root[resolver] : {}) as Record<string, unknown>;
  const certs: AcmeStoreCert[] = Array.isArray(res.Certificates) ? [...(res.Certificates as AcmeStoreCert[])] : [];
  const skipped: Array<{ main: string; reason: "short-lived" | "older-than-existing" | "malformed" }> = [];
  let added = 0;
  const notAfterOf = (c: AcmeStoreCert): Date | null => {
    try {
      return pemNotAfter(Buffer.from(c.certificate, "base64").toString("utf8"));
    } catch {
      return null;
    }
  };
  for (const s of seeds) {
    const na = pemNotAfter(s.certPem);
    if (!na) {
      skipped.push({ main: s.main, reason: "malformed" });
      continue;
    }
    if (na.getTime() - now.getTime() < MIN_SEED_DAYS * 86_400_000) {
      skipped.push({ main: s.main, reason: "short-lived" });
      continue;
    }
    const idx = certs.findIndex((c) => c?.domain?.main === s.main);
    if (idx >= 0) {
      const ex = notAfterOf(certs[idx]);
      if (ex && ex.getTime() >= na.getTime()) {
        skipped.push({ main: s.main, reason: "older-than-existing" });
        continue;
      }
      certs.splice(idx, 1);
    }
    certs.push({
      domain: { main: s.main, ...(s.sans && s.sans.length ? { sans: s.sans } : {}) },
      certificate: Buffer.from(s.certPem, "utf8").toString("base64"),
      key: Buffer.from(s.keyPem, "utf8").toString("base64"),
      Store: "default",
    });
    added++;
  }
  root[resolver] = { ...res, Certificates: certs };
  return { json: JSON.stringify(root), added, skipped };
}

/** True when `keyPem` is the private key of `certPem` (node:crypto only; never throws). */
export function keyMatchesCert(certPem: string, keyPem: string): boolean {
  try {
    return new X509Certificate(certPem).checkPrivateKey(createPrivateKey(keyPem));
  } catch {
    return false;
  }
}

/** The DNS names a certificate covers (CN + SANs, lowercase, wildcard kept). */
export function certNames(certPem: string): string[] {
  try {
    const x = new X509Certificate(certPem);
    const names = new Set<string>();
    for (const part of (x.subjectAltName ?? "").split(",")) {
      const m = /DNS:([^\s,]+)/.exec(part.trim());
      if (m) names.add(m[1].toLowerCase());
    }
    const cn = /CN=([^\n,]+)/.exec(x.subject);
    if (cn && names.size === 0) names.add(cn[1].trim().toLowerCase());
    return [...names];
  } catch {
    return [];
  }
}
