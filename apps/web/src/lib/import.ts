import type { ImportPlan, ImportPlanItem, ImportRisk, ImportRiskLevel, ImportOperation, ImportCoverageApp, ImportAck, ImportServiceChoice, ImportServicePreview, ImportServiceVerdict, VolumeTransferView, VxCommands, VxGate } from "./types";

// Pure view helpers for the import wizard. No network, no React — the data shaping the plan-review and
// apply-timeline screens render from (and the only part worth unit-testing).

export function hasBlocker(item: ImportPlanItem): boolean {
  return item.risks.some((r) => r.level === "blocker");
}

export function blockingRisks(item: ImportPlanItem): ImportRisk[] {
  return item.risks.filter((r) => r.level === "blocker");
}

export interface PlanSummary {
  apps: number;
  databases: number;
  volumes: number;
  blockers: number;
  warnings: number;
  runnable: number; // items that will actually be imported (not blocked)
  blocked: number;
}

export function planSummary(plan: ImportPlan): PlanSummary {
  const blocked = plan.items.filter(hasBlocker).length;
  return {
    apps: plan.totals.apps,
    databases: plan.totals.databases,
    volumes: plan.totals.volumes,
    blockers: plan.totals.blockers,
    warnings: plan.warnings.length,
    runnable: plan.items.length - blocked,
    blocked,
  };
}

/** Group plan items by kind for sectioned display (empty arrays kept so the UI can show "0 databases"). */
export function itemsByKind(plan: ImportPlan): Record<ImportPlanItem["kind"], ImportPlanItem[]> {
  const out: Record<ImportPlanItem["kind"], ImportPlanItem[]> = { app: [], database: [], volume: [], service: [] };
  for (const it of plan.items) out[it.kind].push(it);
  return out;
}

/** The verdict a service plan item carries in its `proposed` (the hub puts it there); anything else reads as skipped. */
export function serviceVerdictOf(item: ImportPlanItem): ImportServiceVerdict {
  const v = item.proposed?.verdict;
  return v === "importable" || v === "partial" ? v : "skipped";
}

/** The apply button is enabled only when at least one app (or one importable service stack) will actually be imported. */
export function canApply(plan: ImportPlan): boolean {
  return plan.items.some((it) => (it.kind === "app" && !hasBlocker(it)) || (it.kind === "service" && !hasBlocker(it) && serviceVerdictOf(it) !== "skipped"));
}

/**
 * The `serviceChoices` an apply sends: only entries for service items of THIS plan, with every empty field dropped, so a
 * card the operator never touched sends nothing (the apply then behaves exactly as the plan said). Undefined when empty.
 */
export function serviceChoicesPayload(plan: ImportPlan, choices: Record<string, ImportServiceChoice>): Record<string, ImportServiceChoice> | undefined {
  const refs = new Set(plan.items.filter((i) => i.kind === "service").map((i) => i.itemRef));
  const out: Record<string, ImportServiceChoice> = {};
  for (const [ref, c] of Object.entries(choices)) {
    if (!refs.has(ref)) continue;
    const clean: ImportServiceChoice = {};
    if (c.skip) clean.skip = true;
    if (c.name?.trim()) clean.name = c.name.trim();
    if (c.targetServerId) clean.targetServerId = c.targetServerId;
    if (c.environmentId) clean.environmentId = c.environmentId;
    if (c.serviceDomains) clean.serviceDomains = c.serviceDomains.filter((d) => d.hostname.trim() !== "").map((d) => ({ service: d.service, hostname: d.hostname.trim().toLowerCase(), port: d.port }));
    if (c.hostnameMap && Object.keys(c.hostnameMap).length) clean.hostnameMap = c.hostnameMap;
    if (c.volumes && Object.keys(c.volumes).length) clean.volumes = c.volumes;
    if (c.dropMembers?.length) clean.dropMembers = c.dropMembers;
    if (c.pinImages === false) clean.pinImages = false;
    if (c.pins && Object.keys(c.pins).length) clean.pins = c.pins;
    if (c.privateNetwork === false) clean.privateNetwork = false;
    if (c.hold === false) clean.hold = false;
    if (Object.keys(clean).length) out[ref] = clean;
  }
  return Object.keys(out).length ? out : undefined;
}

/** A service that sits on the source's own host (Coolify names it `localhost`) has no sensible default placement: the
 *  operator must pick its target server explicitly (no silent default). */
export function needsExplicitTarget(card: Pick<ImportServicePreview, "sourceServer" | "verdict">, choice: ImportServiceChoice | undefined): boolean {
  return card.sourceServer === "localhost" && card.verdict !== "skipped" && !choice?.skip && !choice?.targetServerId;
}

/** UI tone token for a risk level (a class/color key, not a display string). */
export function riskTone(level: ImportRiskLevel): "danger" | "warning" | "info" {
  return level === "blocker" ? "danger" : level === "warn" ? "warning" : "info";
}

export interface OpProgress {
  total: number;
  done: number;
  failed: number;
  skipped: number;
  active: number; // pending + running
  pct: number; // 0–100, by terminal/total
  settled: boolean; // the operation has stopped (not RUNNING)
}

export function opProgress(op: ImportOperation): OpProgress {
  const t = op.totals;
  const active = t.running + t.pending;
  const terminal = Math.max(0, t.total - active);
  return {
    total: t.total,
    done: t.done,
    failed: t.failed,
    skipped: t.skipped,
    active,
    pct: t.total > 0 ? Math.round((terminal / t.total) * 100) : 100,
    settled: op.status !== "RUNNING",
  };
}

/** The apps with at least one "not carried over" entry (empty when the plan has no coverage report). */
export function coverageApps(plan: ImportPlan): ImportCoverageApp[] {
  return plan.preflight?.coverage?.apps.filter((a) => a.notCarried.length > 0) ?? [];
}

/** Counts for the coverage badge: apps listed, and entries needing a review (warn) vs plain notes (info). */
export function coverageCounts(plan: ImportPlan): { apps: number; warn: number; info: number } {
  const apps = coverageApps(plan);
  let warn = 0;
  let info = 0;
  for (const a of apps) for (const n of a.notCarried) (n.level === "warn" ? warn++ : info++);
  return { apps: apps.length, warn, info };
}

/** The deferred-read codes: those rows describe what happens when the Coolify plan is APPLIED (labels / Dockerfile text are
 *  read then). The note under the coverage card is only true for a plan that has one. */
const DEFERRED_REASON_CODES = new Set(["custom_labels_deferred", "dockerfile_deferred"]);

export function hasDeferredCoverage(plan: ImportPlan): boolean {
  return coverageApps(plan).some((a) => a.notCarried.some((n) => !!n.reasonCode && DEFERRED_REASON_CODES.has(n.reasonCode)));
}

/** The translated reason of a coverage / apply-timeline entry: `import.reason_<code>` with its params, the hub's English
 *  `reason` for a row with no (or an unknown) code, e.g. one persisted before the codes existed. */
export function reasonText(t: (k: string, v?: Record<string, string | number>) => string, e: { reason: string; reasonCode?: string; reasonParams?: Record<string, string | number> }): string {
  if (!e.reasonCode) return e.reason;
  const key = `import.reason_${e.reasonCode}`;
  const text = t(key, e.reasonParams);
  return text === key ? e.reason : text;
}

// ── strict env (Coolify): ackable blockers ──
/** The two blocker codes an operator may acknowledge ("create the app WITHOUT those variables"). The hub enforces the
 *  same allow-list; `app.env.tokenReadOnly` and every other blocker can never be acknowledged. */
export const ACKABLE_ENV_CODES = ["app.env.unresolved", "app.env.key.invalid"] as const;
export const ENV_TOKEN_READ_ONLY_CODE = "app.env.tokenReadOnly";
/** Agent session without the owner's consent for secret values: allow it (there is no token). Never ackable either. */
export const ENV_CONSENT_REQUIRED_CODE = "app.env.consentRequired";
const isValueBlockerCode = (c: string): boolean => c === ENV_TOKEN_READ_ONLY_CODE || c === ENV_CONSENT_REQUIRED_CODE;
const isAckableCode = (c: string): c is (typeof ACKABLE_ENV_CODES)[number] => (ACKABLE_ENV_CODES as readonly string[]).includes(c);

/** The ackable env codes this item carries. */
export function ackableCodes(item: ImportPlanItem): ImportAck["code"][] {
  return item.risks.filter((r) => r.level === "blocker" && isAckableCode(r.code)).map((r) => r.code as ImportAck["code"]);
}

/** Is the item blocked even after the acknowledgements (a non-ackable blocker, or an ackable one not acknowledged)? */
export function blockedAfterAcks(item: ImportPlanItem, acked: ReadonlySet<string>): boolean {
  return item.risks.some((r) => r.level === "blocker" && !(isAckableCode(r.code) && acked.has(item.itemRef)));
}

/** Apps whose plan carries an ackable env blocker (the rows the operator must acknowledge or fix). */
export function ackableItems(plan: ImportPlan): ImportPlanItem[] {
  return plan.items.filter((it) => it.kind === "app" && ackableCodes(it).length > 0 && !it.risks.some((r) => isValueBlockerCode(r.code)));
}

/** Apps whose token cannot read variable values (non-ackable: fix the token and reconnect). */
export function tokenReadOnlyItems(plan: ImportPlan): ImportPlanItem[] {
  return plan.items.filter((it) => it.kind === "app" && it.risks.some((r) => r.code === ENV_TOKEN_READ_ONLY_CODE));
}

/** Agent-session apps whose variable values are not read because the secret-values consent does not stand (non-ackable: allow it). */
export function consentRequiredItems(plan: ImportPlan): ImportPlanItem[] {
  return plan.items.filter((it) => it.kind === "app" && it.risks.some((r) => r.code === ENV_CONSENT_REQUIRED_CODE));
}

/** Items that will actually be imported after the acknowledgements. */
export function runnableAfterAcks(plan: ImportPlan, acked: ReadonlySet<string>): number {
  return plan.items.filter((it) => !blockedAfterAcks(it, acked)).length;
}

/** The explicit per-item acks to send with apply (never an ack-all: each acknowledged app lists its own codes). */
export function buildAcks(plan: ImportPlan, acked: ReadonlySet<string>): ImportAck[] {
  const out: ImportAck[] = [];
  for (const it of plan.items) {
    if (!acked.has(it.itemRef)) continue;
    for (const code of ackableCodes(it)) out.push({ code, itemRef: it.itemRef });
  }
  return out;
}

// ── streamed volume data (the "Move data" step) ──


const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

/** "1.5 GiB" / "320 MiB" / "12 KiB" / "0 B": binary units, one decimal above 10 only when it adds information. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0 B";
  if (n >= GiB) return `${(n / GiB).toFixed(n >= 10 * GiB ? 0 : 1)} GiB`;
  if (n >= MiB) return `${(n / MiB).toFixed(n >= 10 * MiB ? 0 : 1)} MiB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KiB`;
  return `${Math.round(n)} B`;
}

/** Seconds as "45 s", "12 min", "3 h 05 min"; null/NaN/negative -> null (the caller shows nothing rather than a lie). */
export function formatDuration(sec: number | null | undefined): string | null {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return null;
  if (sec < 90) return `${Math.max(1, Math.round(sec))} s`;
  const min = Math.round(sec / 60);
  if (min < 90) return `${min} min`;
  const h = Math.floor(min / 60);
  return `${h} h ${String(min % 60).padStart(2, "0")} min`;
}

/** Copy progress as 0-100 from the raw bytes; falls back to the part count when the total is unknown (no estimate shown). */
export function volumeProgressPct(v: Pick<VolumeTransferView, "state" | "rawBytesDone" | "rawBytesTotal">): number | null {
  if (v.state === "DONE") return 100;
  if (!v.rawBytesTotal || v.rawBytesTotal <= 0) return null;
  return Math.max(0, Math.min(100, Math.floor((v.rawBytesDone / v.rawBytesTotal) * 100)));
}

/** A transfer the hub still drives (the panel polls fast while any is live). */
export function isTransferLive(state: VolumeTransferView["state"]): boolean {
  return state === "PENDING" || state === "COPYING" || state === "COPIED" || state === "APPLYING";
}

/** 3 s while any volume is non-terminal, 15 s otherwise (the panel stops entirely on unmount). */
export function volumePollMs(volumes: ReadonlyArray<Pick<VolumeTransferView, "state">> | undefined): number {
  return volumes?.some((v) => isTransferLive(v.state)) ? 3000 : 15000;
}

/** UI tone of a transfer state (a color key, never a display string). */
export function transferTone(state: VolumeTransferView["state"]): "ok" | "warn" | "bad" | "busy" | "muted" {
  switch (state) {
    case "DONE":
      return "ok";
    case "FAILED":
    case "ABORTED":
      return "bad";
    case "EXCLUDED":
      return "warn";
    case "NONE":
      return "muted";
    default:
      return "busy";
  }
}

/** The i18n key of a state / phase (literal keys, so static key-usage checks see them). */
export const STATE_KEY: Record<VolumeTransferView["state"], string> = {
  NONE: "import.vx.state.none",
  EXCLUDED: "import.vx.state.excluded",
  PENDING: "import.vx.state.pending",
  COPYING: "import.vx.state.copying",
  COPIED: "import.vx.state.copied",
  APPLYING: "import.vx.state.applying",
  DONE: "import.vx.state.done",
  FAILED: "import.vx.state.failed",
  ABORTED: "import.vx.state.aborted",
};
export const PHASE_KEY: Record<string, string> = {
  verifying: "import.vx.phase.verifying",
  skipping: "import.vx.phase.skipping",
  streaming: "import.vx.phase.streaming",
  applying: "import.vx.phase.applying",
  provisioning: "import.vx.phase.provisioning",
};

/**
 * The i18n key explaining a failure, picked from the hub's literal messages (the same `vx-*` literals the migrator keys on).
 * Unknown text returns null: the UI then shows the hub's own sentence instead of guessing.
 */
export function errorKey(message: string | null | undefined): string | null {
  const m = (message ?? "").toLowerCase();
  if (!m) return null;
  if (m.includes("vx-fingerprint-changed")) return "import.vx.error.fingerprint";
  if (m.includes("vx-diverged")) return "import.vx.error.diverged";
  if (m.includes("another migrator run")) return "import.vx.error.busy";
  if (m.includes("vx-disk-insufficient")) return "import.vx.error.disk";
  if (m.includes("vx-aborted") || m.includes("aborted by the owner")) return "import.vx.error.aborted";
  if (m.includes("source container is running") || m.includes("stop it first")) return "import.vx.error.sourceRunning";
  if (m.includes("device nodes")) return "import.vx.error.specialFiles";
  if (m.includes("token") && m.includes("expire")) return "import.vx.error.tokenExpired";
  return null;
}

/** The i18n key of a gate (its label). */
export const GATE_KEY: Record<VxGate["id"], string> = {
  inventory: "import.vx.gate.inventory",
  credentials: "import.vx.gate.credentials",
  major: "import.vx.gate.major",
  layout: "import.vx.gate.layout",
  image: "import.vx.gate.image",
  state: "import.vx.gate.state",
  quiesced: "import.vx.gate.quiesced",
};

/** A physical copy can start only when EVERY gate passes (unknown counts as not passed: fail closed). */
export function gatesPass(gates: ReadonlyArray<Pick<VxGate, "status">> | null | undefined): boolean {
  return !!gates && gates.length > 0 && gates.every((g) => g.status === "pass");
}

/** The first thing keeping a volume from being copied right now, for the one-line summary (null = ready). */
export function firstBlocker(v: VolumeTransferView): { kind: "gate"; gate: VxGate } | { kind: "disk" } | { kind: "running" } | { kind: "bind" } | { kind: "devices" } | null {
  if (v.gates) {
    const g = v.gates.find((x) => x.status !== "pass");
    if (g) return { kind: "gate", gate: g };
  }
  if (v.diskVerdict && !v.diskVerdict.ok) return { kind: "disk" };
  if (v.inventory?.found) {
    if (v.inventory.specials.devices > 0) return { kind: "devices" };
    if (v.inventory.running) return { kind: "running" };
    if (v.inventory.mountType === "bind") return { kind: "bind" };
  }
  return null;
}

/**
 * Downtime window from the measured link speed: size / speed + a fixed extraction allowance. With no measured speed there is
 * no estimate (null): the UI says "unknown" instead of inventing a number. `low`/`high` bracket the speed by +-30 %.
 */
export function downtimeEstimate(rawBytes: number, mbps: number | null): { low: number; high: number } | null {
  if (!mbps || mbps <= 0 || !Number.isFinite(rawBytes) || rawBytes <= 0) return null;
  const bytesPerSec = (mbps * 1e6) / 8;
  const extract = 15 * 60;
  return { low: Math.round(rawBytes / (bytesPerSec * 1.3)) + extract, high: Math.round(rawBytes / (bytesPerSec * 0.7)) + extract };
}

/** Append the operator's toggles to a streamed-copy command. Flags are appended at the end of the one-liner; the token is never touched. */
export function withVxFlags(cmd: string, o: { stopSource?: boolean; allowBind?: boolean }): string {
  return `${cmd}${o.stopSource ? " --stop-source" : ""}${o.allowBind ? " --allow-bind" : ""}`;
}

/** The three commands with the toggles applied (the dry run keeps --stop-source: it then reports what it WOULD stop). */
export function vxCommandsWithFlags(cmds: VxCommands, o: { stopSource?: boolean; allowBind?: boolean }): VxCommands {
  return { dryRun: withVxFlags(cmds.dryRun, o), run: withVxFlags(cmds.run, o), resume: withVxFlags(cmds.resume, o) };
}

/** The database items of a plan that may use a volume copy (PostgreSQL only). */
export function volumeCopyCandidates(plan: ImportPlan): ImportPlanItem[] {
  if (plan.sourceKind === "caprover") return []; // CapRover offers no volume read, so no physical copy to choose
  return plan.items.filter((it) => it.kind === "database" && it.proposed.engine === "POSTGRES" && !hasBlocker(it));
}

/** `{ itemRef: "volume" }` for each database whose proposed data mode is a volume copy (what the plan/apply requests carry). */
export function selectedDbModes(plan: ImportPlan): Record<string, "volume"> {
  const out: Record<string, "volume"> = {};
  for (const it of plan.items) if (it.kind === "database" && it.proposed.dataMode === "volume") out[it.itemRef] = "volume";
  return out;
}
